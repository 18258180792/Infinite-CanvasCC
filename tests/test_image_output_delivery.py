import base64
import asyncio
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx
import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class StubAsyncClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def request(self, *_args, **_kwargs):
        self.calls += 1
        return self.responses.pop(0)


class ImageOutputDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "assets"
        self.output = self.assets / "output"
        self.media_previews = self.root / "media_previews"
        self.output.mkdir(parents=True)
        self.patches = [
            patch.object(main, "ASSETS_DIR", str(self.assets)),
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.output)),
            patch.object(main, "MEDIA_PREVIEW_DIR", str(self.media_previews)),
            patch.object(main, "LOG", Mock()),
            patch.object(main, "REMOTE_IMAGE_BACKGROUND_TASKS", {}),
            patch.object(main, "REMOTE_IMAGE_BACKGROUND_LIMITER", None),
            patch.object(main, "REMOTE_IMAGE_BACKGROUND_LOOP", None),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    async def test_base64_image_is_saved_without_remote_request(self):
        content = b"local-image-bytes"
        with patch.object(main.httpx, "AsyncClient") as client_factory:
            url = await main.save_ai_image_to_output({
                "type": "b64",
                "value": base64.b64encode(content).decode("ascii"),
                "mime_type": "image/png",
            })

        client_factory.assert_not_called()
        saved_path = self.output / Path(url).name
        self.assertEqual(saved_path.read_bytes(), content)
        self.assertTrue(url.startswith("/assets/output/"))

    async def test_remote_image_retries_transient_gateway_error_then_caches(self):
        source_url = "https://images.example.test/result.png"
        request = httpx.Request("GET", source_url)
        client = StubAsyncClient([
            httpx.Response(502, request=request),
            httpx.Response(
                200,
                headers={"Content-Type": "image/png"},
                content=b"remote-image-bytes",
                request=request,
            ),
        ])

        with patch.object(main.httpx, "AsyncClient", return_value=client):
            url = await main.save_ai_image_to_output({"type": "url", "value": source_url})

        self.assertEqual(client.calls, 2)
        self.assertTrue(url.startswith("/assets/output/"))
        self.assertEqual((self.output / Path(url).name).read_bytes(), b"remote-image-bytes")

    async def test_remote_image_falls_back_to_source_after_cache_attempts_fail(self):
        source_url = "https://images.example.test/result.png"
        request = httpx.Request("GET", source_url)
        client = StubAsyncClient([
            httpx.Response(502, request=request),
            httpx.Response(502, request=request),
        ])

        with (
            patch.object(main.httpx, "AsyncClient", return_value=client),
            patch("builtins.print"),
            patch.object(main, "schedule_remote_generated_image_cache") as schedule,
        ):
            url = await main.save_ai_image_to_output({"type": "url", "value": source_url})

        self.assertEqual(url, source_url)
        self.assertEqual(client.calls, 2)
        self.assertEqual(list(self.output.iterdir()), [])
        schedule.assert_called_once_with(source_url)

    async def test_inline_image_download_retries_gateway_error_and_caches(self):
        source_url = "https://images.example.test/result.png"

        def response(status, content=b""):
            item = requests.Response()
            item.status_code = status
            item.url = source_url
            item._content = content
            item._content_consumed = True
            item.headers["Content-Type"] = "image/png"
            return item

        request = main.Request({"type": "http", "method": "GET", "headers": []})
        with (
            patch.object(main, "output_file_from_url", return_value=None),
            patch.object(main, "local_media_file_by_basename", return_value=None),
            patch.object(main.requests, "get", side_effect=[response(502), response(200, b"image")]) as get,
            patch.object(main.time, "sleep"),
        ):
            result = main.download_output(request, source_url, "result.png", inline=True)
            self.assertEqual(Path(result.path).read_bytes(), b"image")
            cached = main.download_output(request, source_url, "result.png", inline=True)

        self.assertEqual(get.call_count, 2)
        self.assertEqual(Path(cached.path).read_bytes(), b"image")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(get.call_args.kwargs["headers"]["Accept-Encoding"], "identity")

    async def test_inline_image_retries_when_body_read_times_out(self):
        source_url = "https://images.example.test/result.png"

        def response(content=b"image"):
            item = requests.Response()
            item.status_code = 200
            item.url = source_url
            item._content = content
            item._content_consumed = True
            item.headers["Content-Type"] = "image/png"
            return item

        broken = response()
        broken.iter_content = Mock(side_effect=requests.ReadTimeout("upstream body stalled"))
        request = main.Request({"type": "http", "method": "GET", "headers": []})
        with (
            patch.object(main, "output_file_from_url", return_value=None),
            patch.object(main, "local_media_file_by_basename", return_value=None),
            patch.object(main.requests, "get", side_effect=[broken, response()]) as get,
            patch.object(main.time, "sleep"),
        ):
            result = main.download_output(request, source_url, "result.png", inline=True)

        self.assertEqual(get.call_count, 2)
        self.assertEqual(Path(result.path).read_bytes(), b"image")

    async def test_inline_image_retries_header_timeout_with_short_timeout(self):
        source_url = "https://images.example.test/result.png"
        response = requests.Response()
        response.status_code = 200
        response.url = source_url
        response._content = b"image"
        response._content_consumed = True
        response.headers["Content-Type"] = "image/png"
        request = main.Request({"type": "http", "method": "GET", "headers": []})
        with (
            patch.object(main, "output_file_from_url", return_value=None),
            patch.object(main, "local_media_file_by_basename", return_value=None),
            patch.object(main.requests, "get", side_effect=[requests.ReadTimeout("headers stalled"), response]) as get,
            patch.object(main.time, "sleep"),
        ):
            result = main.download_output(request, source_url, "result.png", inline=True)

        self.assertEqual(get.call_count, 2)
        self.assertEqual(get.call_args.kwargs["timeout"], main.REMOTE_INLINE_IMAGE_TIMEOUT)
        self.assertEqual(Path(result.path).read_bytes(), b"image")

    async def test_inline_image_retries_truncated_body_without_caching_it(self):
        source_url = "https://images.example.test/result.png"

        def response(content):
            item = requests.Response()
            item.status_code = 200
            item.url = source_url
            item._content = content
            item._content_consumed = True
            item.headers["Content-Type"] = "image/png"
            item.headers["Content-Length"] = "5"
            return item

        request = main.Request({"type": "http", "method": "GET", "headers": []})
        with (
            patch.object(main, "output_file_from_url", return_value=None),
            patch.object(main, "local_media_file_by_basename", return_value=None),
            patch.object(main.requests, "get", side_effect=[response(b"im"), response(b"image")]) as get,
        ):
            result = main.download_output(request, source_url, "result.png", inline=True)

        self.assertEqual(get.call_count, 2)
        self.assertEqual(Path(result.path).read_bytes(), b"image")
        self.assertEqual(list(Path(result.path).parent.glob("*.tmp")), [])

    async def test_inline_body_budget_stops_trickle_without_retry_or_partial_cache(self):
        source_url = "https://images.example.test/trickle.png"
        clock = [0.0]
        response = Mock(status_code=200, headers={"content-type": "image/png"})

        def chunks(chunk_size):
            self.assertEqual(chunk_size, 16 * 1024)
            clock[0] = 10.0
            yield b"partial"
            clock[0] = 31.0
            yield b"late"
            self.fail("Download continued after its budget expired")

        response.iter_content.side_effect = chunks
        with (
            patch.object(main.time, "monotonic", side_effect=lambda: clock[0]),
            patch.object(main.requests, "get") as get,
        ):
            with self.assertRaises(requests.Timeout):
                main.cache_remote_inline_image(source_url, response, {})

        get.assert_not_called()
        response.close.assert_called_once()
        root, _key, cached = main.remote_image_cache_location(source_url)
        self.assertEqual(cached, "")
        self.assertEqual(list(Path(root).iterdir()), [])

    async def test_inline_body_retry_shares_budget_and_cleans_both_partial_files(self):
        source_url = "https://images.example.test/retry-budget.png"
        clock = [0.0]
        first = Mock(status_code=200, headers={"content-type": "image/png"})
        second = Mock(status_code=200, headers={"content-type": "image/png"})

        def broken_chunks(chunk_size):
            clock[0] = 19.0
            yield b"first partial"
            clock[0] = 21.0
            raise requests.ConnectionError("body disconnected")

        def late_chunks(chunk_size):
            clock[0] = 31.0
            yield b"second partial"

        first.iter_content.side_effect = broken_chunks
        second.iter_content.side_effect = late_chunks
        with (
            patch.object(main.time, "monotonic", side_effect=lambda: clock[0]),
            patch.object(main.requests, "get", return_value=second) as get,
        ):
            with self.assertRaises(requests.Timeout):
                main.cache_remote_inline_image(source_url, first, {})

        get.assert_called_once()
        self.assertEqual(get.call_args.kwargs["timeout"], (5, 9.0))
        first.close.assert_called_once()
        second.close.assert_called_once()
        root, _key, cached = main.remote_image_cache_location(source_url)
        self.assertEqual(cached, "")
        self.assertEqual(list(Path(root).iterdir()), [])

    async def test_zero_byte_remote_cache_is_not_reused(self):
        source_url = "https://images.example.test/result.png"
        root, key, _cached = main.remote_image_cache_location(source_url)
        Path(root).mkdir(parents=True)
        (Path(root) / f"{key}.png").write_bytes(b"")

        self.assertEqual(main.remote_image_cache_location(source_url)[2], "")

    async def test_background_cache_saves_verified_image_and_cleans_task_reference(self):
        source_url = "https://images.example.test/background.png"
        buffer = io.BytesIO()
        Image.new("RGB", (2, 2), "red").save(buffer, format="PNG")
        content = buffer.getvalue()
        response = requests.Response()
        response.status_code = 200
        response.url = source_url
        response._content = content
        response._content_consumed = True
        response.headers["Content-Type"] = "image/png"
        with patch.object(main.requests, "get", return_value=response) as get:
            task = main.schedule_remote_generated_image_cache(source_url)
            duplicate = main.schedule_remote_generated_image_cache(source_url)
            self.assertIs(task, duplicate)
            await task
            await asyncio.sleep(0)

        self.assertNotIn(source_url, main.REMOTE_IMAGE_BACKGROUND_TASKS)
        get.assert_called_once()
        self.assertEqual(get.call_args.kwargs["headers"]["Accept-Encoding"], "identity")
        cached_path = main.remote_image_cache_location(source_url)[2]
        self.assertEqual(Path(cached_path).read_bytes(), content)
        main.LOG.info.assert_called_once()

    async def test_background_cache_rejects_invalid_image_and_cleans_task_reference(self):
        source_url = "https://images.example.test/invalid.png"

        def response():
            item = requests.Response()
            item.status_code = 200
            item.url = source_url
            item._content = b"not an image"
            item._content_consumed = True
            item.headers["Content-Type"] = "image/png"
            return item

        with patch.object(main.requests, "get", side_effect=[response(), response()]):
            task = main.schedule_remote_generated_image_cache(source_url)
            await task
            await asyncio.sleep(0)

        self.assertNotIn(source_url, main.REMOTE_IMAGE_BACKGROUND_TASKS)
        root, _key, cached_path = main.remote_image_cache_location(source_url)
        self.assertEqual(cached_path, "")
        self.assertEqual(list(Path(root).glob("*.tmp")), [])
        main.LOG.warning.assert_called()

    async def test_background_cache_limits_concurrent_thread_downloads(self):
        release = asyncio.Event()
        active = 0
        peak = 0

        async def download(_worker, _url):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await release.wait()
            active -= 1
            return "cached.png"

        with patch.object(main.asyncio, "to_thread", new=AsyncMock(side_effect=download)) as to_thread:
            tasks = [main.schedule_remote_generated_image_cache(f"https://images.example.test/{index}.png") for index in range(6)]
            await asyncio.sleep(0.01)
            self.assertEqual(to_thread.call_count, 3)
            release.set()
            await asyncio.gather(*tasks)
            await asyncio.sleep(0)

        self.assertEqual(peak, 3)
        self.assertEqual(main.REMOTE_IMAGE_BACKGROUND_TASKS, {})

    async def test_background_cache_queue_full_leaves_proxy_fallback_available(self):
        with (
            patch.object(main, "REMOTE_IMAGE_BACKGROUND_MAX_PENDING", 2),
            patch.object(main.asyncio, "to_thread", new=AsyncMock(return_value="cached.png")),
        ):
            tasks = [main.schedule_remote_generated_image_cache(f"https://images.example.test/{index}.png") for index in range(2)]
            skipped = main.schedule_remote_generated_image_cache("https://images.example.test/skipped.png")
            self.assertIsNone(skipped)
            self.assertEqual(len(main.REMOTE_IMAGE_BACKGROUND_TASKS), 2)
            await asyncio.gather(*tasks)
            await asyncio.sleep(0)

        main.LOG.warning.assert_called_once()
        self.assertIn("reason=queue_full", main.LOG.warning.call_args.args[0])
        self.assertEqual(main.REMOTE_IMAGE_BACKGROUND_TASKS, {})

    async def test_background_failure_log_does_not_include_signed_url(self):
        source_url = "https://images.example.test/result.png?signature=private-token"
        with patch.object(main, "persist_remote_generated_image", side_effect=requests.ReadTimeout(source_url)):
            await main.schedule_remote_generated_image_cache(source_url)
            await asyncio.sleep(0)

        self.assertNotIn("private-token", str(main.LOG.warning.call_args))
        self.assertIn("ReadTimeout", str(main.LOG.warning.call_args))

    async def test_background_cache_reuses_verified_file_without_network_request(self):
        source_url = "https://images.example.test/cached.png"
        root, key, _cached = main.remote_image_cache_location(source_url)
        Path(root).mkdir(parents=True)
        cached = Path(root) / f"{key}.png"
        Image.new("RGB", (2, 2), "red").save(cached, format="PNG")
        with patch.object(main.requests, "get") as get:
            await main.schedule_remote_generated_image_cache(source_url)
            await asyncio.sleep(0)

        get.assert_not_called()
        self.assertEqual(main.remote_image_cache_location(source_url)[2], str(cached))


if __name__ == "__main__":
    unittest.main()

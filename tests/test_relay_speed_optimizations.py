import base64
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

REAL_ASYNC_CLIENT = httpx.AsyncClient


class RelaySpeedOptimizationsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.assets = self.root / "assets"
        self.output = self.assets / "output"
        self.input_dir = self.assets / "input"
        self.previews = self.root / "media_previews"
        self.canvases = self.root / "canvases"
        self.history_file = self.root / "history.json"
        for d in (self.output, self.input_dir, self.previews, self.canvases):
            d.mkdir(parents=True, exist_ok=True)
        self.patches = [
            patch.object(main, "ASSETS_DIR", str(self.assets)),
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.output)),
            patch.object(main, "OUTPUT_INPUT_DIR", str(self.input_dir)),
            patch.object(main, "MEDIA_PREVIEW_DIR", str(self.previews)),
            patch.object(main, "CANVAS_DIR", str(self.canvases)),
            patch.object(main, "DATA_DIR", str(self.root)),
            patch.object(main, "HISTORY_FILE", str(self.history_file)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def test_opaque_rgba_png_is_compressed_to_compact_jpeg_while_alpha_png_stays_png(self):
        # Create noisy opaque RGBA image (alpha=255 everywhere)
        opaque_path = self.input_dir / "opaque_rgba.png"
        noise = os.urandom(400 * 400 * 3)
        rgb = Image.frombytes("RGB", (400, 400), noise)
        rgba_opaque = rgb.convert("RGBA")
        rgba_opaque.save(opaque_path, format="PNG")

        data_url = main.reference_to_data_url({"url": "/assets/input/opaque_rgba.png"}, max_size=1024)
        self.assertTrue(data_url.startswith("data:image/jpeg;base64,"))
        self.assertLess(len(data_url), os.path.getsize(opaque_path))

        # Create truly transparent RGBA image (alpha=0 corner)
        trans_path = self.input_dir / "trans_rgba.png"
        rgba_trans = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
        rgba_trans.putpixel((0, 0), (0, 0, 0, 0))
        rgba_trans.save(trans_path, format="PNG")
        trans_url = main.reference_to_data_url({"url": "/assets/input/trans_rgba.png"}, max_size=1024)
        self.assertTrue(trans_url.startswith("data:image/png;base64,"))

    async def test_soonstudio_seedream_v55_uses_json_contract_and_4k_support(self):
        provider = {
            "id": "soonstudio",
            "name": "SoonStudio",
            "base_url": "https://api-hk.soonstudio.ai/v1",
            "protocol": "openai",
            "image_request_mode": "openai",
        }
        requests_seen = []

        def handler(req: httpx.Request) -> httpx.Response:
            requests_seen.append(req)
            return httpx.Response(200, json={"data": [{"url": "https://cdn.example.test/out.jpg"}]})

        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(main, "provider_env_key_value", return_value="sk-test"),
            patch.object(main.httpx, "AsyncClient", side_effect=lambda **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kw)),
        ):
            img, _ = await main.generate_ai_image(
                "product shot", "2048x2048", "auto", "seedream-v5.5",
                [{"url": "https://cdn.example.test/ref.jpg", "kind": "image"}],
                "soonstudio", resolution="4k",
            )
        self.assertEqual(img["value"], "https://cdn.example.test/out.jpg")
        self.assertEqual(len(requests_seen), 1)
        self.assertEqual(requests_seen[0].url.path, "/v1/images/edits")
        body = json.loads(requests_seen[0].content)
        self.assertEqual(body["model"], "seedream-v5.5")
        self.assertEqual(body["resolution"], "4k")
        self.assertEqual(body["imageUrls"], ["https://cdn.example.test/ref.jpg"])

    def test_media_reference_to_url_uses_local_remote_cache_for_soonstudio_links(self):
        remote_url = "https://soonstudio.ai/api/media/v1_signed_token_abc"
        cache_root, cache_key, _ = main.remote_image_cache_location(remote_url)
        Path(cache_root).mkdir(parents=True, exist_ok=True)
        cached_file = Path(cache_root) / f"{cache_key}.jpg"
        Image.new("RGB", (120, 80), (10, 20, 30)).save(cached_file, format="JPEG")

        resolved = main.media_reference_to_url(remote_url, max_image_size=512)
        self.assertTrue(resolved.startswith("data:image/jpeg;base64,"))

    async def test_pure_chat_skips_blocking_router_llm_roundtrip(self):
        provider = {
            "id": "custom-api",
            "name": "Custom",
            "protocol": "openai",
            "base_url": "https://chat.example.test/v1",
            "chat_models": ["gpt-6.1-sol"],
        }
        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(main, "resolve_chat_provider", return_value=("https://chat.example.test/v1", {}, "gpt-6.1-sol")),
            patch.object(main.httpx, "AsyncClient") as client_mock,
        ):
            payload = main.ChatRequest(
                message="你好，帮我润色一段电商详情页卖点文案",
                model="gpt-6.1-sol",
                provider="custom-api",
                mode="agent",
            )
            decision = await main.decide_chat_agent_action(payload, {"messages": []}, [])
        self.assertEqual(decision["action"], "chat")
        client_mock.assert_not_called()

    def test_history_slimming_strips_giant_base64_and_preserves_metadata(self):
        huge_b64 = "data:image/png;base64," + ("A" * 120000)
        bloated = [{
            "prompt": "cat",
            "images": ["/assets/output/cat.png"],
            "timestamp": 1000.0,
            "type": "online",
            "params": {
                "model": "seedream-v5-pro",
                "reference_images": [{"url": huge_b64, "name": "ref.png", "kind": "image"}],
            },
            "raw": {"huge": "x" * 50000},
        }]
        # Write >2MB file so slim_existing_history_file triggers rewrite & backup
        bloated_many = bloated * 20
        self.history_file.write_text(json.dumps(bloated_many, indent=4), encoding="utf-8")
        before_sz = self.history_file.stat().st_size
        self.assertGreater(before_sz, 2 * 1024 * 1024)

        before, after = main.slim_existing_history_file()
        self.assertEqual(before, before_sz)
        self.assertLess(after, 20 * 1024)
        saved = json.loads(self.history_file.read_text(encoding="utf-8"))
        self.assertEqual(len(saved), 20)
        ref_u = saved[0]["params"]["reference_images"][0]["url"]
        self.assertTrue(ref_u.startswith("[inline-base64-omitted:image/png:"))
        self.assertNotIn("raw", saved[0])

    def test_migrate_cached_remote_canvas_urls_localizes_cached_nodes(self):
        remote_url = "https://soonstudio.ai/api/media/v1_canvas_node_token"
        cache_root, cache_key, _ = main.remote_image_cache_location(remote_url)
        Path(cache_root).mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (64, 48), (100, 120, 140)).save(Path(cache_root) / f"{cache_key}.jpg", format="JPEG")

        cv_path = self.canvases / "cv1.json"
        cv_path.write_text(json.dumps({
            "id": "cv1",
            "nodes": [{"id": "n1", "images": [{"url": remote_url, "name": "out.jpg"}]}],
        }), encoding="utf-8")

        count = main.migrate_cached_remote_canvas_urls()
        self.assertEqual(count, 1)
        updated = json.loads(cv_path.read_text(encoding="utf-8"))
        img = updated["nodes"][0]["images"][0]
        self.assertTrue(img["url"].startswith("/assets/output/canvas_remote_"))
        self.assertEqual(img["natural_w"], 64)
        self.assertEqual(img["natural_h"], 48)

    async def test_canvas_llm_stream_emits_deltas_and_done(self):
        provider = {
            "id": "custom-api",
            "name": "Custom",
            "protocol": "openai",
            "base_url": "https://chat.example.test/v1",
            "chat_models": ["gpt-6.1-sol"],
        }
        sse_wire = (
            b'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'
            b'data: {"choices":[{"delta":{"content":"World"}}]}\n\n'
            b"data: [DONE]\n\n"
        )

        class ByteChunks(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield sse_wire

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=ByteChunks())

        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(main, "resolve_chat_provider", return_value=("https://chat.example.test/v1", {}, "gpt-6.1-sol")),
            patch.object(main.httpx, "AsyncClient", side_effect=lambda **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kw)),
        ):
            resp = await main.canvas_llm_stream(main.CanvasLLMRequest(
                message="Hi",
                provider="custom-api",
                model="gpt-6.1-sol",
            ))
            events = []
            async for chunk in resp.body_iterator:
                txt = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
                for line in txt.splitlines():
                    if line.startswith("data:"):
                        events.append(json.loads(line[5:].strip()))
        self.assertEqual([e["delta"] for e in events if e["type"] == "delta"], ["Hello ", "World"])
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["text"], "Hello World")


if __name__ == "__main__":
    unittest.main()

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

REAL_ASYNC_CLIENT = httpx.AsyncClient
PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc```\x00\x00"
    b"\x00\x04\x00\x01\xf6\x178U\x00\x00\x00\x00IEND\xaeB`\x82"
)


class ProxyPoolAndTaskRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await main.close_shared_http_clients()

    async def asyncTearDown(self):
        await main.close_shared_http_clients()

    async def test_shared_client_rebuilds_on_proxy_toggle_and_retires_safely(self):
        proxies = {"https": "http://127.0.0.1:7897"}
        built = []

        def fake_build(default_timeout, limits, trust_env, follow_redirects):
            client = REAL_ASYNC_CLIENT(transport=httpx.MockTransport(lambda req: httpx.Response(200)), trust_env=False)
            built.append((client, trust_env, main._current_proxy_signature(trust_env)))
            return client

        with (
            patch.object(main.urllib.request, "getproxies", side_effect=lambda: dict(proxies)),
            patch.object(main, "_build_shared_async_client", side_effect=fake_build),
        ):
            async with main.shared_async_http_client(trust_env=True) as old_client:
                raw_old = old_client._client
                self.assertEqual(old_client._proxy_sig, (("https", "http://127.0.0.1:7897"),))
                # Turn off proxy while old_client is still in flight.
                proxies.clear()
                async with main.shared_async_http_client(trust_env=True) as new_client:
                    raw_new = new_client._client
                    self.assertIsNot(raw_old, raw_new)
                    self.assertEqual(new_client._proxy_sig, ())
                    self.assertFalse(raw_old.is_closed, "in-flight client must not be closed mid-request")
                self.assertFalse(raw_old.is_closed)
            # Once the in-flight context exits, the retired client is closed cleanly.
            self.assertTrue(raw_old.is_closed)
            self.assertFalse(raw_new.is_closed)

    def test_missing_socksio_falls_back_cleanly(self):
        calls = []

        def fake_ctor(**kwargs):
            calls.append(kwargs)
            if kwargs.get("trust_env"):
                raise ImportError("Using SOCKS proxy, but the 'socksio' package is not installed.")
            return REAL_ASYNC_CLIENT(transport=httpx.MockTransport(lambda req: httpx.Response(200)), trust_env=False)

        timeout = httpx.Timeout(10.0)
        limits = httpx.Limits(max_connections=10)
        with (
            patch.object(main, "_ORIGINAL_HTTPX_ASYNC_CLIENT", side_effect=fake_ctor),
            patch.object(
                main.urllib.request,
                "getproxies",
                return_value={"all": "socks5://127.0.0.1:7897", "https": "127.0.0.1:7897"},
            ),
            patch.object(main, "LOG", Mock()),
        ):
            main._build_shared_async_client(timeout, limits, True, False)
            self.assertEqual(calls[-1].get("proxy"), "http://127.0.0.1:7897")
            self.assertFalse(calls[-1].get("trust_env"))

        calls.clear()
        with (
            patch.object(main, "_ORIGINAL_HTTPX_ASYNC_CLIENT", side_effect=fake_ctor),
            patch.object(main.urllib.request, "getproxies", return_value={"all": "socks5://127.0.0.1:7897"}),
            patch.object(main, "LOG", Mock()),
        ):
            main._build_shared_async_client(timeout, limits, True, False)
            self.assertNotIn("proxy", calls[-1])
            self.assertFalse(calls[-1].get("trust_env"))

    async def test_post_with_safe_proxy_fallback_only_retries_local_proxy_connect_errors(self):
        proxies = {"https": "http://127.0.0.1:7897"}
        provider = {"id": "soonstudio", "base_url": "https://api.soonstudio.ai/v1"}
        seen = []

        def build_for_mode(default_timeout, limits, trust_env, follow_redirects):
            def handler(req: httpx.Request):
                seen.append(trust_env)
                if trust_env:
                    raise httpx.ProxyError("local proxy down", request=req)
                return httpx.Response(200, json={"ok": True})

            return REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), trust_env=False)

        with (
            patch.object(main.urllib.request, "getproxies", side_effect=lambda: dict(proxies)),
            patch.object(main, "_build_shared_async_client", side_effect=build_for_mode),
            patch.object(main, "LOG", Mock()),
        ):
            async with main.shared_async_http_client(trust_env=True) as client:
                resp = await main.post_with_safe_proxy_fallback(
                    client, "https://api.soonstudio.ai/v1/images/generations", provider=provider, json={"a": 1}
                )
        self.assertEqual(resp.json(), {"ok": True})
        self.assertEqual(seen, [True, False])

        # Mid-flight ReadError or ReadTimeout must NEVER retry POST.
        for exc_cls in (httpx.ReadError, httpx.ReadTimeout):
            seen.clear()
            await main.close_shared_http_clients()

            def build_midflight_error(default_timeout, limits, trust_env, follow_redirects):
                def handler(req: httpx.Request):
                    seen.append(trust_env)
                    raise exc_cls("lost mid-flight", request=req)

                return REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), trust_env=False)

            with (
                patch.object(main.urllib.request, "getproxies", side_effect=lambda: dict(proxies)),
                patch.object(main, "_build_shared_async_client", side_effect=build_midflight_error),
                patch.object(main, "LOG", Mock()),
            ):
                async with main.shared_async_http_client(trust_env=True) as client:
                    with self.assertRaises(exc_cls):
                        await main.post_with_safe_proxy_fallback(
                            client, "https://api.soonstudio.ai/v1/images/generations", provider=provider, json={"a": 1}
                        )
            self.assertEqual(seen, [True])

    async def test_soonstudio_and_grsai_bind_upstream_task_id_immediately_and_preserve_on_poll_drop(self):
        cases = [
            {
                "name": "soonstudio",
                "provider": {
                    "id": "soonstudio",
                    "name": "SoonStudio",
                    "base_url": "https://api.soonstudio.ai/v1",
                    "protocol": "openai",
                    "image_request_mode": "openai",
                    "image_models": ["Dola-Seedream-5.0-Flash"],
                },
                "model": "Dola-Seedream-5.0-Flash",
                "submit_reply": {"task_id": "soon-task-999", "status": "IN_PROGRESS"},
                "expected_id": "soon-task-999",
            },
            {
                "name": "grsai-apimart",
                "provider": {
                    "id": "grsai",
                    "name": "Grsai API",
                    "base_url": "https://grsai.dakka.com.cn",
                    "protocol": "apimart",
                    "image_request_mode": "openai",
                    "image_models": ["nano-banana-2"],
                },
                "model": "nano-banana-2",
                "submit_reply": {"code": 200, "data": [{"task_id": "grsai-apimart-888"}]},
                "expected_id": "grsai-apimart-888",
            },
            {
                "name": "grsai-native",
                "provider": {
                    "id": "grsai",
                    "name": "Grsai Native",
                    "base_url": "https://grsaiapi.com",
                    "protocol": "openai",
                    "image_request_mode": "grsai",
                    "image_models": ["nano-banana-2"],
                },
                "model": "nano-banana-2",
                "submit_reply": {"id": "grsai-native-777", "status": "running"},
                "expected_id": "grsai-native-777",
            },
        ]

        for case in cases:
            with self.subTest(case=case["name"]):
                await main.close_shared_http_clients()
                local_task_id = f"local_{case['name']}"
                task_store = {
                    local_task_id: {
                        "id": local_task_id,
                        "status": "queued",
                        "stage": "queued",
                        "upstream_task_id": "",
                    }
                }
                observed_during_poll = []

                def handler(req: httpx.Request):
                    if req.method == "POST":
                        return httpx.Response(200, json=case["submit_reply"])
                    observed_during_poll.append((
                        task_store[local_task_id].get("upstream_task_id"),
                        task_store[local_task_id].get("stage"),
                    ))
                    raise httpx.RemoteProtocolError("proxy closed during poll", request=req)

                transport = httpx.MockTransport(handler)
                payload = main.OnlineImageRequest(
                    prompt="test prompt",
                    provider_id=case["provider"]["id"],
                    model=case["model"],
                )
                with (
                    patch.object(main, "get_api_provider", return_value=case["provider"]),
                    patch.object(main, "provider_env_key_value", return_value="sk-test"),
                    patch.object(main, "CANVAS_TASKS", task_store),
                    patch.object(main, "IMAGE_TASK_POLL_MAX_CONSECUTIVE_ERRORS", 0),
                    patch.object(main.asyncio, "sleep", new=AsyncMock()),
                    patch.object(main, "_notify_canvas_task_ws", new=AsyncMock()),
                    patch.object(main, "LOG", Mock()),
                    patch.object(
                        main,
                        "_build_shared_async_client",
                        side_effect=lambda *a, **kw: REAL_ASYNC_CLIENT(transport=transport, trust_env=False),
                    ),
                ):
                    await main.run_canvas_image_task(local_task_id, payload)

                self.assertGreaterEqual(len(observed_during_poll), 1)
                self.assertEqual(observed_during_poll[0], (case["expected_id"], "polling"))
                self.assertEqual(task_store[local_task_id]["status"], "failed")
                self.assertEqual(task_store[local_task_id]["upstream_task_id"], case["expected_id"])

    async def test_wait_for_image_task_recovers_from_transient_remote_protocol_errors_in_live_mode(self):
        provider = {
            "id": "soonstudio",
            "base_url": "https://api.soonstudio.ai/v1",
            "protocol": "openai",
        }
        attempts = 0

        def handler(req: httpx.Request):
            nonlocal attempts
            attempts += 1
            if attempts <= 2:
                raise httpx.RemoteProtocolError("proxy restarted mid-poll", request=req)
            return httpx.Response(200, json={"status": "SUCCESS", "data": {"url": "https://cdn.example.test/ok.png"}})

        transport = httpx.MockTransport(handler)
        with (
            patch.object(main, "provider_env_key_value", return_value="sk-test"),
            patch.object(main.urllib.request, "getproxies", return_value={}),
            patch.object(main.asyncio, "sleep", new=AsyncMock()),
            patch.object(main, "LOG", Mock()),
            patch.object(
                main,
                "_build_shared_async_client",
                side_effect=lambda *a, **kw: REAL_ASYNC_CLIENT(transport=transport, trust_env=False),
            ),
        ):
            async with main.shared_async_http_client(trust_env=True) as client:
                result = await main.wait_for_image_task(client, "task-recover-1", provider=provider)
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(attempts, 3)

    async def test_save_ai_image_to_output_falls_back_to_direct_on_remote_protocol_error(self):
        source_url = "https://cdn.example.test/generated.png"
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            assets = root / "assets"
            output = assets / "output"
            previews = root / "previews"
            output.mkdir(parents=True)

            def build_client(default_timeout, limits, trust_env, follow_redirects):
                def handler(req: httpx.Request):
                    if trust_env:
                        raise httpx.RemoteProtocolError("proxy cut connection", request=req)
                    return httpx.Response(
                        200,
                        headers={"Content-Type": "image/png"},
                        content=PNG_BYTES,
                        request=req,
                    )

                return REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), trust_env=False)

            with (
                patch.object(main, "ASSETS_DIR", str(assets)),
                patch.object(main, "OUTPUT_OUTPUT_DIR", str(output)),
                patch.object(main, "MEDIA_PREVIEW_DIR", str(previews)),
                patch.object(main.urllib.request, "getproxies", return_value={"https": "http://127.0.0.1:7897"}),
                patch.object(main, "LOG", Mock()),
                patch.object(main, "_build_shared_async_client", side_effect=build_client),
            ):
                saved = await main.save_ai_image_to_output({"type": "url", "value": source_url}, name_stem="proj_ok")

            self.assertTrue(saved.startswith("/assets/output/proj_ok.png"))
            self.assertEqual((output / "proj_ok.png").read_bytes(), PNG_BYTES)

    async def test_image_task_query_supports_grsai_native_modelscope_and_metadata(self):
        grsai_provider = {
            "id": "grsai",
            "name": "Grsai",
            "base_url": "https://grsaiapi.com",
            "protocol": "openai",
            "image_request_mode": "grsai",
        }
        seen_grsai = []

        def grsai_handler(req: httpx.Request):
            seen_grsai.append(req)
            return httpx.Response(
                200,
                json={"status": "succeeded", "results": [{"url": "https://cdn.example.test/grsai.png"}]},
            )

        with (
            patch.object(main, "get_api_provider", return_value=grsai_provider),
            patch.object(main, "provider_env_key_value", return_value="sk-grsai"),
            patch.object(main.urllib.request, "getproxies", return_value={}),
            patch.object(main, "generated_image_project_name", return_value="MyProj"),
            patch.object(main, "save_ai_image_to_output", new=AsyncMock(return_value="/assets/output/MyProj_sunset.png")),
            patch.object(main, "image_output_meta", return_value={"url": "/assets/output/MyProj_sunset.png", "kind": "image"}),
            patch.object(main, "save_to_history", new=Mock()),
            patch.object(main, "GLOBAL_LOOP", None),
            patch.object(
                main,
                "_build_shared_async_client",
                side_effect=lambda *a, **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(grsai_handler), trust_env=False),
            ),
        ):
            res = await main.query_image_task(
                main.ImageTaskQueryRequest(
                    provider_id="grsai",
                    task_id="grsai-t1",
                    model="nano-banana-2",
                    prompt="sunset cat",
                    canvas_id="cv-1",
                )
            )
        self.assertEqual(res["status"], "succeeded")
        self.assertEqual(res["prompt"], "sunset cat")
        self.assertEqual(res["model"], "nano-banana-2")
        self.assertEqual(res["project_name"], "MyProj")
        self.assertEqual(seen_grsai[0].url.path, "/v1/api/result")
        self.assertEqual(seen_grsai[0].url.params.get("id"), "grsai-t1")

        await main.close_shared_http_clients()
        ms_provider = {"id": "modelscope", "name": "ModelScope", "base_url": "https://api-inference.modelscope.cn/v1"}
        seen_ms = []

        def ms_handler(req: httpx.Request):
            seen_ms.append(req)
            return httpx.Response(200, json={"task_status": "SUCCEED", "output_images": ["https://cdn.example.test/ms.png"]})

        with (
            patch.object(main, "get_api_provider", return_value=ms_provider),
            patch.object(main, "modelscope_api_key", return_value="ms-token"),
            patch.object(main.urllib.request, "getproxies", return_value={}),
            patch.object(main, "save_ai_image_to_output", new=AsyncMock(return_value="/assets/output/ms.png")),
            patch.object(main, "image_output_meta", return_value={"url": "/assets/output/ms.png", "kind": "image"}),
            patch.object(main, "save_to_history", new=Mock()),
            patch.object(main, "GLOBAL_LOOP", None),
            patch.object(
                main,
                "_build_shared_async_client",
                side_effect=lambda *a, **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(ms_handler), trust_env=False),
            ),
        ):
            ms_res = await main.query_image_task(main.ImageTaskQueryRequest(provider_id="modelscope", task_id="ms-t1"))
        self.assertEqual(ms_res["status"], "succeeded")
        self.assertEqual(seen_ms[0].url.path, "/v1/tasks/ms-t1")
        self.assertEqual(seen_ms[0].headers.get("x-modelscope-task-type"), "image_generation")


if __name__ == "__main__":
    unittest.main()

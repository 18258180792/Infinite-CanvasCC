import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


REAL_ASYNC_CLIENT = httpx.AsyncClient
IMAGE_URL = "https://soonstudio.ai/api/media/signed-image-token"


class SoonStudioProviderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.provider = main.normalize_provider({
            "id": "custom-api-3",
            "name": "SOON",
            "base_url": "https://api-hk.soonstudio.ai/v1",
            "protocol": "apimart",
            "image_models": ["Dola-Seedream-5.0-Flash"],
            "model_groups": {"Dola-Seedream-5.0-Flash": "sd-global"},
        })
        self.requests = []

    async def test_async_submission_and_successful_poll(self):
        self.assertEqual(self.provider["protocol"], "openai")

        def handler(request):
            self.requests.append(request)
            if request.method == "POST":
                return httpx.Response(200, json={"task_id": "task-123", "status": "IN_PROGRESS"})
            return httpx.Response(200, json={
                "task_id": "task-123",
                "status": "SUCCESS",
                "data": {"url": IMAGE_URL, "urls": [IMAGE_URL]},
            })

        transport = httpx.MockTransport(handler)
        client_options = []
        def client_factory(**kwargs):
            client_options.append(kwargs)
            return REAL_ASYNC_CLIENT(transport=transport, **kwargs)

        with patch.object(main, "get_api_provider", return_value=self.provider), \
             patch.object(main, "provider_env_key_value", return_value="test-key"), \
             patch.object(main.httpx, "AsyncClient", side_effect=client_factory):
            image, raw = await main.generate_ai_image(
                "a cat", "1024x1024", "", "Dola-Seedream-5.0-Flash", provider_id="custom-api-3"
            )

        self.assertEqual(image, {"type": "url", "value": IMAGE_URL})
        self.assertEqual(raw["status"], "SUCCESS")
        self.assertEqual(len(self.requests), 2)
        self.assertFalse(client_options[0]["trust_env"])
        self.assertEqual(self.requests[0].url.path, "/v1/images/generations")
        self.assertEqual(self.requests[0].url.params["async"], "true")
        self.assertEqual(self.requests[1].url.path, "/v1/images/tasks/task-123")
        self.assertEqual([r.headers.get("x-studio-channel-group") for r in self.requests], ["sd-global", "sd-global"])

    def test_group_validation_and_exact_host_detection(self):
        self.assertEqual(main.normalize_model_groups({"model": "sd-global", "other": "bad value"}), {"model": "sd-global"})
        self.assertFalse(main.is_soonstudio_provider({"base_url": "https://api.soonstudio.ai.evil.test/v1"}))
        self.assertFalse(main.looks_like_generated_image_url("https://example.test/api/media/token"))

    async def test_image_edit_uses_direct_connection(self):
        client_options = []
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={"data": [{"url": "https://example.test/result.png"}]})

        transport = httpx.MockTransport(handler)

        def client_factory(**kwargs):
            client_options.append(kwargs)
            return REAL_ASYNC_CLIENT(transport=transport, **kwargs)

        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "input.png"
            image_path.write_bytes(b"test-image")
            with patch.object(main, "get_api_provider", return_value=self.provider), \
                 patch.object(main, "provider_env_key_value", return_value="test-key"), \
                 patch.object(main, "output_file_from_url", return_value=str(image_path)), \
                 patch.object(main.httpx, "AsyncClient", side_effect=client_factory):
                image, _ = await main.generate_ai_image(
                    "edit", "1024x1024", "", "gpt-image-2",
                    reference_images=[{"url": "/output/input.png"}], provider_id="custom-api-3",
                )

        self.assertEqual(image["value"], "https://example.test/result.png")
        self.assertFalse(client_options[0]["trust_env"])
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.path, "/v1/images/edits")
        self.assertEqual(requests[0].url.params["async"], "true")

    async def test_failed_edit_is_not_resubmitted(self):
        requests = []

        def handler(request):
            requests.append(request)
            raise httpx.ConnectError("connection lost")

        transport = httpx.MockTransport(handler)
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "input.png"
            image_path.write_bytes(b"test-image")
            with patch.object(main, "get_api_provider", return_value=self.provider), \
                 patch.object(main, "provider_env_key_value", return_value="test-key"), \
                 patch.object(main, "output_file_from_url", return_value=str(image_path)), \
                 patch.object(main.httpx, "AsyncClient", side_effect=lambda **kwargs: REAL_ASYNC_CLIENT(transport=transport, **kwargs)):
                with self.assertRaises(HTTPException) as raised:
                    await main.generate_ai_image(
                        "edit", "1024x1024", "", "Dola-Seedream-5.0-Flash",
                        reference_images=[{"url": "/output/input.png"}], provider_id="custom-api-3",
                    )

        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(len(requests), 1)


if __name__ == "__main__":
    unittest.main()

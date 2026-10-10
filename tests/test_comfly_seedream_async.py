import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


REAL_ASYNC_CLIENT = httpx.AsyncClient
TASK_ID = "3dad96708a77485e97ac7ef652796d7b"
IMAGE_URL = "https://cdn.example.test/result.png"


class ComflySeedreamAsyncTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.provider = {
            "id": "custom-comfly", "name": "Comfly",
            "base_url": "https://ai.comfly.org/v1",
            "protocol": "openai", "image_request_mode": "openai",
        }
        self.requests = []

    def client_factory(self, replies):
        remaining = list(replies)

        def handler(request):
            self.requests.append(request)
            self.assertTrue(remaining, "Unexpected request; all requests must stay mocked")
            reply = remaining.pop(0)
            if isinstance(reply, Exception):
                raise reply
            if isinstance(reply, tuple):
                return httpx.Response(reply[0], json=reply[1])
            return httpx.Response(200, json=reply)

        transport = httpx.MockTransport(handler)
        return lambda **kwargs: REAL_ASYNC_CLIENT(transport=transport, **kwargs)

    async def generate(self, replies, *, provider=None, model="seedream-v5-pro", refs=None):
        with patch.object(main, "get_api_provider", return_value=provider or self.provider), \
             patch.object(main, "provider_env_key_value", return_value="test-key"), \
             patch.object(main.httpx, "AsyncClient", side_effect=self.client_factory(replies)), \
             patch.object(main.asyncio, "sleep", new=AsyncMock()), \
             patch.object(main, "LOG", Mock()):
            return await main.generate_ai_image("test prompt", "2048x2048", "high", model, refs, "custom-comfly")

    def success(self):
        return {"code": "success", "data": {"task_id": TASK_ID, "status": "SUCCESS", "data": {"data": [{"url": IMAGE_URL}]}}}

    def assert_submission(self):
        submission = self.requests[0]
        self.assertEqual(submission.method, "POST")
        self.assertEqual(submission.url.path, "/v1/images/generations")
        self.assertEqual(submission.url.params.get("async"), "true")
        body = json.loads(submission.content)
        self.assertEqual(body["model"], "seedream-v5-pro")
        self.assertEqual(body["size"], "2048x2048")
        self.assertEqual(body["response_format"], "url")
        self.assertNotIn("quality", body)
        self.assertNotIn("n", body)
        return body

    async def test_scalar_submission_polls_until_nested_image_success(self):
        result, raw = await self.generate([
            {"code": "success", "data": TASK_ID},
            {"code": "success", "data": {"status": "IN_PROGRESS"}},
            self.success(),
        ])
        self.assert_submission()
        self.assertEqual(result["value"], IMAGE_URL)
        self.assertEqual(raw, self.success())
        self.assertEqual([request.method for request in self.requests], ["POST", "GET", "GET"])
        for request in self.requests[1:]:
            self.assertEqual(request.url.path, "/v1/images/tasks/" + TASK_ID)
            self.assertEqual(request.headers["Authorization"], "Bearer test-key")

    async def test_top_level_and_nested_task_ids(self):
        for submission in [{"task_id": TASK_ID}, {"data": {"task_id": TASK_ID}}]:
            with self.subTest(submission=submission):
                self.requests = []
                result, _ = await self.generate([submission, self.success()])
                self.assertEqual(result["value"], IMAGE_URL)
                self.assertEqual(len(self.requests), 2)

    async def test_references_use_top_level_json_without_resizing_or_edits(self):
        refs = [{"url": "/assets/input/reference.png", "role": "source"}]
        with patch.object(main, "reference_to_data_url", return_value="data:image/png;base64,AAAA") as convert:
            await self.generate([{"task_id": TASK_ID}, self.success()], refs=refs)
        body = self.assert_submission()
        self.assertEqual(body["image"], ["data:image/png;base64,AAAA"])
        convert.assert_called_once_with(refs[0])
        self.assertFalse(any(request.url.path.endswith("/edits") for request in self.requests))

    async def test_failed_task_preserves_upstream_task_id(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate([{"task_id": TASK_ID}, {"data": {"status": "FAILURE", "fail_reason": "rejected"}}])
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(caught.exception.upstream_task_id, TASK_ID)
        self.assertIn("rejected", caught.exception.detail)
        self.assertEqual([request.method for request in self.requests], ["POST", "GET"])

    async def test_success_without_image_is_not_resubmitted(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate([{"task_id": TASK_ID}, {"data": {"status": "SUCCESS", "data": {}}}])
        self.assertEqual(caught.exception.upstream_task_id, TASK_ID)
        self.assertEqual([request.method for request in self.requests], ["POST", "GET"])

    async def test_poll_business_error_preserves_task_id_and_stops(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate([
                {"task_id": TASK_ID},
                {"code": "error", "message": "task access denied", "data": {"status": "IN_PROGRESS"}},
            ])
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(caught.exception.upstream_task_id, TASK_ID)
        self.assertIn("task access denied", caught.exception.detail)
        self.assertEqual([request.method for request in self.requests], ["POST", "GET"])

    async def test_submission_502_is_not_resubmitted(self):
        with self.assertRaises(httpx.HTTPStatusError):
            await self.generate([(502, {"error": "gateway unavailable"})])
        self.assertEqual(len(self.requests), 1)

    async def test_transient_poll_failure_retries_only_get(self):
        result, _ = await self.generate([
            {"task_id": TASK_ID},
            (503, {"error": "temporarily unavailable"}),
            self.success(),
        ])
        self.assertEqual(result["value"], IMAGE_URL)
        self.assertEqual([request.method for request in self.requests], ["POST", "GET", "GET"])

    async def test_poll_read_error_preserves_task_id_without_resubmission(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate([
                {"task_id": TASK_ID},
                httpx.ReadError("poll failed"),
                httpx.ReadError("poll failed"),
                httpx.ReadError("poll failed"),
            ])
        self.assertEqual(caught.exception.upstream_task_id, TASK_ID)
        self.assertEqual([request.method for request in self.requests], ["POST", "GET", "GET", "GET"])

    async def test_submission_read_error_is_not_resubmitted(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate([httpx.ReadError("lost submission response")])
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(len(self.requests), 1)

    async def test_mask_is_rejected_before_network_request(self):
        with self.assertRaises(main.HTTPException) as caught:
            await self.generate([], refs=[{"url": "/assets/input/mask.png", "role": "mask"}])
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self.requests, [])

    async def test_missing_or_invalid_task_id_does_not_poll(self):
        for submission in [{}, {"code": "success", "data": "../../escape"}, {"task_id": "https://bad.test/task"}]:
            with self.subTest(submission=submission):
                self.requests = []
                with self.assertRaises(main.HTTPException) as caught:
                    await self.generate([submission])
                self.assertEqual(caught.exception.status_code, 502)
                self.assertEqual(len(self.requests), 1)

    async def test_other_supplier_and_other_model_remain_synchronous(self):
        configurations = [
            ({**self.provider, "base_url": "https://other.example.test/v1"}, "seedream-v5-pro"),
            (self.provider, "seedream-v4"),
        ]
        for provider, model in configurations:
            with self.subTest(provider=provider, model=model):
                self.requests = []
                result, _ = await self.generate([{"data": [{"url": IMAGE_URL}]}], provider=provider, model=model)
                self.assertEqual(result["value"], IMAGE_URL)
                self.assertEqual(len(self.requests), 1)
                self.assertNotIn("async", self.requests[0].url.params)

    def test_scope_requires_exact_host_protocol_mode_and_endpoint(self):
        self.assertTrue(main.is_comfly_seedream_async_provider(self.provider, "seedream-v5-pro"))
        self.assertTrue(main.is_comfly_seedream_async_provider({**self.provider, "image_request_mode": "openai-json"}, "seedream-v5-pro"))
        nonmatching = [
            {"base_url": "https://ai.comfly.org.evil.test/v1"},
            {"base_url": "https://sub.ai.comfly.org/v1"},
            {"protocol": "gemini"},
            {"image_request_mode": "grsai"},
            {"image_generation_endpoint": "https://other.example.test/v1/images/generations"},
            {"image_generation_endpoint": "http://ai.comfly.org/v1/images/generations"},
            {"image_generation_endpoint": "https://ai.comfly.org:8443/v1/images/generations"},
            {"image_generation_endpoint": "https://ai.comfly.org/v1/images/generations?custom=true"},
            {"image_generation_endpoint": "https://ai.comfly.org/v1/images/generations#fragment"},
            {"image_generation_endpoint": "/v1/custom/images"},
        ]
        for changes in nonmatching:
            with self.subTest(changes=changes):
                self.assertFalse(main.is_comfly_seedream_async_provider({**self.provider, **changes}, "seedream-v5-pro"))
        self.assertFalse(main.is_comfly_seedream_async_provider(self.provider, "seedream-v4"))

    def test_scalar_id_support_does_not_modify_generic_parser(self):
        payload = {"code": "success", "data": TASK_ID}
        self.assertEqual(main.extract_comfly_image_task_id(payload), TASK_ID)
        self.assertFalse(main.extract_task_id(payload))
        self.assertFalse(main.extract_comfly_image_task_id({"code": "failure", "data": TASK_ID}))
        self.assertFalse(main.extract_comfly_image_task_id({"code": "success", "data": 12345678}))


if __name__ == "__main__":
    unittest.main()

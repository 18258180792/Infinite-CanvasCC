import copy
import json
import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

REAL_ASYNC_CLIENT = httpx.AsyncClient


class IncrementalBody(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.sent = 0

    async def __aiter__(self):
        for chunk in self.chunks:
            self.sent += 1
            yield chunk


class ChatStreamTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.provider = {
            "id": "test",
            "name": "Test",
            "protocol": "openai",
            "base_url": "https://chat.example.test/v1",
            "chat_models": ["gpt-5.5"],
            "image_models": ["image-test"],
        }
        self.saved = []
        self.requests = []
        self.request = Request({
            "type": "http",
            "method": "POST",
            "path": "/api/chat/stream",
            "query_string": b"",
            "headers": [],
            "scheme": "http",
            "server": ("localhost", 3000),
            "client": ("127.0.0.1", 12345),
        })
        self.stack.enter_context(patch.object(main, "safe_user_id", return_value="test-user"))
        self.stack.enter_context(patch.object(
            main,
            "new_conversation",
            side_effect=lambda user, title: {
                "id": "conversation-test", "title": title, "messages": []
            },
        ))
        self.stack.enter_context(patch.object(
            main,
            "save_conversation",
            side_effect=lambda user, value: self.saved.append(copy.deepcopy(value)),
        ))
        self.stack.enter_context(patch.object(
            main, "get_api_provider", return_value=self.provider
        ))
        self.stack.enter_context(patch.object(
            main,
            "resolve_chat_provider",
            side_effect=lambda provider, model, ms_model: (
                "https://chat.example.test/v1", {}, model or "gpt-5.5"
            ),
        ))
        self.stack.enter_context(patch.object(
            main, "pick_chat_image_provider", return_value=self.provider
        ))
        self.stack.enter_context(patch.object(
            main, "chat_system_prompt", return_value="Test assistant."
        ))
        self.stack.enter_context(patch.object(
            main, "friendly_chat_error_detail", return_value=""
        ))

    def payload(self, **overrides):
        return main.ChatRequest(**{
            "message": "Write a short caption.",
            "model": "gpt-5.5",
            "provider": "test",
            "mode": "chat",
            **overrides,
        })

    def upstream(self, response):
        def handler(request):
            self.requests.append(json.loads(request.content))
            return response

        return patch.object(
            main.httpx,
            "AsyncClient",
            side_effect=lambda **kwargs: REAL_ASYNC_CLIENT(
                transport=httpx.MockTransport(handler), **kwargs
            ),
        )

    def sse_response(self, chunks):
        body = IncrementalBody([
            ("data: " + (
                item if isinstance(item, str) else json.dumps(item)
            ) + "\n\n").encode()
            for item in chunks
        ])
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=body
        ), body

    async def event(self, response):
        chunk = await response.body_iterator.__anext__()
        if isinstance(chunk, bytes):
            chunk = chunk.decode()
        data = next(line[5:].strip() for line in chunk.splitlines()
                    if line.startswith("data:"))
        return json.loads(data)

    async def events(self, response):
        result = []
        async for chunk in response.body_iterator:
            if isinstance(chunk, bytes):
                chunk = chunk.decode()
            for frame in chunk.split("\n\n"):
                for line in frame.splitlines():
                    if line.startswith("data:"):
                        result.append(json.loads(line[5:].strip()))
        return result

    async def test_agent_plan_and_each_image_arrive_before_next_generation(self):
        decision = {"action": "generate_image", "prompt": "Two poster options",
                    "reply": "Preparing the posters."}
        generate = AsyncMock(return_value=({"url": "/fake-image"}, {}))
        save_image = AsyncMock(side_effect=["/output/first.png", "/output/second.png"])
        with patch.object(main, "decide_chat_agent_action",
                          AsyncMock(return_value=decision)), \
             patch.object(main, "generate_ai_image", generate), \
             patch.object(main, "save_ai_image_to_output", save_image):
            response = await main.chat_stream(
                self.payload(mode="agent", message="Generate 2\u5f20 posters."),
                self.request, "test-user",
            )
            seen = []
            while not seen or seen[-1]["type"] != "plan":
                seen.append(await self.event(response))
            self.assertEqual(seen[0]["type"], "meta")
            self.assertTrue(any(item["type"] == "status" for item in seen))
            self.assertEqual(seen[-1]["prompt"], decision["prompt"])
            self.assertEqual(seen[-1]["reply"], decision["reply"])
            generate.assert_not_awaited()
            while seen[-1]["type"] != "image":
                seen.append(await self.event(response))
            self.assertEqual(seen[-1]["url"], "/output/first.png")
            self.assertEqual(seen[-1]["index"], 1)
            self.assertEqual(seen[-1]["total"], 2)
            self.assertEqual(generate.await_count, 1)
            seen.extend(await self.events(response))

        self.assertEqual(
            [item["url"] for item in seen if item["type"] == "image"],
            ["/output/first.png", "/output/second.png"],
        )
        done = seen[-1]
        self.assertEqual(done["type"], "done")
        self.assertEqual(done["message"]["image_count"], 2)
        self.assertEqual([item["role"] for item in done["conversation"]["messages"]],
                         ["user", "assistant"])
        self.assertEqual([len(value["messages"]) for value in self.saved], [1, 2])
        self.assertIn("no-cache", response.headers["cache-control"])
        self.assertEqual(response.headers["x-accel-buffering"], "no")

    async def test_agent_chat_forwards_text_and_reasoning_incrementally(self):
        upstream, body = self.sse_response([
            {"choices": [{"delta": {"reasoning_content": "check "}}]},
            {"choices": [{"delta": {"content": "first "}}]},
            {"choices": [{"delta": {"reasoning": "details"}}]},
            {"choices": [{"delta": {"content": "second"}}]},
            {"choices": [], "usage": {"total_tokens": 10}},
            "[DONE]",
        ])
        with patch.object(main, "decide_chat_agent_action", AsyncMock(return_value={
            "action": "chat", "prompt": "caption", "reply": ""
        })), self.upstream(upstream):
            response = await main.chat_stream(
                self.payload(mode="agent"), self.request, "test-user"
            )
            seen = []
            while not seen or seen[-1]["type"] != "delta":
                seen.append(await self.event(response))
            self.assertEqual(seen[-1]["delta"], "first ")
            self.assertLess(body.sent, len(body.chunks))
            seen.extend(await self.events(response))

        self.assertEqual([item["delta"] for item in seen if item["type"] == "delta"],
                         ["first ", "second"])
        self.assertEqual("".join(
            item["delta"] for item in seen if item["type"] == "reasoning"
        ), "check details")
        self.assertEqual(seen[-1]["message"]["content"], "first second")
        self.assertEqual(seen[-1]["message"]["reasoning"], "check details")
        self.assertEqual(seen[-1]["message"]["raw_usage"], {"total_tokens": 10})
        self.assertEqual([len(value["messages"]) for value in self.saved], [1, 2])
        self.assertEqual(len(self.requests), 1)

    async def test_non_streaming_json_response_remains_usable(self):
        for wrapped in (False, True):
            with self.subTest(wrapped=wrapped):
                raw = {
                    "choices": [{"message": {
                        "content": "Complete caption.",
                        "reasoning_content": "Brief provider summary.",
                    }}],
                    "usage": {"total_tokens": 6},
                }
                if wrapped:
                    raw = {"code": 200, "data": raw}
                with self.upstream(httpx.Response(200, json=raw)):
                    response = await main.chat_stream(
                        self.payload(), self.request, "test-user"
                    )
                    events = await self.events(response)
                self.assertEqual(events[-1]["type"], "done")
                self.assertEqual(events[-1]["message"]["content"], "Complete caption.")
                self.assertEqual(events[-1]["message"]["raw_usage"], {"total_tokens": 6})
                self.assertEqual(events[-1]["message"]["reasoning"],
                                 "Brief provider summary.")

    async def test_upstream_errors_and_empty_results_are_not_successes(self):
        responses = [
            httpx.Response(502, json={"error": {"message": "Unavailable"}}),
            httpx.Response(200, json={"error": {"message": "Rejected"}}),
            httpx.Response(200, json={}),
            self.sse_response([{"error": {"message": "Stream failed"}}, "[DONE]"])[0],
            self.sse_response(["[DONE]"])[0],
        ]
        for upstream in responses:
            with self.subTest(status=upstream.status_code,
                              content_type=upstream.headers.get("content-type")):
                with self.upstream(upstream):
                    response = await main.chat_stream(
                        self.payload(), self.request, "test-user"
                    )
                    events = await self.events(response)
                self.assertTrue(any(item["type"] == "error" for item in events))
                self.assertFalse(any(item["type"] == "done" for item in events))
                self.assertEqual(self.saved[-1]["messages"][-1]["role"], "user")

    async def test_partial_text_is_sent_before_a_stream_error(self):
        upstream, _ = self.sse_response([
            {"choices": [{"delta": {"content": "Partial caption"}}]},
            {"error": {"message": "Connection failed"}},
            "[DONE]",
        ])
        with self.upstream(upstream):
            response = await main.chat_stream(
                self.payload(), self.request, "test-user"
            )
            events = await self.events(response)
        self.assertEqual([item["delta"] for item in events if item["type"] == "delta"],
                         ["Partial caption"])
        self.assertEqual(events[-1]["type"], "error")
        self.assertFalse(any(item["type"] == "done" for item in events))

    async def test_stream_eof_requires_a_completion_marker(self):
        for finish_reason in (None, "stop"):
            with self.subTest(finish_reason=finish_reason):
                chunks = [{"choices": [{"delta": {"content": "Caption text"}}]}]
                if finish_reason:
                    chunks.append({"choices": [{
                        "delta": {}, "finish_reason": finish_reason
                    }]})
                upstream, _ = self.sse_response(chunks)
                self.saved.clear()
                with self.upstream(upstream):
                    response = await main.chat_stream(
                        self.payload(), self.request, "test-user"
                    )
                    events = await self.events(response)
                self.assertEqual(
                    [item["delta"] for item in events if item["type"] == "delta"],
                    ["Caption text"],
                )
                if finish_reason:
                    self.assertEqual(events[-1]["type"], "done")
                    self.assertEqual(self.saved[-1]["messages"][-1]["role"],
                                     "assistant")
                else:
                    self.assertEqual(events[-1]["type"], "error")
                    self.assertFalse(any(item["type"] == "done" for item in events))
                    self.assertEqual(self.saved[-1]["messages"][-1]["role"], "user")

    async def test_fragmented_utf8_events_are_reassembled(self):
        caption = "\u7b2c\u4e00\u53e5\u6587\u6848\u3002"
        wire = (
            "data: " + json.dumps(
                {"choices": [{"delta": {"content": caption}}]}, ensure_ascii=False
            ) + "\r\n\r\ndata: [DONE]\r\n\r\n"
        ).encode("utf-8")
        body = IncrementalBody([wire[index:index + 5]
                                for index in range(0, len(wire), 5)])
        upstream = httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=body
        )
        with self.upstream(upstream):
            response = await main.chat_stream(
                self.payload(), self.request, "test-user"
            )
            events = await self.events(response)
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["message"]["content"], caption)

    async def test_image_failure_is_reported_without_a_second_submission(self):
        generate = AsyncMock(side_effect=main.HTTPException(
            status_code=502, detail="Image service failed"
        ))
        with patch.object(main, "decide_chat_agent_action", AsyncMock(return_value={
            "action": "generate_image", "prompt": "A poster", "reply": ""
        })), patch.object(main, "generate_ai_image", generate):
            response = await main.chat_stream(
                self.payload(mode="agent"), self.request, "test-user"
            )
            events = await self.events(response)
        generate.assert_awaited_once()
        self.assertTrue(any(item["type"] == "plan" for item in events))
        self.assertEqual(events[-1]["type"], "error")
        self.assertFalse(any(item["type"] == "done" for item in events))

    async def test_partial_image_results_survive_stream_and_json_failures(self):
        for endpoint in ("stream", "json"):
            with self.subTest(endpoint=endpoint):
                self.saved.clear()
                generate = AsyncMock(side_effect=[
                    ({"url": "/fake-image"}, {}),
                    main.HTTPException(status_code=502, detail="Second image failed"),
                ])
                with patch.object(main, "decide_chat_agent_action",
                                  AsyncMock(return_value={
                                      "action": "generate_image",
                                      "prompt": "Two poster options",
                                      "reply": "Preparing two posters.",
                                  })), \
                     patch.object(main, "generate_ai_image", generate), \
                     patch.object(main, "save_ai_image_to_output",
                                  AsyncMock(return_value="/output/first.png")):
                    payload = self.payload(
                        mode="agent", message="Generate 2\u5f20 posters."
                    )
                    if endpoint == "stream":
                        response = await main.chat_stream(
                            payload, self.request, "test-user"
                        )
                        events = await self.events(response)
                        self.assertEqual(events[-1]["type"], "error")
                        self.assertIn("Second image failed", events[-1]["detail"])
                        self.assertFalse(any(item["type"] == "done"
                                             for item in events))
                        partial = [item for item in events
                                   if item["type"] == "partial"]
                        self.assertEqual(len(partial), 1)
                        self.assertEqual(partial[0]["conversation"],
                                         self.saved[-1])
                        self.assertTrue(partial[0]["message"]["incomplete"])
                        self.assertEqual(partial[0]["message"]["image_urls"],
                                         ["/output/first.png"])
                    else:
                        with self.assertRaises(main.HTTPException) as caught:
                            await main.chat_agent(
                                payload, self.request, "test-user"
                            )
                        self.assertEqual(caught.exception.status_code, 502)
                        self.assertIn("Second image failed",
                                      caught.exception.detail)
                self.assertEqual(generate.await_count, 2)
                self.assertEqual(
                    [item["role"] for item in self.saved[-1]["messages"]],
                    ["user", "assistant"],
                )
                message = self.saved[-1]["messages"][-1]
                self.assertTrue(message["incomplete"])
                self.assertEqual(message["image_urls"], ["/output/first.png"])
                self.assertIn("Second image failed", message["generation_error"])
                self.assertEqual([len(value["messages"]) for value in self.saved],
                                 [1, 2])

    async def test_original_agent_json_endpoint_still_saves_one_reply(self):
        with patch.object(main, "decide_chat_agent_action", AsyncMock(return_value={
            "action": "generate_image", "prompt": "A poster", "reply": "Ready"
        })), patch.object(main, "generate_ai_image", AsyncMock(return_value=(
            {"url": "/fake-image"}, {}
        ))), patch.object(main, "save_ai_image_to_output", AsyncMock(return_value=(
            "/output/poster.png"
        ))):
            result = await main.chat_agent(
                self.payload(mode="agent"), self.request, "test-user"
            )
        self.assertEqual(result["message"]["image_url"], "/output/poster.png")
        self.assertEqual(result["agent"]["action"], "generate_image")
        self.assertEqual([item["role"] for item in result["conversation"]["messages"]],
                         ["user", "assistant"])
        self.assertEqual([len(value["messages"]) for value in self.saved], [1, 2])

    async def test_reasoning_effort_is_only_sent_for_selected_supported_models(self):
        for model, effort, expected in (
            ("gpt-5.5", "", None),
            ("gpt-5.5", "high", "high"),
            ("gpt-6-sol", "high", "high"),
            ("gpt-6.1-sol", "medium", "medium"),
            ("gpt-6.1-terra", "low", "low"),
            ("o3", "medium", "medium"),
            ("gpt-4o-mini", "high", None),
            ("qwen-chat", "high", None),
        ):
            with self.subTest(model=model, effort=effort):
                upstream, _ = self.sse_response([
                    {"choices": [{"delta": {"content": "caption"}}]},
                    "[DONE]",
                ])
                with self.upstream(upstream):
                    response = await main.chat_stream(
                        self.payload(model=model, reasoning_effort=effort),
                        self.request, "test-user",
                    )
                    events = await self.events(response)
                self.assertEqual(events[-1]["type"], "done")
                self.assertEqual(self.requests[-1].get("reasoning_effort"), expected)
                if expected is None:
                    self.assertNotIn("reasoning_effort", self.requests[-1])

    async def test_agent_router_receives_selected_reasoning_effort(self):
        upstream = httpx.Response(200, json={"choices": [{"message": {
            "content": json.dumps({
                "action": "generate_image", "prompt": "A poster", "reply": ""
            })
        }}]})
        with self.upstream(upstream):
            decision = await main.decide_chat_agent_action(
                self.payload(reasoning_effort="high"),
                {"messages": []}, [],
            )
        self.assertEqual(decision["action"], "generate_image")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0]["reasoning_effort"], "high")

    async def test_selected_reasoning_router_errors_do_not_start_image_generation(self):
        for network_error in (False, True):
            with self.subTest(network_error=network_error):
                def handler(request):
                    self.requests.append(json.loads(request.content))
                    if network_error:
                        raise httpx.ConnectError("Router offline", request=request)
                    return httpx.Response(400, json={
                        "error": {"message": "Unsupported reasoning effort"}
                    })

                generate = AsyncMock()
                with patch.object(
                    main.httpx,
                    "AsyncClient",
                    side_effect=lambda **kwargs: REAL_ASYNC_CLIENT(
                        transport=httpx.MockTransport(handler), **kwargs
                    ),
                ), patch.object(main, "generate_ai_image", generate), \
                     patch.object(main, "log_net_error"):
                    response = await main.chat_stream(
                        self.payload(mode="agent", message="Generate an image.",
                                     reasoning_effort="high"),
                        self.request, "test-user",
                    )
                    events = await self.events(response)
                generate.assert_not_awaited()
                self.assertEqual(events[-1]["type"], "error")
                detail = "Router offline" if network_error else "Unsupported reasoning effort"
                self.assertIn(detail, events[-1]["detail"])
                self.assertFalse(any(item["type"] in {"plan", "done"} for item in events))
                self.assertEqual(self.requests[-1]["reasoning_effort"], "high")

    async def test_default_reasoning_router_errors_preserve_existing_fallback(self):
        with self.upstream(httpx.Response(503, json={
            "error": {"message": "Router unavailable"}
        })):
            decision = await main.decide_chat_agent_action(
                self.payload(message="Generate an image."),
                {"messages": []}, [],
            )
        self.assertEqual(decision["action"], "generate_image")
        self.assertNotIn("reasoning_effort", self.requests[-1])

    async def test_router_http_200_error_respects_selected_reasoning(self):
        raw = {"error": {"message": "Unsupported reasoning effort"}}
        generate = AsyncMock()
        with self.upstream(httpx.Response(200, json=raw)), \
             patch.object(main, "generate_ai_image", generate):
            response = await main.chat_stream(
                self.payload(mode="agent", message="Generate an image.",
                             reasoning_effort="high"),
                self.request, "test-user",
            )
            events = await self.events(response)
        generate.assert_not_awaited()
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("Unsupported reasoning effort", events[-1]["detail"])
        self.assertFalse(any(item["type"] in {"plan", "done"} for item in events))
        self.assertEqual(self.saved[-1]["messages"][-1]["role"], "user")

        with self.upstream(httpx.Response(200, json=raw)):
            decision = await main.decide_chat_agent_action(
                self.payload(message="Generate an image."),
                {"messages": []}, [],
            )
        self.assertEqual(decision["action"], "generate_image")

    def test_request_rejects_unknown_modes_and_reasoning_levels(self):
        for values in ({"mode": "unknown"}, {"reasoning_effort": "maximum"}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.payload(**values)


if __name__ == "__main__":
    unittest.main()

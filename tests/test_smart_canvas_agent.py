import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

REAL_ASYNC_CLIENT = httpx.AsyncClient


class IncrementalBody(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk


class SmartCanvasAgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.canvases_dir = Path(self.tmp.name) / "canvases"
        self.canvases_dir.mkdir(parents=True, exist_ok=True)
        self.stack.enter_context(patch.object(main, "CANVAS_DIR", str(self.canvases_dir)))

    def test_default_canvas_creation_is_smart_only(self):
        req = main.CanvasCreateRequest()
        self.assertEqual(req.kind, "smart")
        created = main.new_canvas()
        self.assertEqual(created["kind"], "smart")
        self.assertEqual(created["viewport"]["scale"], 0.45)

        idx = main.canvas_assets_index()
        cat_ids = [c["id"] for c in idx["categories"]]
        self.assertIn("smart", cat_ids)
        self.assertNotIn("classic", cat_ids)

    def test_tag_stream_filter_holds_partial_tags_and_hides_plan(self):
        flt = main._AgentTagStreamFilter()
        chunks = [
            "分析完成：",
            "保留图1构图，替换图2包装<ag",
            "ent_plan>{\"action\":\"create_generation_node\"}</agent_plan>",
        ]
        emitted = []
        entered = False
        for c in chunks:
            out, in_plan = flt.push(c)
            if out:
                emitted.append(out)
            if in_plan:
                entered = True
        tail = flt.flush()
        if tail:
            emitted.append(tail)
        self.assertTrue(entered)
        self.assertEqual("".join(emitted), "分析完成：保留图1构图，替换图2包装")

    def test_parse_agent_plan_structured_and_fallback(self):
        payload = main.SmartCanvasAgentRequest(
            message="图1为主构图，把产品替换成图2的，背景改成浅蓝色",
            system_prompt="你是图像编辑专家",
            canvas_nodes=[
                main.SmartCanvasAgentNodeInput(id="smart_n1", index=1, title="主图", selected=True),
                main.SmartCanvasAgentNodeInput(id="smart_n2", index=2, title="产品图", selected=True),
                main.SmartCanvasAgentNodeInput(id="smart_n3", index=3, title="无关节点", selected=False),
            ],
        )
        raw = (
            "已根据系统提示词完成多图融合分析。\n"
            "<agent_plan>\n"
            "{\n"
            '  "action": "create_generation_node",\n'
            '  "reply": "连接主图与产品图新建浅蓝背景生图节点",\n'
            '  "tasks": [{\n'
            '    "title": "浅蓝猫砂海报",\n'
            '    "source_node_ids": ["smart_n1", "smart_n2", "non_existent"],\n'
            '    "prompt": "```text\\n以图1为编辑基准，替换为图2产品，浅蓝色背景。\\n```",\n'
            '    "aspect_ratio": "3:4"\n'
            "  }]\n"
            "}\n"
            "</agent_plan>"
        )
        visible, plan = main.parse_smart_canvas_agent_plan(raw, payload)
        self.assertEqual(visible, "已根据系统提示词完成多图融合分析。")
        self.assertEqual(plan["action"], "create_generation_node")
        self.assertEqual(len(plan["tasks"]), 1)
        task = plan["tasks"][0]
        self.assertEqual(task["source_node_ids"], ["smart_n1", "smart_n2"])
        self.assertEqual(task["prompt"], "以图1为编辑基准，替换为图2产品，浅蓝色背景。")
        self.assertEqual(task["aspect_ratio"], "3:4")

        # Fallback test when LLM outputs 【最终可用提示词】 code block without <agent_plan>
        fallback_raw = (
            "【任务判定】多图融合\n\n"
            "【最终可用提示词】\n"
            "```text\n以图1为底图，融合图2的包装外观。\n```"
        )
        visible2, plan2 = main.parse_smart_canvas_agent_plan(fallback_raw, payload)
        self.assertIn("【最终可用提示词】", visible2)
        self.assertEqual(plan2["action"], "create_generation_node")
        self.assertEqual(plan2["tasks"][0]["source_node_ids"], ["smart_n1", "smart_n2"])
        self.assertEqual(plan2["tasks"][0]["prompt"], "以图1为底图，融合图2的包装外观。")

        # Reverse-only instruction should stay chat when no <agent_plan>
        no_gen_payload = main.SmartCanvasAgentRequest(
            message="仅反推提示词不要生图",
            canvas_nodes=[main.SmartCanvasAgentNodeInput(id="smart_n1", index=1, selected=True)],
        )
        _, plan3 = main.parse_smart_canvas_agent_plan(fallback_raw, no_gen_payload)
        self.assertEqual(plan3["action"], "chat")

    async def test_upstream_origin_context_in_user_message(self):
        payload = main.SmartCanvasAgentRequest(
            message="把 @[图1：猫砂海报 (node_id=smart_gen_1)] 顶部的文字改清晰",
            canvas_nodes=[
                main.SmartCanvasAgentNodeInput(
                    id="smart_gen_1",
                    index=1,
                    title="猫砂海报",
                    mentioned=True,
                    is_generated=True,
                ),
                main.SmartCanvasAgentNodeInput(
                    id="smart_orig_pkg",
                    index=2,
                    title="SKU原包装图",
                    is_upstream_origin=True,
                    origin_for_id="smart_gen_1",
                ),
            ],
        )
        _, text_msg = await main.build_smart_canvas_agent_user_message(payload)
        self.assertIn("用户在输入句中直接引用", text_msg)
        self.assertIn("衍生出节点 smart_gen_1 的上游原始参考源节点", text_msg)

    async def test_smart_canvas_agent_stream_sse_end_to_end(self):
        provider = {
            "id": "test",
            "name": "Test",
            "protocol": "openai",
            "base_url": "https://chat.example.test/v1",
            "chat_models": ["gpt-5.5"],
        }
        sse_chunks = [
            'data: {"choices":[{"delta":{"content":"正在规划节点"}}]}\n\n'.encode("utf-8"),
            'data: {"choices":[{"delta":{"content":"<agent_plan>{\\"action\\":\\"create_generation_node\\",\\"reply\\":\\"ok\\",\\"tasks\\":[{\\"title\\":\\"海报\\",\\"source_node_ids\\":[\\"smart_a\\"],\\"prompt\\":\\"以图1生成电影感海报\\",\\"aspect_ratio\\":\\"16:9\\"}]}</agent_plan>"}}]}\n\n'.encode("utf-8"),
            b"data: [DONE]\n\n",
        ]

        def handler(req: httpx.Request) -> httpx.Response:
            body = json.loads(req.content.decode("utf-8"))
            self.assertIn("GPT专家系统提示词", body["messages"][0]["content"])
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                stream=IncrementalBody(sse_chunks),
            )

        transport = httpx.MockTransport(handler)
        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(
                main,
                "resolve_chat_provider",
                return_value=("https://chat.example.test/v1", {}, "gpt-5.5"),
            ),
            patch.object(
                main.httpx,
                "AsyncClient",
                side_effect=lambda **kw: REAL_ASYNC_CLIENT(transport=transport, timeout=kw.get("timeout")),
            ),
        ):
            payload = main.SmartCanvasAgentRequest(
                canvas_id="cv_1",
                message="把这张图做成电影感宽屏海报",
                system_prompt="GPT专家系统提示词",
                provider="test",
                model="gpt-5.5",
                canvas_nodes=[
                    main.SmartCanvasAgentNodeInput(id="smart_a", index=1, title="原图", selected=True),
                ],
            )
            resp = await main.smart_canvas_agent_stream(payload)
            events = []
            async for chunk in resp.body_iterator:
                text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
                for line in text.splitlines():
                    if line.startswith("data:"):
                        events.append(json.loads(line[5:].strip()))

        deltas = "".join(e.get("delta", "") for e in events if e.get("type") == "delta")
        self.assertEqual(deltas, "正在规划节点")
        done_evts = [e for e in events if e.get("type") == "done"]
        self.assertEqual(len(done_evts), 1)
        self.assertEqual(done_evts[0]["plan"]["action"], "create_generation_node")
        self.assertEqual(done_evts[0]["plan"]["tasks"][0]["source_node_ids"], ["smart_a"])
        self.assertEqual(done_evts[0]["plan"]["tasks"][0]["aspect_ratio"], "16:9")


if __name__ == "__main__":
    unittest.main()

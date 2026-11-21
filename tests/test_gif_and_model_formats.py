import base64
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

REAL_ASYNC_CLIENT = httpx.AsyncClient


def make_animated_gif_bytes(frame_colors=((255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (255, 0, 255))):
    frames = [Image.new("RGB", (24, 24), color) for color in frame_colors]
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], duration=80, loop=0)
    return buf.getvalue()


def make_bmp_bytes(color=(30, 140, 220)):
    img = Image.new("RGB", (20, 20), color)
    buf = io.BytesIO()
    img.save(buf, format="BMP")
    return buf.getvalue()


class GifAndModelFormatsTests(unittest.IsolatedAsyncioTestCase):
    def test_gif_and_bmp_are_transcoded_for_openai_multipart_edits(self):
        gif_bytes = make_animated_gif_bytes()
        self.assertLess(len(gif_bytes), 600 * 1024)
        fname, out_bytes, out_mime = main.compact_multipart_image_bytes("anim.gif", gif_bytes, "image/gif")
        self.assertIn(out_mime, {"image/jpeg", "image/png"})
        self.assertTrue(fname.endswith((".jpg", ".png")))
        with Image.open(io.BytesIO(out_bytes)) as decoded:
            self.assertIn(decoded.format, {"JPEG", "PNG"})

        bmp_data_url = "data:image/bmp;base64," + base64.b64encode(make_bmp_bytes()).decode("ascii")
        inline_name, inline_bytes, inline_mime = main.inline_image_edit_file({"url": bmp_data_url, "name": "sample.bmp"})
        self.assertEqual(inline_mime, "image/jpeg")
        self.assertTrue(inline_name.endswith(".jpg"))
        with Image.open(io.BytesIO(inline_bytes)) as decoded_bmp:
            self.assertEqual(decoded_bmp.format, "JPEG")

    def test_animated_gif_expands_to_static_keyframes_in_vision_messages(self):
        gif_bytes = make_animated_gif_bytes()
        gif_data_url = "data:image/gif;base64," + base64.b64encode(gif_bytes).decode("ascii")
        frames = main.animated_image_to_frame_data_urls({"url": gif_data_url, "name": "motion.gif"}, max_frames=4, max_size=512)
        self.assertEqual(len(frames), 4)
        for frame_url in frames:
            self.assertTrue(frame_url.startswith(("data:image/jpeg;base64,", "data:image/png;base64,")))

        record = {
            "role": "user",
            "content": "分析这个动图的动作变化",
            "attachments": [{"url": gif_data_url, "name": "motion.gif", "kind": "image", "mime": "image/gif"}],
        }
        msg = main.upstream_message_from_record(record, include_images=True)
        self.assertIsInstance(msg["content"], list)
        self.assertIn("已按时序抽取 4 帧静态关键帧", msg["content"][0]["text"])
        image_parts = [p for p in msg["content"] if p.get("type") == "image_url"]
        self.assertEqual(len(image_parts), 4)

    def test_local_upload_preserves_extended_image_extensions(self):
        self.assertEqual(main._local_upload_kind_ext("photo.bmp", "image/bmp"), ("image", ".bmp"))
        self.assertEqual(main._local_upload_kind_ext("photo.avif", "image/avif"), ("image", ".avif"))
        self.assertEqual(main._local_upload_kind_ext("scan.tiff", "image/tiff"), ("image", ".tiff"))

    def test_apimart_nano_banana_payload_uses_aspect_ratio_and_image_size(self):
        payload = main.apimart_image_generation_payload(
            "nano-banana-pro",
            "cherry blossom macro",
            "2048x1152",
            "high",
            [{"url": "https://cdn.example.test/ref.png"}],
            aspect_ratio="16:9",
            resolution="2k",
        )
        self.assertEqual(payload["aspect_ratio"], "16:9")
        self.assertEqual(payload["image_size"], "2K")
        self.assertEqual(payload["response_format"], "url")
        self.assertEqual(payload["image"], ["https://cdn.example.test/ref.png"])

    async def test_gpt_image_1_omits_response_format_and_normalizes_size(self):
        captured = []
        provider = {
            "id": "openai-official",
            "name": "OpenAI",
            "base_url": "https://api.openai.com/v1",
            "protocol": "openai",
            "image_request_mode": "openai",
        }

        def handler(request):
            captured.append(request)
            return httpx.Response(200, json={"data": [{"url": "https://cdn.example.test/gpt1.png"}]})

        with patch.object(main, "get_api_provider", return_value=provider), \
             patch.object(main, "provider_env_key_value", return_value="sk-test"), \
             patch.object(main.httpx, "AsyncClient", side_effect=lambda **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kw)):
            img, _ = await main.generate_ai_image(
                "studio portrait", "2048x1152", "high", "gpt-image-1.5", [], "openai-official"
            )

        self.assertEqual(img["value"], "https://cdn.example.test/gpt1.png")
        body = json.loads(captured[0].content)
        self.assertEqual(body["size"], "1536x1024")
        self.assertEqual(body["quality"], "high")
        self.assertNotIn("response_format", body)

    async def test_dalle3_normalizes_params_and_blocks_reference_edits(self):
        captured = []
        provider = {
            "id": "openai-relay",
            "name": "Relay",
            "base_url": "https://api.example.test/v1",
            "protocol": "openai",
            "image_request_mode": "openai",
        }

        def handler(request):
            captured.append(request)
            return httpx.Response(200, json={"data": [{"url": "https://cdn.example.test/dalle3.png"}]})

        with patch.object(main, "get_api_provider", return_value=provider), \
             patch.object(main, "provider_env_key_value", return_value="sk-test"), \
             patch.object(main.httpx, "AsyncClient", side_effect=lambda **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kw)):
            await main.generate_ai_image("cyberpunk city", "2048x1152", "high", "dall-e-3", [], "openai-relay")
            with self.assertRaises(HTTPException) as ctx:
                await main.generate_ai_image(
                    "edit", "1024x1024", "standard", "dall-e-3",
                    [{"url": "https://cdn.example.test/ref.png"}], "openai-relay",
                )

        body = json.loads(captured[0].content)
        self.assertEqual(body["size"], "1792x1024")
        self.assertEqual(body["quality"], "hd")
        self.assertEqual(ctx.exception.status_code, 400)

    async def test_chat_completions_image_model_uses_chat_endpoint(self):
        captured = []
        provider = {
            "id": "chat-img-relay",
            "name": "Chat Image Relay",
            "base_url": "https://api.example.test/v1",
            "protocol": "openai",
            "image_request_mode": "openai",
        }

        def handler(request):
            captured.append(request)
            return httpx.Response(200, json={
                "choices": [{"message": {"content": "生成完成：\n![result](https://cdn.example.test/4o-out.png)"}}]
            })

        with patch.object(main, "get_api_provider", return_value=provider), \
             patch.object(main, "provider_env_key_value", return_value="sk-test"), \
             patch.object(main.httpx, "AsyncClient", side_effect=lambda **kw: REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kw)):
            img, _ = await main.generate_ai_image(
                "minimalist sakura", "1024x1536", "auto", "gpt-4o-image",
                [{"url": "https://cdn.example.test/ref.png"}], "chat-img-relay", aspect_ratio="2:3"
            )

        self.assertEqual(captured[0].url.path, "/v1/chat/completions")
        self.assertEqual(img, {"type": "url", "value": "https://cdn.example.test/4o-out.png"})


if __name__ == "__main__":
    unittest.main()

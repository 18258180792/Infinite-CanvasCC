import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main


class ProviderSelectionTests(unittest.TestCase):
    def test_protocol_image_provider_does_not_require_model_list(self):
        providers = [
            {
                "id": "runninghub",
                "name": "RunningHub",
                "protocol": "runninghub",
                "enabled": True,
                "image_models": [],
            },
            {
                "id": "image-api",
                "name": "Image API",
                "protocol": "openai",
                "enabled": True,
                "image_models": ["image-model"],
            },
        ]

        with patch.object(main, "load_api_providers", return_value=providers):
            selected = main.pick_chat_image_provider("runninghub")

        self.assertEqual(selected["id"], "runninghub")

    def test_chat_only_provider_is_rejected_for_image_generation(self):
        providers = [
            {
                "id": "chat-only",
                "name": "Chat only",
                "protocol": "openai",
                "enabled": True,
                "image_models": [],
            },
            {
                "id": "image-api",
                "name": "Image API",
                "protocol": "openai",
                "enabled": True,
                "image_models": ["image-model"],
            },
        ]

        with patch.object(main, "load_api_providers", return_value=providers):
            with self.assertRaises(HTTPException) as raised:
                main.pick_chat_image_provider("chat-only")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("没有可用的生图模型", raised.exception.detail)


class JimengLoginTests(unittest.TestCase):
    def test_qr_url_strips_complete_ansi_sequences(self):
        url = "https://example.com/login?code=abc123"
        output = f"\x1b[1;32m{url}\x1b[0m"

        self.assertEqual(main.jimeng_login_qr_from_text(output), url)

    def test_dreamina_url_strips_complete_ansi_sequences(self):
        url = "dreamina://login/abc123"
        output = f"\x1b[38;5;39m{url}\x1b[0m"

        self.assertEqual(main.jimeng_login_qr_from_text(output), url)


if __name__ == "__main__":
    unittest.main()

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class ImageAsyncPayloadTests(unittest.IsolatedAsyncioTestCase):
    def test_scalar_submission_is_not_implicitly_enabled(self):
        for payload in (
            {"code": "success", "message": "", "data": "3dad96708a77485e97ac7ef652796d7b"},
            {"code": "success", "data": "https://example.test/image.png"},
            {"code": "success", "data": "generation accepted"},
            {"code": "failure", "data": "3dad96708a77485e97ac7ef652796d7b"},
            {"data": "3dad96708a77485e97ac7ef652796d7b"},
        ):
            self.assertIsNone(main.extract_task_id(payload))

    def test_existing_task_id_wrappers(self):
        self.assertEqual(main.extract_task_id({"data": [{"taskId": "task-existing"}]}), "task-existing")
        self.assertEqual(main.extract_task_id({"data": {"task_id": "task-existing"}}), "task-existing")

    async def test_nested_success_payload_can_be_polled_and_extracted(self):
        payload = {
            "code": "success",
            "data": {
                "task_id": "3dad96708a77485e97ac7ef652796d7b",
                "status": "SUCCESS",
                "data": {"data": [{"url": "https://example.test/image.png", "b64_json": ""}]},
            },
        }
        self.assertEqual(main.image_task_status(payload), "SUCCESS")
        with patch.object(main, "fetch_image_task_payload", return_value=payload) as fetch:
            result = await main.wait_for_image_task(None, payload["data"]["task_id"], {"protocol": "openai"})
        fetch.assert_awaited_once()
        self.assertEqual(main.extract_image(result), {"type": "url", "value": "https://example.test/image.png"})


if __name__ == "__main__":
    unittest.main()

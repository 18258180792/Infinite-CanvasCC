import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


MODEL = "Dola-Seedream-5.0-Flash"
IMAGE_URL = "https://soonstudio.ai/api/media/result.jpg"


class SoonStudioCanvasDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def test_actual_success_response_supports_url_and_urls_fields(self):
        response = {
            "status": "SUCCESS",
            "task_id": "task-live-shape",
            "data": {"url": IMAGE_URL, "urls": [IMAGE_URL]},
        }

        self.assertEqual(main.image_task_status(response), "SUCCESS")
        self.assertEqual(main.extract_task_id(response), "task-live-shape")
        self.assertEqual(main.extract_images(response), [{"type": "url", "value": IMAGE_URL}])

        urls_only = {
            "status": "SUCCESS",
            "task_id": "task-live-shape",
            "data": {"urls": [IMAGE_URL]},
        }
        self.assertEqual(main.extract_images(urls_only), [{"type": "url", "value": IMAGE_URL}])

    async def test_successful_task_uses_source_url_if_local_copy_is_unavailable(self):
        provider = {
            "id": "soonstudio",
            "name": "SoonStudio",
            "base_url": "https://api-us.soonstudio.ai/v1",
            "image_models": [MODEL],
        }
        payload = main.OnlineImageRequest(
            prompt="test prompt",
            provider_id="soonstudio",
            model=MODEL,
            canvas_id="canvas-1",
        )
        image = {"type": "url", "value": IMAGE_URL}
        raw = {"data": [{"url": IMAGE_URL}]}
        task_state = {"task-1": {"status": "queued"}}
        local_save = AsyncMock(return_value=IMAGE_URL)

        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(main, "generated_image_project_name", return_value="Project"),
            patch.object(main, "generated_image_name_stem", return_value="Project_test"),
            patch.object(main, "generate_ai_image", new=AsyncMock(return_value=(image, raw))),
            patch.object(main, "schedule_remote_generated_image_cache") as schedule_cache,
            patch.object(main, "save_ai_image_to_output", new=local_save),
            patch.object(main, "save_to_history", new=Mock()),
            patch.object(main, "GLOBAL_LOOP", None),
            patch.object(main, "CANVAS_TASKS", task_state),
        ):
            await main.run_canvas_image_task("task-1", payload)

        self.assertEqual(task_state["task-1"]["status"], "succeeded")
        result = task_state["task-1"]["result"]
        self.assertEqual(result["images"], [IMAGE_URL])
        self.assertEqual(result["image_items"][0]["url"], IMAGE_URL)
        local_save.assert_awaited_once_with(image, prefix="online_", name_stem="Project_test")
        schedule_cache.assert_not_called()

    async def test_other_providers_use_local_output_when_available(self):
        provider = {
            "id": "other",
            "name": "Other",
            "base_url": "https://images.example.test/v1",
            "image_models": ["image-model"],
        }
        payload = main.OnlineImageRequest(
            prompt="test prompt",
            provider_id="other",
            model="image-model",
        )
        image = {"type": "url", "value": "https://images.example.test/result.png"}
        raw = {"data": [{"url": image["value"]}]}

        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(main, "generated_image_project_name", return_value="Project"),
            patch.object(main, "generated_image_name_stem", return_value="Project_test"),
            patch.object(main, "generate_ai_image", new=AsyncMock(return_value=(image, raw))),
            patch.object(main, "schedule_remote_generated_image_cache") as schedule_cache,
            patch.object(main, "save_ai_image_to_output", new=AsyncMock(return_value="/assets/output/result.png")) as save_image,
            patch.object(main, "save_to_history", new=Mock()),
            patch.object(main, "GLOBAL_LOOP", None),
        ):
            result = await main.build_online_image_result(payload)

        self.assertEqual(result["images"], ["/assets/output/result.png"])
        save_image.assert_awaited_once()
        schedule_cache.assert_not_called()


if __name__ == "__main__":
    unittest.main()

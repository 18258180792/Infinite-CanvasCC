import base64
import re
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class GeneratedImageNameTests(unittest.TestCase):
    def test_chinese_project_and_summary(self):
        stem = main.generated_image_name_stem("山海项目", "少女站在湖边看远山", index=2)
        self.assertRegex(stem, r"^山海项目_少女站在湖边看远山_\d{8}-\d{6}_02_[0-9a-f]{6}$")

    def test_unsafe_characters_and_controls_are_removed(self):
        stem = main.generated_image_name_stem('项目\\/:*?"<>|\x00\n', '人物\\/:*?"<>|\x01\r\n站立')
        self.assertFalse(re.search(r'[\\/:*?"<>|\x00-\x1f]', stem))
        self.assertIn("项目", stem)
        self.assertIn("人物", stem)
        self.assertIn("站立", stem)

    def test_component_lengths_are_bounded(self):
        stem = main.generated_image_name_stem("项" * 80, "文" * 100)
        self.assertTrue(stem.startswith("项" * 30 + "_" + "文" * 40 + "_"))
        self.assertRegex(stem, r"_\d{8}-\d{6}_01_[0-9a-f]{6}$")
        self.assertLessEqual(len(stem), 98)

    def test_identical_inputs_have_unique_names(self):
        names = {main.generated_image_name_stem("项目", "相同文案") for _ in range(24)}
        self.assertEqual(len(names), 24)

    def test_empty_inputs_have_readable_defaults(self):
        self.assertTrue(main.generated_image_name_stem("", "").startswith("未命名项目_生成图片_"))

    def test_project_is_resolved_from_canvas_project_not_title(self):
        with (
            patch.object(main, "load_canvas", return_value={"project": "p1", "title": "画布标题"}) as load,
            patch.object(main, "load_projects", return_value=[{"id": "p1", "name": "实际项目"}]),
        ):
            self.assertEqual(main.generated_image_project_name("c1"), "实际项目")
        load.assert_called_once_with("c1")

    def test_missing_project_falls_back_to_canvas_title(self):
        with (
            patch.object(main, "load_canvas", return_value={"project": "missing", "title": "画布标题"}),
            patch.object(main, "load_projects", return_value=[]),
        ):
            self.assertEqual(main.generated_image_project_name("c1"), "画布标题")

    def test_missing_canvas_has_fallback(self):
        with patch.object(main, "load_canvas") as load:
            self.assertEqual(main.generated_image_project_name(""), "未命名项目")
            load.assert_not_called()
        with patch.object(main, "load_canvas", side_effect=main.HTTPException(status_code=404)):
            self.assertEqual(main.generated_image_project_name("missing"), "未命名项目")


class GeneratedImageNameDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_base64_uses_supplied_stem_and_actual_mime_extension(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory) / "assets"
            output = assets / "output"
            output.mkdir(parents=True)
            stem = "项目_摘要_20261010-143025_01_ab12cd"
            content = b"image-payload"
            with (
                patch.object(main, "ASSETS_DIR", str(assets)),
                patch.object(main, "OUTPUT_OUTPUT_DIR", str(output)),
                patch.object(main.httpx, "AsyncClient") as client,
            ):
                url = await main.save_ai_image_to_output(
                    {"type": "b64", "value": base64.b64encode(content).decode("ascii"), "mime_type": "image/jpeg"},
                    name_stem=stem,
                )
            client.assert_not_called()
            self.assertEqual(urllib.parse.unquote(Path(url).name), stem + ".jpg")
            self.assertEqual((output / (stem + ".jpg")).read_bytes(), content)

    async def test_remote_fallback_keeps_friendly_metadata(self):
        remote = "https://images.example.test/opaque-upstream-id.png"
        stem = "实际项目_少女站在湖边_20261010-143025_01_ab12cd"
        image = {"type": "url", "value": remote}
        payload = main.OnlineImageRequest(prompt="少女站在湖边", provider_id="test", model="test-model", canvas_id="c1")
        with (
            patch.object(main, "get_api_provider", return_value={"id": "test", "name": "测试", "image_models": ["test-model"]}),
            patch.object(main, "generated_image_project_name", return_value="实际项目") as project,
            patch.object(main, "generated_image_name_stem", return_value=stem),
            patch.object(main, "generate_ai_image", new=AsyncMock(return_value=(image, {}))),
            patch.object(main, "extract_images", return_value=[image]),
            patch.object(main, "save_ai_image_to_output", new=AsyncMock(return_value=remote)) as save,
            patch.object(main, "save_to_history", new=Mock()),
            patch.object(main, "GLOBAL_LOOP", None),
        ):
            result = await main.build_online_image_result(payload)
        project.assert_called_once_with("c1")
        self.assertEqual(result["project_name"], "实际项目")
        self.assertEqual(result["images"], [remote])
        self.assertEqual(result["image_items"][0]["url"], remote)
        self.assertEqual(result["image_items"][0]["name"], stem + ".png")
        self.assertEqual(save.call_args.kwargs["name_stem"], stem)


if __name__ == "__main__":
    unittest.main()

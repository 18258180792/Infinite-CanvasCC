import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class GeneratedImageContextTests(unittest.TestCase):
    def request(self, referer):
        return SimpleNamespace(
            headers={"referer": referer}, base_url="http://127.0.0.1:3000/"
        )

    def test_same_origin_canvas_pages_supply_missing_id(self):
        for page in ("canvas", "smart-canvas"):
            with self.subTest(page=page):
                payload = main.OnlineImageRequest(prompt="cover")
                main.populate_image_canvas_context(
                    payload,
                    self.request(f"http://127.0.0.1:3000/static/{page}.html?id=canvas_cat-123"),
                )
                self.assertEqual(payload.canvas_id, "canvas_cat-123")

    def test_explicit_canvas_id_is_not_overwritten(self):
        payload = main.OnlineImageRequest(prompt="cover", canvas_id="captured-project")
        main.populate_image_canvas_context(
            payload,
            self.request("http://127.0.0.1:3000/static/smart-canvas.html?id=other-project"),
        )
        self.assertEqual(payload.canvas_id, "captured-project")

    def test_untrusted_or_invalid_referer_does_not_supply_id(self):
        urls = (
            "https://example.test/static/canvas.html?id=canvas_123",
            "http://127.0.0.1:3001/static/canvas.html?id=canvas_123",
            "http://127.0.0.1:3000/static/canvas.html",
            "http://127.0.0.1:3000/static/other.html?id=canvas_123",
            "http://127.0.0.1:3000/static/canvas.html?id=../unsafe",
            "http://127.0.0.1:3000/static/canvas.html?id=",
            "http://127.0.0.1:3000/static/canvas.html?id=" + "a" * 121,
            "",
        )
        for url in urls:
            with self.subTest(url=url):
                payload = main.OnlineImageRequest(prompt="cover")
                main.populate_image_canvas_context(payload, self.request(url))
                self.assertEqual(payload.canvas_id, "")

    def test_canvas_response_exposes_owning_project_name(self):
        canvas = {"id": "canvas_123", "project": "cat-litter", "title": "Canvas title"}
        project_name = "\u7a7a\u6c14\u5976\u767d\u732b\u7802"
        with patch.object(main, "load_canvas", return_value=dict(canvas)), patch.object(
            main, "load_projects", return_value=[{"id": "cat-litter", "name": project_name}]
        ):
            result = asyncio.run(main.get_canvas("canvas_123"))
        self.assertEqual(result["canvas"]["project_name"], project_name)
        self.assertEqual(result["canvas"]["title"], "Canvas title")

    def test_missing_project_uses_canvas_title(self):
        with patch.object(main, "load_canvas", return_value={"title": "Cover canvas"}), patch.object(
            main, "load_projects", return_value=[]
        ):
            self.assertEqual(main.generated_image_project_name("canvas_123"), "Cover canvas")


if __name__ == "__main__":
    unittest.main()

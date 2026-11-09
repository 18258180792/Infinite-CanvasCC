import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image
import requests

import main


class CanvasMediaLocalizationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "assets"
        self.output = self.assets / "output"
        self.preview = self.root / "previews"
        self.canvases = self.root / "canvases"
        self.output.mkdir(parents=True)
        self.canvases.mkdir()
        self.patches = [
            patch.object(main, "ASSETS_DIR", str(self.assets)),
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.output)),
            patch.object(main, "MEDIA_PREVIEW_DIR", str(self.preview)),
            patch.object(main, "CANVAS_DIR", str(self.canvases)),
        ]
        for item in self.patches:
            item.start()
        buf = io.BytesIO()
        Image.new("RGB", (32, 16), "green").save(buf, format="PNG")
        self.png = buf.getvalue()
        self.data_url = "data:image/png;base64," + base64.b64encode(self.png).decode("ascii")

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    async def test_inline_image_is_localized_once_across_node_and_logs(self):
        canvas = {
            "nodes": [{"images": [{"url": self.data_url, "kind": "image"}],
                       "runInputRefs": [{"url": self.data_url}]}],
            "logs": [{"refs": [{"url": self.data_url}]}],
        }
        replacements, failures, paths = main.normalize_canvas_image_references(canvas)
        url = canvas["nodes"][0]["images"][0]["url"]
        self.assertEqual(len(replacements), 1)
        self.assertEqual(failures, {})
        self.assertEqual(canvas["nodes"][0]["runInputRefs"][0]["url"], url)
        self.assertEqual(canvas["logs"][0]["refs"][0]["url"], url)
        self.assertTrue(url.startswith("/assets/output/"))
        self.assertEqual(len(paths), 1)
        self.assertEqual(self.output.joinpath(Path(url).name).read_bytes(), self.png)

    async def test_remote_failure_preserves_original_url(self):
        url = "https://example.test/image.png"
        canvas = {"nodes": [{"images": [{"url": url, "kind": "image"}]}]}
        with (
            patch.object(main, "public_canvas_image_url", return_value=True),
            patch.object(main, "persist_public_canvas_image", side_effect=TimeoutError()),
        ):
            replacements, failures, _paths = main.normalize_canvas_image_references(canvas)
        self.assertEqual(replacements, {})
        self.assertEqual(failures, {url: "TimeoutError"})
        self.assertEqual(canvas["nodes"][0]["images"][0]["url"], url)

    async def test_remote_preview_is_cached_and_resized(self):
        source = self.output / "remote.png"
        source.write_bytes(self.png)
        url = "https://example.test/image.png"
        with (
            patch.object(main, "public_canvas_image_url", return_value=True),
            patch.object(main, "persist_public_canvas_image", return_value=str(source)) as download,
        ):
            result = await main.media_preview(url, w=64)
            second = await main.media_preview(url, w=64)
        self.assertEqual(download.call_count, 1)
        self.assertEqual(result.path, second.path)
        with Image.open(result.path) as image:
            self.assertEqual(image.size, (32, 16))

    async def test_public_image_redirect_to_loopback_is_rejected(self):
        redirect = Mock(status_code=302, headers={"location": "http://127.0.0.1/internal"})
        with (
            patch.object(main, "public_canvas_image_url", side_effect=lambda url: url.startswith("https://example.test/")),
            patch.object(main.requests, "get", return_value=redirect) as get,
        ):
            with self.assertRaises(requests.RequestException):
                main.public_canvas_image_get("https://example.test/image.png", stream=True)
        get.assert_called_once()
        redirect.close.assert_called_once()

    async def test_new_smart_canvas_has_conservative_default_zoom(self):
        canvas = main.new_canvas(kind="smart")
        self.assertEqual(canvas["viewport"]["scale"], 0.45)
        self.assertEqual(main.new_canvas(kind="classic")["viewport"]["scale"], 1)
        self.assertEqual(json.loads(self.canvases.joinpath(canvas["id"] + ".json").read_text())["viewport"]["scale"], 0.45)


if __name__ == "__main__":
    unittest.main()

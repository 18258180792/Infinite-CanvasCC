import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main


REPOSITORY = "18258180792/Infinite-CanvasCC"
OLD_REPOSITORY = "hero8152" + "/Infinite-Canvas"


class UpdateSourceTests(unittest.TestCase):
    def test_backend_urls_target_project_repository(self):
        self.assertEqual(main.GITHUB_REPO_URL, f"https://github.com/{REPOSITORY}")
        self.assertEqual(
            main.GITHUB_VERSION_URL,
            f"https://raw.githubusercontent.com/{REPOSITORY}/main/VERSION",
        )
        self.assertEqual(
            main.GITHUB_TREE_URL,
            f"https://api.github.com/repos/{REPOSITORY}/git/trees/main?recursive=1",
        )
        self.assertEqual(
            main.GITHUB_RAW_ROOT,
            f"https://raw.githubusercontent.com/{REPOSITORY}/main",
        )

    def test_app_info_exposes_only_github_update_source(self):
        info = main.app_info()

        self.assertEqual(info["repo_url"], main.GITHUB_REPO_URL)
        self.assertEqual(set(info["sources"]), {"github"})
        self.assertEqual(info["sources"]["github"]["version_url"], main.GITHUB_VERSION_URL)

    def test_update_api_defaults_disable_fallback(self):
        request = main.UpdateRequest()

        self.assertEqual(request.source, "github")
        self.assertFalse(request.fallback)
        self.assertEqual(main.UPDATE_SOURCE_LABELS, {"github": "GitHub"})
        self.assertFalse(hasattr(main, "download_modelscope_update_files"))

    def test_check_update_only_queries_github(self):
        remote = {"version": "2026.09.16", "ok": True, "error": "", "url": main.GITHUB_VERSION_URL}
        notes = {"version": "2026.09.16", "items": [{"type": "fix", "text": "test"}], "ok": True}

        with patch.object(main, "fetch_remote_version", return_value=remote) as fetch_version:
            with patch.object(main, "fetch_remote_update_notes", return_value=notes) as fetch_notes:
                result = main.check_update()

        fetch_version.assert_called_once_with(main.GITHUB_VERSION_URL, timeout=5.0)
        fetch_notes.assert_called_once_with(main.GITHUB_UPDATE_NOTES_URL, "2026.09.16", timeout=3.0)
        self.assertEqual(result["latest"]["source"], "github")
        self.assertNotIn("modelscope", result)
        self.assertEqual(set(result["update_notes_sources"]), {"github"})

    def test_legacy_modelscope_request_is_forced_to_github(self):
        request = main.UpdateRequest(source="modelscope", fallback=True)

        with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            with patch.object(main, "stage_github_update", side_effect=RuntimeError("download sentinel")) as stage:
                with self.assertRaises(HTTPException) as raised:
                    main.update_from_github(request)

        stage.assert_called_once()
        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("GitHub 更新源下载失败", raised.exception.detail)

    def test_frontend_has_no_old_update_source(self):
        html = (Path(main.BASE_DIR) / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn(REPOSITORY, html)
        self.assertNotIn(OLD_REPOSITORY, html)
        self.assertNotIn("update-source-modelscope", html)
        self.assertNotIn("fallback:true", html)
        self.assertIn("source:'github', fallback:false", html)


if __name__ == "__main__":
    unittest.main()

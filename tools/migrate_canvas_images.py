#!/usr/bin/env python3
"""Back up every canvas, localize inline/remote images, and warm 512px previews."""

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main


def migrate(apply=False):
    paths = [
        os.path.join(main.CANVAS_DIR, name)
        for name in sorted(os.listdir(main.CANVAS_DIR))
        if name.endswith(".json")
    ]
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    backup_dir = os.path.join(main.DATA_DIR, "migration_backups", f"canvas-images-{timestamp}")
    if apply:
        os.makedirs(backup_dir, exist_ok=False)
        for path in paths:
            shutil.copy2(path, os.path.join(backup_dir, os.path.basename(path)))
    report = {
        "canvas_count": len(paths),
        "backup_dir": backup_dir if apply else None,
        "updated_canvases": 0,
        "localized_images": 0,
        "preview_count": 0,
        "failed_images": [],
        "skipped_canvases": [],
    }
    preview_paths = set()
    for path in paths:
        with open(path, "rb") as source:
            original = source.read()
        if not apply:
            canvas = json.loads(original)
            print(f"{os.path.basename(path)}: {len(canvas.get('nodes') or [])} nodes")
            continue
        try:
            canvas = json.loads(original)
            replacements, failures, sources = main.normalize_canvas_image_references(canvas)
            preview_paths.update(sources)
            for url, reason in failures.items():
                report["failed_images"].append({
                    "canvas": os.path.basename(path),
                    "source": "inline" if url.lower().startswith("data:image/") else main.urllib.parse.urlsplit(url).hostname or "local",
                    "reason": reason,
                })
            changed = sum(1 for old, new in replacements.items() if old != new)
            if not changed:
                continue
            canvas["updated_at"] = main.now_ms()
            with main.CANVAS_LOCK:
                with open(path, "rb") as current:
                    if hashlib.sha256(current.read()).digest() != hashlib.sha256(original).digest():
                        report["skipped_canvases"].append(os.path.basename(path))
                        continue
                temp_path = f"{path}.{uuid.uuid4().hex}.tmp"
                try:
                    with open(temp_path, "w", encoding="utf-8") as target:
                        json.dump(canvas, target, ensure_ascii=False, indent=2)
                    os.replace(temp_path, path)
                finally:
                    if os.path.exists(temp_path):
                        os.remove(temp_path)
            report["updated_canvases"] += 1
            report["localized_images"] += changed
            print(f"{os.path.basename(path)}: {changed} unique image references localized", flush=True)
        except Exception as exc:
            report["skipped_canvases"].append(f"{os.path.basename(path)}: {type(exc).__name__}")

    if apply:
        for index, path in enumerate(sorted(preview_paths), 1):
            try:
                main.build_media_preview_file(path, 512)
                report["preview_count"] += 1
            except Exception as exc:
                report["failed_images"].append({
                    "canvas": "preview-cache",
                    "source": os.path.basename(path),
                    "reason": type(exc).__name__,
                })
            if index % 25 == 0:
                print(f"Previews: {index}/{len(preview_paths)}", flush=True)
        report_path = os.path.join(backup_dir, "report.json")
        with open(report_path, "w", encoding="utf-8") as target:
            json.dump(report, target, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Create backup, migrate and warm previews")
    args = parser.parse_args()
    migrate(args.apply)

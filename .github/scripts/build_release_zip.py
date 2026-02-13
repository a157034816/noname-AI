#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import argparse
import os
import shutil
import sys
import zipfile
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build release zip from a whitelist of files/directories.",
    )
    parser.add_argument(
        "--whitelist",
        default="release-whitelist.txt",
        help="Path to whitelist file (relative to repo root).",
    )
    parser.add_argument(
        "--output",
        default="dist/身临其境的AI.zip",
        help="Output zip path (relative to repo root).",
    )
    parser.add_argument(
        "--root-name",
        default="身临其境的AI",
        help="Top-level folder name inside the zip.",
    )
    return parser.parse_args()


def _normalize_relpath(line: str) -> str:
    raw = line.strip()
    if not raw:
        return ""
    if raw.startswith("#"):
        return ""

    # Allow Windows-style separators in config, but normalize to POSIX-like.
    normalized = raw.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if normalized == ".":
        return ""
    return normalized


def _ensure_safe_relpath(rel: str) -> None:
    if not rel:
        raise ValueError("Empty path in whitelist")
    if os.path.isabs(rel):
        raise ValueError(f"Absolute path is not allowed in whitelist: {rel}")

    # Prevent directory traversal.
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValueError(f"Path traversal is not allowed in whitelist: {rel}")


def _copy_whitelisted_item(repo_root: Path, stage_root: Path, rel: str) -> None:
    src = (repo_root / rel).resolve()
    repo_root_resolved = repo_root.resolve()
    try:
        src.relative_to(repo_root_resolved)
    except ValueError as exc:
        raise ValueError(f"Whitelist path escapes repository root: {rel}") from exc

    if not src.exists():
        raise FileNotFoundError(f"Whitelist item not found: {rel}")

    dest = stage_root / rel
    if src.is_dir():
        shutil.copytree(src, dest, dirs_exist_ok=True)
        return

    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


def _write_zip(stage_base: Path, output_zip: Path) -> int:
    output_zip.parent.mkdir(parents=True, exist_ok=True)
    if output_zip.exists():
        output_zip.unlink()

    file_count = 0
    with zipfile.ZipFile(output_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(stage_base.rglob("*")):
            if not path.is_file():
                continue
            arcname = path.relative_to(stage_base.parent)
            zf.write(path, arcname.as_posix())
            file_count += 1
    return file_count


def main() -> int:
    args = _parse_args()
    repo_root = Path.cwd()

    whitelist_path = (repo_root / args.whitelist).resolve()
    if not whitelist_path.exists():
        print(f"[release] whitelist file not found: {whitelist_path}", file=sys.stderr)
        return 2

    dist_dir = repo_root / "dist"
    stage_base = dist_dir / ".stage"
    stage_root = stage_base / args.root_name
    if stage_base.exists():
        shutil.rmtree(stage_base)
    stage_root.mkdir(parents=True, exist_ok=True)

    with whitelist_path.open("r", encoding="utf-8") as f:
        lines = f.readlines()

    items: list[str] = []
    for line in lines:
        rel = _normalize_relpath(line)
        if not rel:
            continue
        _ensure_safe_relpath(rel)
        items.append(rel)

    if not items:
        print("[release] whitelist is empty", file=sys.stderr)
        return 2

    for rel in items:
        _copy_whitelisted_item(repo_root, stage_root, rel)

    output_zip = (repo_root / args.output).resolve()
    file_count = _write_zip(stage_root, output_zip)
    print(f"[release] zip built: {output_zip} (files: {file_count})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


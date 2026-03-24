#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import argparse
import json
import os
import re
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
    parser.add_argument(
        "--version",
        default="",
        help="Version string injected into staged src/version.js and info.json before zipping.",
    )
    parser.add_argument(
        "--build-channel",
        default="stable",
        choices=("stable", "pr"),
        help="Build channel metadata written into staged src/version.js.",
    )
    parser.add_argument(
        "--build-pr-number",
        default="",
        help="PR number metadata written into staged src/version.js for PR test builds.",
    )
    parser.add_argument(
        "--build-tag",
        default="",
        help="Release tag metadata written into staged src/version.js before zipping.",
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


def inject_version_metadata(
    stage_root: Path,
    *,
    version: str,
    build_channel: str,
    build_pr_number: str,
    build_tag: str,
) -> None:
    version_path = stage_root / "src" / "version.js"
    info_path = stage_root / "info.json"
    if not version_path.exists():
        raise FileNotFoundError(f"Missing staged version file: {version_path}")
    if not info_path.exists():
        raise FileNotFoundError(f"Missing staged info.json: {info_path}")

    source = version_path.read_text(encoding="utf-8")
    source = _replace_js_string_const(source, "SLQJ_AI_EXTENSION_VERSION", version)
    source = _replace_js_string_const(source, "SLQJ_AI_EXTENSION_BUILD_CHANNEL", build_channel)
    source = _replace_js_string_const(source, "SLQJ_AI_EXTENSION_BUILD_PR_NUMBER", build_pr_number)
    source = _replace_js_string_const(source, "SLQJ_AI_EXTENSION_BUILD_TAG", build_tag)
    version_path.write_text(source, encoding="utf-8")

    info = json.loads(info_path.read_text(encoding="utf-8"))
    info["version"] = version
    info_path.write_text(json.dumps(info, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def _replace_js_string_const(source: str, const_name: str, value: str) -> str:
    pattern = re.compile(rf'^(export const {re.escape(const_name)} = )".*?";$', re.MULTILINE)
    if not pattern.search(source):
        raise ValueError(f"Missing JS string const: {const_name}")
    return pattern.sub(rf'\1"{_escape_js_string(value)}";', source, count=1)


def _escape_js_string(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


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

    if args.version:
        build_pr_number = str(args.build_pr_number or "").strip()
        if args.build_channel != "pr":
            build_pr_number = ""
        build_tag = str(args.build_tag or f"v{args.version}").strip()
        inject_version_metadata(
            stage_root,
            version=str(args.version).strip(),
            build_channel=str(args.build_channel).strip(),
            build_pr_number=build_pr_number,
            build_tag=build_tag,
        )

    output_zip = (repo_root / args.output).resolve()
    file_count = _write_zip(stage_root, output_zip)
    print(f"[release] zip built: {output_zip} (files: {file_count})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

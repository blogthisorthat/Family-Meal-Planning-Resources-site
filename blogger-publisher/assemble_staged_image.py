#!/usr/bin/env python3
"""Reconstruct a generated recipe image from temporary base64 text parts.

This exists only because the publishing integration writes text files more
reliably than binary blobs. GitHub Actions assembles the exact generated raster
image, verifies its SHA-256 digest and image signature, commits the binary image,
and deletes the temporary parts before the publishing pipeline continues.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import pathlib
import re
import sys
from typing import Any

QUEUE_PATH = pathlib.Path(os.environ.get("QUEUE_PATH", "blogger-publisher/queue/current.json"))
MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def output(name: str, value: Any) -> None:
    text = "" if value is None else str(value)
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={text}\n")
    print(f"{name}={text}")


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def safe_repo_path(raw: str, required_prefix: tuple[str, ...]) -> pathlib.Path:
    path = pathlib.PurePosixPath(raw)
    if path.is_absolute() or ".." in path.parts:
        fail(f"Unsafe repository path: {raw}")
    if path.parts[: len(required_prefix)] != required_prefix:
        fail(f"Path must be under {'/'.join(required_prefix)}/: {raw}")
    return pathlib.Path(*path.parts)


def validate_image(data: bytes, suffix: str) -> None:
    if not data:
        fail("Decoded image is empty")
    if len(data) > MAX_IMAGE_BYTES:
        fail("Decoded image exceeds 10 MB")
    jpeg = data.startswith(b"\xff\xd8\xff")
    png = data.startswith(b"\x89PNG\r\n\x1a\n")
    webp = len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    expected = {
        ".jpg": jpeg,
        ".jpeg": jpeg,
        ".png": png,
        ".webp": webp,
    }[suffix]
    if not expected:
        fail(f"Decoded bytes do not match {suffix} image format")


def main() -> None:
    item = json.loads(QUEUE_PATH.read_text(encoding="utf-8"))
    if not isinstance(item, dict):
        fail("Queue JSON must be an object")

    parts = item.get("imageBase64Parts")
    if not parts:
        output("assembled", "false")
        output("image_path", item.get("imageSourcePath", ""))
        return
    if not isinstance(parts, list) or not parts or any(not isinstance(p, str) for p in parts):
        fail("imageBase64Parts must be a non-empty array of paths")

    queue_id = str(item.get("queueId") or "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,199}", queue_id):
        fail("Invalid queueId")

    target = safe_repo_path(str(item.get("imageSourcePath") or ""), ("blogger-publisher", "staging"))
    if target.suffix.lower() not in ALLOWED_SUFFIXES:
        fail("Target image must be JPG, JPEG, PNG, or WEBP")
    if target.stem != queue_id:
        fail("Target image filename must match queueId")

    encoded_chunks: list[str] = []
    part_paths: list[pathlib.Path] = []
    for raw in parts:
        part = safe_repo_path(raw, ("blogger-publisher", "image-parts"))
        if not part.is_file():
            fail(f"Missing base64 image part: {raw}")
        text = "".join(part.read_text(encoding="ascii").split())
        if not text or re.search(r"[^A-Za-z0-9+/=]", text):
            fail(f"Invalid base64 characters in {raw}")
        encoded_chunks.append(text)
        part_paths.append(part)

    try:
        data = base64.b64decode("".join(encoded_chunks), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise RuntimeError(f"Base64 image reconstruction failed: {exc}") from exc

    expected_sha = str(item.get("imageSha256") or "").lower()
    actual_sha = hashlib.sha256(data).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        fail("imageSha256 is required and must be a SHA-256 hex digest")
    if actual_sha != expected_sha:
        fail(f"Decoded image SHA-256 mismatch: expected {expected_sha}, got {actual_sha}")

    validate_image(data, target.suffix.lower())
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

    for part in part_paths:
        part.unlink()

    item.pop("imageBase64Parts", None)
    item["imageAssemblyStatus"] = "complete"
    item["imageAssemblySha256"] = actual_sha
    QUEUE_PATH.write_text(json.dumps(item, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    output("assembled", "true")
    output("image_path", target.as_posix())
    output("queue_id", queue_id)
    output("sha256", actual_sha)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

#!/usr/bin/env python3
"""Prepare and publish the GitHub-backed Blogger queue.

The prepare phase validates a staged, generated raster image, prefers R2 storage,
falls back to the repository's raw GitHub URL when the deployed Worker cannot
accept an R2 upload, embeds the final public URL, and enables the queue.

The publish phase calls the Cloudflare Worker using both the current protected
POST contract and the legacy public GET contract, then treats Blogger's API
result as authoritative instead of failing on public-page rate limits.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import mimetypes
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

QUEUE_PATH = pathlib.Path(os.environ.get("QUEUE_PATH", "blogger-publisher/queue/current.json"))
WORKER_BASE = os.environ.get(
    "WORKER_BASE", "https://steep-math-9b6b.conradrensch1.workers.dev"
).rstrip("/")
R2_PUBLIC_BASE = os.environ.get(
    "R2_PUBLIC_BASE", "https://pub-343f7a8e174e49de9b9c66bc76af0229.r2.dev"
).rstrip("/")
REPOSITORY = os.environ.get(
    "GITHUB_REPOSITORY", "blogthisorthat/Family-Meal-Planning-Resources-site"
)
BRANCH = os.environ.get("PUBLISH_BRANCH", "main")
PUBLISH_API_KEY = os.environ.get("PUBLISH_API_KEY", "").strip()
MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_SUFFIX = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
RAW_BASE = f"https://raw.githubusercontent.com/{REPOSITORY}/{BRANCH}"
USER_AGENT = "TheManThatCooksPublisher/2.0"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str) -> None:
    print(message, flush=True)


def warn(message: str) -> None:
    print(f"WARNING: {message}", file=sys.stderr, flush=True)


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def load_queue() -> dict[str, Any]:
    try:
        item = json.loads(QUEUE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"Queue file not found: {QUEUE_PATH}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Queue JSON is invalid: {exc}") from exc
    if not isinstance(item, dict):
        fail("Queue JSON must be an object")
    return item


def save_queue(item: dict[str, Any]) -> None:
    QUEUE_PATH.write_text(json.dumps(item, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def set_output(name: str, value: Any) -> None:
    text = "" if value is None else str(value)
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={text}\n")
    log(f"{name}={text}")


def validate_queue_identity(item: dict[str, Any]) -> None:
    for field in ("queueId", "blog", "title", "contentHtml"):
        if not item.get(field):
            fail(f"Queue item is missing required field: {field}")
    if item.get("blog") != "cooking":
        fail(f"Unsupported blog alias: {item.get('blog')}")
    queue_id = str(item["queueId"])
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,199}", queue_id):
        fail("queueId contains unsupported characters")
    labels = item.get("labels", [])
    if not isinstance(labels, list) or any(not isinstance(label, str) for label in labels):
        fail("labels must be an array of strings")


def safe_source_path(item: dict[str, Any]) -> pathlib.Path:
    raw_path = str(item.get("imageSourcePath") or "")
    if not raw_path:
        fail("imageSourcePath is required while the image is staged")
    path = pathlib.PurePosixPath(raw_path)
    if path.is_absolute() or ".." in path.parts:
        fail("imageSourcePath must be a safe repository-relative path")
    if len(path.parts) < 3 or path.parts[:2] != ("blogger-publisher", "staging"):
        fail("imageSourcePath must be under blogger-publisher/staging/")
    suffix = path.suffix.lower()
    if suffix not in ALLOWED_SUFFIX:
        fail("Staged image must be JPG, JPEG, PNG, or WEBP")
    local = pathlib.Path(*path.parts)
    if not local.is_file():
        fail(f"Staged image does not exist: {raw_path}")
    size = local.stat().st_size
    if size <= 0:
        fail("Staged image is empty")
    if size > MAX_IMAGE_BYTES:
        fail("Staged image exceeds the 10 MB limit")
    expected_name = str(item["queueId"])
    if local.stem != expected_name:
        fail("Staged image filename must exactly match queueId")
    return local


def sniff_mime(path: pathlib.Path) -> str:
    data = path.read_bytes()[:32]
    if data.startswith(b"\xff\xd8\xff"):
        actual = "image/jpeg"
    elif data.startswith(b"\x89PNG\r\n\x1a\n"):
        actual = "image/png"
    elif len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        actual = "image/webp"
    else:
        fail("Staged file is not a recognizable JPG, PNG, or WEBP image")
    suffix_mime = ALLOWED_SUFFIX[path.suffix.lower()]
    if actual != suffix_mime:
        fail(f"Image bytes are {actual}, but the file extension implies {suffix_mime}")
    return actual


def request_bytes(
    url: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 45,
) -> tuple[int, dict[str, str], bytes]:
    merged = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if headers:
        merged.update(headers)
    request = urllib.request.Request(url, data=data, headers=merged, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as exc:
        body = exc.read()
        return exc.code, {k.lower(): v for k, v in exc.headers.items()}, body


def parse_json_response(status: int, body: bytes, context: str) -> dict[str, Any]:
    text = body.decode("utf-8", errors="replace")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{context} returned HTTP {status} with non-JSON body: {text[:500]}") from exc
    if not isinstance(data, dict):
        fail(f"{context} returned a non-object JSON response")
    return data


def verify_public_image(url: str, expected_mime: str, attempts: int = 6) -> None:
    if not url.startswith("https://"):
        fail("Recipe image URL must use HTTPS")
    last_error = "unknown error"
    for attempt in range(1, attempts + 1):
        status, headers, body = request_bytes(url, timeout=45)
        content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if status == 200 and body:
            if content_type and content_type not in ALLOWED_MIME:
                last_error = f"invalid content type {content_type}"
            elif content_type and expected_mime and content_type != expected_mime:
                last_error = f"content type {content_type} does not match {expected_mime}"
            else:
                if expected_mime == "image/jpeg" and not body.startswith(b"\xff\xd8\xff"):
                    last_error = "JPEG URL did not return JPEG bytes"
                elif expected_mime == "image/png" and not body.startswith(b"\x89PNG\r\n\x1a\n"):
                    last_error = "PNG URL did not return PNG bytes"
                elif expected_mime == "image/webp" and not (len(body) >= 12 and body[:4] == b"RIFF" and body[8:12] == b"WEBP"):
                    last_error = "WEBP URL did not return WEBP bytes"
                else:
                    return
        else:
            last_error = f"HTTP {status} or empty body"
        if attempt < attempts:
            time.sleep(min(2 * attempt, 8))
    fail(f"Recipe image is not publicly reachable: {last_error}")


def raw_source_url(source_path: pathlib.Path) -> str:
    quoted = "/".join(urllib.parse.quote(part) for part in source_path.as_posix().split("/"))
    return f"{RAW_BASE}/{quoted}"


def try_queue_ingest(queue_id: str) -> tuple[str | None, str | None]:
    payload = json.dumps({"queueId": queue_id}).encode("utf-8")
    status, _, body = request_bytes(
        f"{WORKER_BASE}/ingest-queue-image",
        method="POST",
        data=payload,
        headers={"Content-Type": "application/json; charset=UTF-8"},
    )
    if status < 200 or status >= 300:
        return None, f"queue-ingest endpoint returned HTTP {status}: {body.decode('utf-8', errors='replace')[:300]}"
    data = parse_json_response(status, body, "Queue image ingest")
    url = str(data.get("url") or "")
    if not data.get("ok") or not url.startswith(f"{R2_PUBLIC_BASE}/recipes/"):
        return None, f"queue-ingest endpoint returned an unexpected response: {json.dumps(data)[:500]}"
    return url, None


def try_direct_upload(queue_id: str, source_path: pathlib.Path, mime: str) -> tuple[str | None, str | None]:
    headers = {"Content-Type": mime}
    if PUBLISH_API_KEY:
        headers["Authorization"] = f"Bearer {PUBLISH_API_KEY}"
    filename = f"{queue_id}{source_path.suffix.lower()}"
    status, _, body = request_bytes(
        f"{WORKER_BASE}/upload-image/{urllib.parse.quote(filename)}",
        method="PUT",
        data=source_path.read_bytes(),
        headers=headers,
        timeout=60,
    )
    if status < 200 or status >= 300:
        return None, f"direct upload returned HTTP {status}: {body.decode('utf-8', errors='replace')[:300]}"
    data = parse_json_response(status, body, "Direct image upload")
    url = str(data.get("url") or "")
    if not data.get("ok") or not url.startswith(f"{R2_PUBLIC_BASE}/recipes/"):
        return None, f"direct upload returned an unexpected response: {json.dumps(data)[:500]}"
    return url, None


def prepare() -> None:
    item = load_queue()
    validate_queue_identity(item)
    queue_id = str(item["queueId"])
    before = json.dumps(item, sort_keys=True, ensure_ascii=False)

    image_required = item.get("imageRequired", True) is not False
    if not image_required:
        fail("Cooking queue items must require a generated recipe image")

    if item.get("imageStatus") == "ready" and item.get("imageUrl"):
        image_url = str(item["imageUrl"])
        image_type = str(item.get("imageType") or mimetypes.guess_type(image_url)[0] or "")
        if image_type not in ALLOWED_MIME:
            fail("Ready queue item has an unsupported imageType")
        if image_url not in str(item["contentHtml"]):
            fail("Ready queue item does not embed imageUrl in contentHtml")
        verify_public_image(image_url, image_type)
        set_output("queue_changed", "false")
        set_output("queue_id", queue_id)
        set_output("image_url", image_url)
        set_output("image_type", image_type)
        set_output("image_storage", item.get("imageStorage", "existing"))
        set_output("enabled", str(bool(item.get("enabled"))).lower())
        return

    source_path = safe_source_path(item)
    image_type = sniff_mime(source_path)
    expected_source_url = raw_source_url(source_path)
    declared_source_url = str(item.get("imageSourceUrl") or expected_source_url)
    if declared_source_url != expected_source_url:
        fail("imageSourceUrl must match the repository raw URL for imageSourcePath")
    item["imageSourceUrl"] = expected_source_url

    image_url: str | None = None
    storage = ""
    errors: list[str] = []

    image_url, error = try_queue_ingest(queue_id)
    if image_url:
        storage = "r2"
    elif error:
        errors.append(error)

    if not image_url:
        image_url, error = try_direct_upload(queue_id, source_path, image_type)
        if image_url:
            storage = "r2"
        elif error:
            errors.append(error)

    if not image_url:
        image_url = expected_source_url
        storage = "github-raw-fallback"
        warn("R2 upload was unavailable; using the verified repository-hosted generated image. " + " | ".join(errors))

    verify_public_image(image_url, image_type)

    html = str(item["contentHtml"])
    if "{{IMAGE_URL}}" in html:
        html = html.replace("{{IMAGE_URL}}", image_url)
    elif image_url not in html:
        fail("contentHtml must contain {{IMAGE_URL}} while the image is staged")

    item["contentHtml"] = html
    item["imageUrl"] = image_url
    item["imageType"] = image_type
    item["imageStatus"] = "ready"
    item["imageStorage"] = storage
    item["imagePreparedAt"] = utc_now()
    item["enabled"] = bool(item.get("publishWhenReady", True))

    validate_ready_item(item)
    after = json.dumps(item, sort_keys=True, ensure_ascii=False)
    changed = before != after
    if changed:
        save_queue(item)

    set_output("queue_changed", str(changed).lower())
    set_output("queue_id", queue_id)
    set_output("image_url", image_url)
    set_output("image_type", image_type)
    set_output("image_storage", storage)
    set_output("enabled", str(bool(item.get("enabled"))).lower())


def validate_ready_item(item: dict[str, Any]) -> None:
    validate_queue_identity(item)
    if item.get("imageRequired", True) is False:
        fail("Cooking queue items must require an image")
    if item.get("imageStatus") != "ready":
        fail("Recipe imageStatus must be ready before publishing")
    image_url = str(item.get("imageUrl") or "")
    if not image_url.startswith("https://"):
        fail("Recipe imageUrl must be a public HTTPS URL")
    image_type = str(item.get("imageType") or "")
    if image_type not in ALLOWED_MIME:
        fail("Recipe imageType must be image/jpeg, image/png, or image/webp")
    if image_url not in str(item.get("contentHtml") or ""):
        fail("Recipe imageUrl must be embedded in contentHtml")


def invoke_worker(item: dict[str, Any]) -> dict[str, Any]:
    attempts: list[tuple[str, str, bytes | None, dict[str, str]]] = []
    if PUBLISH_API_KEY:
        attempts.append(("authenticated POST", f"{WORKER_BASE}/run", b"", {"Authorization": f"Bearer {PUBLISH_API_KEY}"}))
    attempts.append(("legacy GET", f"{WORKER_BASE}/run", None, {}))
    if not PUBLISH_API_KEY:
        attempts.append(("public POST", f"{WORKER_BASE}/run", b"", {}))

    failures: list[str] = []
    for label, url, body, headers in attempts:
        method = "POST" if body is not None else "GET"
        status, _, response_body = request_bytes(url, method=method, data=body, headers=headers, timeout=60)
        text = response_body.decode("utf-8", errors="replace")
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            failures.append(f"{label}: HTTP {status}, non-JSON response {text[:200]}")
            continue
        if not isinstance(data, dict):
            failures.append(f"{label}: HTTP {status}, non-object JSON")
            continue
        if 200 <= status < 300 and data.get("ok") is True:
            log(f"Worker accepted {label}: {json.dumps(data, ensure_ascii=False)}")
            return data
        failures.append(f"{label}: HTTP {status}, {json.dumps(data, ensure_ascii=False)[:500]}")

    fail("All Worker invocation methods failed: " + " | ".join(failures))


def verify_post_page(post_url: str, image_url: str) -> None:
    if not post_url.startswith("https://"):
        warn("Worker did not return a public post URL")
        return
    last_status = 0
    for attempt in range(1, 5):
        status, _, body = request_bytes(post_url, timeout=45)
        last_status = status
        if status == 200 and body:
            html = body.decode("utf-8", errors="replace")
            if image_url in html:
                log("Public Blogger page contains the recipe image URL.")
            else:
                warn("Public Blogger page loaded, but Blogger may have proxied or rewritten the image URL.")
            return
        if status in {403, 429, 500, 502, 503, 504}:
            time.sleep(min(3 * attempt, 10))
            continue
        break
    warn(f"Public Blogger page verification was rate-limited or unavailable (HTTP {last_status}); the Blogger API result remains authoritative.")


def publish() -> None:
    item = load_queue()
    validate_queue_identity(item)
    queue_id = str(item["queueId"])
    if not item.get("enabled"):
        log("Queue is disabled; nothing to publish.")
        set_output("publish_action", "none")
        set_output("queue_id", queue_id)
        return

    validate_ready_item(item)
    image_url = str(item["imageUrl"])
    image_type = str(item["imageType"])
    verify_public_image(image_url, image_type)

    result = invoke_worker(item)
    action = str(result.get("action") or "")
    reason = str(result.get("reason") or "")
    post_url = str(result.get("url") or "")

    if action == "published":
        if not post_url:
            fail("Worker reported published without a post URL")
    elif action == "none" and "already published" in reason.lower():
        if not post_url:
            fail("Worker reported already published without a post URL")
    else:
        fail(f"Worker did not publish the ready queue item: action={action!r}, reason={reason!r}")

    verify_post_page(post_url, image_url)
    set_output("publish_action", action)
    set_output("queue_id", queue_id)
    set_output("post_url", post_url)
    set_output("image_url", image_url)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("prepare", "publish"))
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            prepare()
        else:
            publish()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()

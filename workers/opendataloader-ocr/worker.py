from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field
from PIL import Image

import opendataloader_pdf

app = FastAPI(title="Nordklart OpenDataLoader OCR", version="1.0.0")

ALLOWED_MIME_TYPES = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}

IMAGE_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}

EXTENSIONS = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

MAX_CLOCK_SKEW_SECONDS = 300


class OcrRequest(BaseModel):
    document_id: str | None = None
    company_id: str | None = None
    file_name: str = Field(min_length=1, max_length=240)
    mime_type: str = Field(min_length=1, max_length=120)
    content_base64: str = Field(min_length=1)
    mode: str = "pdf_or_ocr"
    language_hint: str = "sv,en"


def _secret() -> bytes:
    secret = os.environ.get("OCR_SERVICE_HMAC_SECRET")
    if not secret:
        raise HTTPException(status_code=500, detail="OCR_SERVICE_HMAC_SECRET is not configured")
    return secret.encode("utf-8")


def _max_bytes() -> int:
    raw = os.environ.get("OCR_MAX_FILE_MB", "10")
    try:
        mb = max(1, int(raw))
    except ValueError:
        mb = 10
    return mb * 1024 * 1024


def _verify_signature(raw_body: bytes, timestamp: str | None, signature: str | None) -> None:
    if not timestamp or not signature:
        raise HTTPException(status_code=401, detail="Missing OCR request signature")

    try:
        ts = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid OCR request timestamp") from exc

    if abs(int(time.time()) - ts) > MAX_CLOCK_SKEW_SECONDS:
        raise HTTPException(status_code=401, detail="Expired OCR request timestamp")

    expected = hmac.new(_secret(), f"{timestamp}.".encode("utf-8") + raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=401, detail="Invalid OCR request signature")


def _safe_name(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in name).strip("._")
    return cleaned[:180] or "document"


def _write_input_file(tmp_dir: Path, payload: OcrRequest, data: bytes) -> Path:
    suffix = EXTENSIONS.get(payload.mime_type, ".bin")
    input_path = tmp_dir / f"{_safe_name(payload.file_name)}{suffix}"
    input_path.write_bytes(data)
    if payload.mime_type in IMAGE_MIME_TYPES:
        return _image_to_pdf(input_path)
    return input_path


def _image_to_pdf(image_path: Path) -> Path:
    output_path = image_path.with_suffix(".pdf")
    with Image.open(image_path) as image:
        if getattr(image, "is_animated", False):
            image.seek(0)
        rgb = image.convert("RGB")
        rgb.save(output_path, "PDF", resolution=300.0)
    return output_path


def _read_first(paths: list[Path]) -> str | None:
    for path in paths:
        if path.is_file() and path.stat().st_size > 0:
            return path.read_text(encoding="utf-8", errors="replace")
    return None


def _read_json(paths: list[Path]) -> dict[str, Any] | None:
    for path in paths:
        if not path.is_file() or path.stat().st_size == 0:
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            if isinstance(value, dict):
                return value
            return {"items": value}
        except json.JSONDecodeError:
            continue
    return None


def _infer_page_count(output_json: dict[str, Any] | None) -> int | None:
    if not output_json:
        return None
    for key in ("page_count", "pageCount", "pages"):
        value = output_json.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, list):
            return len(value)
    elements = output_json.get("elements")
    if isinstance(elements, list):
        pages = {element.get("page") for element in elements if isinstance(element, dict) and element.get("page") is not None}
        return len(pages) or None
    return None


def _convert(input_path: Path, output_dir: Path, mode: str) -> tuple[str | None, str | None, dict[str, Any] | None]:
    # OpenDataLoader's Python API writes files to output_dir. Keeping this call
    # narrow avoids binding Nordklart to undocumented internal classes.
    kwargs: dict[str, Any] = {
        "input_path": str(input_path),
        "output_dir": str(output_dir),
        "format": "markdown,json",
    }
    if mode == "force_ocr":
        kwargs["force_ocr"] = True
    try:
        opendataloader_pdf.convert(**kwargs)
    except TypeError:
        # Older/newer builds may not accept force_ocr as a Python kwarg even
        # when the CLI supports hybrid OCR. Retry deterministic local mode
        # instead of failing the whole Nordklart upload flow.
        kwargs.pop("force_ocr", None)
        opendataloader_pdf.convert(**kwargs)

    markdown = _read_first(list(output_dir.rglob("*.md")) + list(output_dir.rglob("*.markdown")))
    text = _read_first(list(output_dir.rglob("*.txt")))
    output_json = _read_json(list(output_dir.rglob("*.json")))
    if not text:
        text = markdown
    return text, markdown, output_json


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "provider": "opendataloader_pdf"}


@app.post("/v1/ocr")
async def run_ocr(
    request: Request,
    x_nordklart_timestamp: str | None = Header(default=None),
    x_nordklart_signature: str | None = Header(default=None),
) -> dict[str, Any]:
    raw_body = await request.body()
    _verify_signature(raw_body, x_nordklart_timestamp, x_nordklart_signature)

    try:
        payload = OcrRequest.model_validate_json(raw_body)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid OCR payload: {exc}") from exc

    if payload.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported mime type: {payload.mime_type}")

    try:
        data = base64.b64decode(payload.content_base64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="content_base64 is not valid base64") from exc

    max_bytes = _max_bytes()
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds OCR_MAX_FILE_MB ({max_bytes // 1024 // 1024} MB)")

    with tempfile.TemporaryDirectory(prefix="nordklart-ocr-") as tmp:
        tmp_dir = Path(tmp)
        output_dir = tmp_dir / "out"
        output_dir.mkdir(parents=True, exist_ok=True)
        input_path = _write_input_file(tmp_dir, payload, data)
        try:
            text, markdown, output_json = _convert(input_path, output_dir, payload.mode)
        except Exception as exc:
            return {
                "status": "failed",
                "provider": "opendataloader_pdf",
                "mode": payload.mode,
                "error_code": "opendataloader_failed",
                "error_message": str(exc),
            }

    page_count = _infer_page_count(output_json)
    return {
        "status": "succeeded",
        "provider": "opendataloader_pdf",
        "mode": payload.mode,
        "text": text,
        "markdown": markdown,
        "json": output_json,
        "page_count": page_count,
        "error_code": None,
        "error_message": None,
    }

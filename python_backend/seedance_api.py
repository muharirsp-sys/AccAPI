# Tujuan: Proxy FastAPI untuk membuat dan membaca task video BytePlus ModelArk Seedance 2.0.
# Caller: Halaman dashboard Next.js `app/(dashboard)/seedance/page.tsx`.
# Dependensi: `requests`, env `BYTEPLUS_ARK_API_KEY`/`ARK_API_KEY`, BytePlus ModelArk Video Generation API.
# Main Functions: `create_seedance_task`, `get_seedance_task`, `seedance_health`, `_byteplus_error_message`.
# Side Effects: HTTP call outbound ke BytePlus ModelArk; menerima data URL/base64 upload dari browser tanpa DB/file I/O.

import os
from typing import Any, Dict, List, Literal, Optional

import requests
from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


BYTEPLUS_BASE_URL = os.getenv(
    "BYTEPLUS_ARK_BASE_URL",
    "https://ark.ap-southeast.bytepluses.com/api/v3",
).rstrip("/")

SEEDANCE_MODELS = {
    "dreamina-seedance-2-0-260128",
    "dreamina-seedance-2-0-fast-260128",
}
SEEDANCE_MAX_REFERENCE_CHARS = int(os.getenv("SEEDANCE_MAX_REFERENCE_CHARS", str(70 * 1024 * 1024)))

router = APIRouter(prefix="/api/seedance", tags=["seedance"])


class SeedanceReference(BaseModel):
    type: Literal["image_url", "video_url", "audio_url"]
    url: str = Field(min_length=1, max_length=SEEDANCE_MAX_REFERENCE_CHARS)
    role: Optional[
        Literal["reference_image", "first_frame", "last_frame", "reference_video", "reference_audio"]
    ] = None


class SeedanceTaskRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=12000)
    model: str = "dreamina-seedance-2-0-fast-260128"
    ratio: str = "16:9"
    duration: int = Field(default=5, ge=1, le=30)
    resolution: str = "720p"
    generate_audio: bool = True
    watermark: bool = False
    return_last_frame: bool = False
    draft: bool = False
    execution_expires_after: int = Field(default=3600, ge=3600, le=259200)
    references: List[SeedanceReference] = Field(default_factory=list)


def _ark_api_key() -> str:
    return (
        os.getenv("BYTEPLUS_ARK_API_KEY")
        or os.getenv("ARK_API_KEY")
        or os.getenv("SEEDANCE_API_KEY")
        or ""
    ).strip()


def _validate_proxy_token(x_seedance_proxy_token: Optional[str]) -> Optional[JSONResponse]:
    expected = os.getenv("SEEDANCE_PROXY_TOKEN", "").strip()
    if expected and x_seedance_proxy_token != expected:
        return JSONResponse({"ok": False, "error": "Seedance proxy token tidak valid."}, status_code=403)
    return None


def _reference_payload(reference: SeedanceReference) -> Dict[str, Any]:
    role = reference.role
    if not role:
        role = {
            "image_url": "reference_image",
            "video_url": "reference_video",
            "audio_url": "reference_audio",
        }[reference.type]

    url_key = reference.type
    return {
        "type": reference.type,
        url_key: {"url": reference.url.strip()},
        "role": role,
    }


def _extract_result(raw: Dict[str, Any]) -> Dict[str, Any]:
    content = raw.get("content") if isinstance(raw.get("content"), dict) else {}
    return {
        "id": raw.get("id"),
        "status": raw.get("status"),
        "video_url": content.get("video_url"),
        "last_frame_url": content.get("last_frame_url"),
        "error": raw.get("error"),
        "raw": raw,
    }


def _byteplus_error_message(raw: Any) -> str:
    if isinstance(raw, dict):
        error = raw.get("error")
        if isinstance(error, dict):
            code = error.get("code") or error.get("type") or ""
            message = error.get("message") or error.get("msg") or ""
            return " - ".join(str(part) for part in [code, message] if part)
        if isinstance(error, str):
            return error
        for key in ("message", "msg", "detail", "code"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return "BytePlus menolak request."


@router.get("/health")
def seedance_health(x_seedance_proxy_token: Optional[str] = Header(default=None)):
    token_error = _validate_proxy_token(x_seedance_proxy_token)
    if token_error:
        return token_error
    return {
        "ok": True,
        "base_url": BYTEPLUS_BASE_URL,
        "has_api_key": bool(_ark_api_key()),
        "models": sorted(SEEDANCE_MODELS),
    }


@router.post("/tasks")
def create_seedance_task(payload: SeedanceTaskRequest, x_seedance_proxy_token: Optional[str] = Header(default=None)):
    token_error = _validate_proxy_token(x_seedance_proxy_token)
    if token_error:
        return token_error

    api_key = _ark_api_key()
    if not api_key:
        return JSONResponse(
            {"ok": False, "error": "BYTEPLUS_ARK_API_KEY / ARK_API_KEY belum diset di environment backend."},
            status_code=500,
        )

    if payload.model not in SEEDANCE_MODELS:
        return JSONResponse({"ok": False, "error": "Model Seedance 2.0 tidak dikenal."}, status_code=400)

    content: List[Dict[str, Any]] = [{"type": "text", "text": payload.prompt.strip()}]
    content.extend(_reference_payload(reference) for reference in payload.references if reference.url.strip())

    request_body = {
        "model": payload.model,
        "content": content,
        "generate_audio": payload.generate_audio,
        "ratio": payload.ratio,
        "duration": payload.duration,
        "resolution": payload.resolution,
        "watermark": payload.watermark,
        "return_last_frame": payload.return_last_frame,
        "draft": payload.draft,
        "execution_expires_after": payload.execution_expires_after,
    }

    try:
        response = requests.post(
            f"{BYTEPLUS_BASE_URL}/contents/generations/tasks",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json=request_body,
            timeout=60,
        )
        raw = response.json()
    except requests.Timeout:
        return JSONResponse({"ok": False, "error": "Request ke BytePlus timeout."}, status_code=504)
    except Exception as exc:
        return JSONResponse({"ok": False, "error": f"Gagal menghubungi BytePlus: {exc}"}, status_code=502)

    if not response.ok:
        return JSONResponse(
            {
                "ok": False,
                "error": _byteplus_error_message(raw),
                "detail": raw,
                "status_code": response.status_code,
            },
            status_code=response.status_code,
        )

    return {"ok": True, "id": raw.get("id"), "raw": raw}


@router.get("/tasks/{task_id}")
def get_seedance_task(task_id: str, x_seedance_proxy_token: Optional[str] = Header(default=None)):
    token_error = _validate_proxy_token(x_seedance_proxy_token)
    if token_error:
        return token_error

    api_key = _ark_api_key()
    if not api_key:
        return JSONResponse(
            {"ok": False, "error": "BYTEPLUS_ARK_API_KEY / ARK_API_KEY belum diset di environment backend."},
            status_code=500,
        )

    safe_task_id = task_id.strip()
    if not safe_task_id.startswith("cgt-") or len(safe_task_id) > 120:
        return JSONResponse({"ok": False, "error": "Task ID Seedance tidak valid."}, status_code=400)

    try:
        response = requests.get(
            f"{BYTEPLUS_BASE_URL}/contents/generations/tasks/{safe_task_id}",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
            timeout=30,
        )
        raw = response.json()
    except requests.Timeout:
        return JSONResponse({"ok": False, "error": "Request status ke BytePlus timeout."}, status_code=504)
    except Exception as exc:
        return JSONResponse({"ok": False, "error": f"Gagal membaca task BytePlus: {exc}"}, status_code=502)

    if not response.ok:
        return JSONResponse(
            {
                "ok": False,
                "error": _byteplus_error_message(raw),
                "detail": raw,
                "status_code": response.status_code,
            },
            status_code=response.status_code,
        )

    return {"ok": True, **_extract_result(raw)}

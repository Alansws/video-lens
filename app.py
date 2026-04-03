#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
HOST = os.environ.get("APP_HOST", "127.0.0.1")
PORT = int(os.environ.get("APP_PORT", "8765"))
OLLAMA_API_BASE = os.environ.get("OLLAMA_API_BASE", "http://127.0.0.1:11434/api")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3-vl:8b")
DEFAULT_OLLAMA_FPS = float(os.environ.get("DEFAULT_OLLAMA_FPS", "1"))
DEFAULT_OLLAMA_MAX_FRAMES = int(os.environ.get("DEFAULT_OLLAMA_MAX_FRAMES", "24"))
DEFAULT_GEMINI_MODEL = os.environ.get("DEFAULT_GEMINI_MODEL", "gemini-2.5-pro")
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "512"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".m4v",
    ".avi",
    ".mkv",
    ".webm",
    ".mpeg",
    ".mpg",
    ".3gp",
    ".ts",
    ".mts",
}


@dataclass
class Job:
    job_id: str
    filename: str
    provider: str
    mode: str
    created_at: str
    stage: str = "queued"
    status: str = "queued"
    logs: list[str] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None
    updated_at: str = field(default_factory=lambda: utc_now())
    completed_items: int = 0
    total_items: int = 0
    current_item_index: int | None = None
    current_item_label: str | None = None


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_float(value: str | None, default: float) -> float:
    try:
        if value is None:
            return default
        parsed = float(value)
        return parsed if parsed > 0 else default
    except (TypeError, ValueError):
        return default


def parse_int(value: str | None, default: int) -> int:
    try:
        if value is None:
            return default
        parsed = int(value)
        return parsed if parsed > 0 else default
    except (TypeError, ValueError):
        return default


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def sanitize_filename(filename: str) -> str:
    clean = Path(filename).name.strip()
    return clean or f"upload-{uuid.uuid4().hex}.bin"


def sanitize_relative_path(filename: str) -> str:
    raw = filename.replace("\\", "/").strip("/")
    parts = [part for part in raw.split("/") if part and part not in {".", ".."}]
    cleaned = "/".join(parts)
    return cleaned or sanitize_filename(filename)


def guess_mime_type(path: Path) -> str:
    mime_type, _ = mimetypes.guess_type(path.name)
    return mime_type or "application/octet-stream"


def is_video_upload(filename: str, content_type: str | None) -> bool:
    if content_type and content_type.startswith("video/"):
        return True
    return Path(filename).suffix.lower() in VIDEO_EXTENSIONS


def infer_batch_label(relative_paths: list[str]) -> str:
    if not relative_paths:
        return "0 videos"
    first_parts = [path.split("/") for path in relative_paths if path]
    if not first_parts:
        return f"{len(relative_paths)} videos"
    root = first_parts[0][0]
    if root and all(parts and parts[0] == root for parts in first_parts):
        return root
    return f"{len(relative_paths)} videos"


def summarize_job_items(job: Job) -> dict[str, int]:
    statuses = [item.get("status") for item in job.items]
    queued = sum(1 for status in statuses if status == "queued")
    running = sum(1 for status in statuses if status == "running")
    completed = sum(1 for status in statuses if status == "completed")
    failed = sum(1 for status in statuses if status == "failed")
    return {
        "total": len(job.items),
        "queued": queued,
        "running": running,
        "completed": completed,
        "failed": failed,
        "processed": completed + failed,
    }


def create_job(filename: str, provider: str, mode: str, items: list[dict[str, Any]]) -> Job:
    job = Job(
        job_id=uuid.uuid4().hex,
        filename=filename,
        provider=provider,
        mode=mode,
        created_at=utc_now(),
        items=items,
        total_items=len(items),
    )
    with jobs_lock:
        jobs[job.job_id] = job
    return job


def get_job(job_id: str) -> Job | None:
    with jobs_lock:
        return jobs.get(job_id)


def serialize_job(job: Job) -> dict[str, Any]:
    return {
        "job_id": job.job_id,
        "filename": job.filename,
        "provider": job.provider,
        "mode": job.mode,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "stage": job.stage,
        "status": job.status,
        "logs": job.logs,
        "items": job.items,
        "result": job.result,
        "error": job.error,
        "total_items": job.total_items,
        "completed_items": job.completed_items,
        "current_item_index": job.current_item_index,
        "current_item_label": job.current_item_label,
        "summary": summarize_job_items(job),
    }


def update_job(job_id: str, **fields: Any) -> None:
    with jobs_lock:
        job = jobs[job_id]
        for key, value in fields.items():
            setattr(job, key, value)
        job.updated_at = utc_now()


def append_job_log(job_id: str, message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    with jobs_lock:
        job = jobs[job_id]
        job.logs.append(f"[{timestamp}] {message}")
        job.updated_at = utc_now()


def append_job_item_log(job_id: str, item_index: int, message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    with jobs_lock:
        job = jobs[job_id]
        item = job.items[item_index]
        line = f"[{timestamp}] {message}"
        item.setdefault("logs", []).append(line)
        label = item.get("relative_path") or item.get("filename") or f"item-{item_index + 1}"
        job.logs.append(f"[{timestamp}] [{label}] {message}")
        job.updated_at = utc_now()


def update_job_item(job_id: str, item_index: int, **fields: Any) -> None:
    with jobs_lock:
        job = jobs[job_id]
        item = job.items[item_index]
        for key, value in fields.items():
            item[key] = value
        job.completed_items = sum(1 for candidate in job.items if candidate.get("status") in {"completed", "failed"})
        job.updated_at = utc_now()


def update_processing_stage(job_id: str, item_index: int, stage: str, *, status: str = "running") -> None:
    with jobs_lock:
        job = jobs[job_id]
        item = job.items[item_index]
        item["stage"] = stage
        item["status"] = status
        job.stage = stage
        job.status = "running"
        job.current_item_index = item_index
        job.current_item_label = item.get("relative_path") or item.get("filename")
        job.updated_at = utc_now()


def mark_job_item_started(job_id: str, item_index: int) -> None:
    update_job_item(
        job_id,
        item_index,
        status="running",
        stage="starting",
        started_at=utc_now(),
        error=None,
        result=None,
    )
    update_processing_stage(job_id, item_index, "starting", status="running")


def mark_job_item_finished(job_id: str, item_index: int, status: str, *, result: dict[str, Any] | None = None, error: str | None = None) -> None:
    final_stage = "completed" if status == "completed" else "failed"
    update_job_item(
        job_id,
        item_index,
        status=status,
        stage=final_stage,
        finished_at=utc_now(),
        result=result,
        error=error,
    )


def read_json_response(response: urllib.response.addinfourl) -> tuple[dict[str, Any], dict[str, str]]:
    payload = response.read()
    text = payload.decode("utf-8") if payload else "{}"
    data = json.loads(text or "{}")
    headers = {key.lower(): value for key, value in response.headers.items()}
    return data, headers


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: int = 600,
) -> tuple[dict[str, Any], dict[str, str]]:
    request = urllib.request.Request(url=url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return read_json_response(response)
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {url}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error for {url}: {exc}") from exc


def request_bytes(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: int = 600,
) -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(url=url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read()
            parsed_headers = {key.lower(): value for key, value in response.headers.items()}
            return data, parsed_headers
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} for {url}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error for {url}: {exc}") from exc


def ollama_tags() -> dict[str, Any]:
    data, _ = request_json(f"{OLLAMA_API_BASE}/tags")
    return data


def ollama_has_model(model_name: str) -> bool:
    tags = ollama_tags()
    for model in tags.get("models", []):
        if model.get("name") == model_name or model.get("model") == model_name:
            return True
    return False


def ollama_generate(payload: dict[str, Any]) -> dict[str, Any]:
    data, _ = request_json(
        f"{OLLAMA_API_BASE}/generate",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json_bytes(payload),
        timeout=1800,
    )
    return data


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        text=True,
        capture_output=True,
        check=True,
    )


def probe_video(video_path: Path) -> dict[str, Any]:
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-of",
            "json",
            "-show_streams",
            "-show_format",
            str(video_path),
        ]
    )
    return json.loads(result.stdout)


def summarize_video_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    streams = metadata.get("streams", [])
    video_stream = next(
        (
            stream
            for stream in streams
            if stream.get("codec_type") == "video" and stream.get("disposition", {}).get("attached_pic") != 1
        ),
        next((stream for stream in streams if stream.get("codec_type") == "video"), {}),
    )
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), {})
    duration = metadata.get("format", {}).get("duration")
    try:
        duration_seconds = round(float(duration), 3) if duration is not None else None
    except ValueError:
        duration_seconds = None
    return {
        "duration_seconds": duration_seconds,
        "video_codec": video_stream.get("codec_name"),
        "audio_codec": audio_stream.get("codec_name"),
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "avg_frame_rate": video_stream.get("avg_frame_rate"),
        "size_bytes": metadata.get("format", {}).get("size"),
    }


def compute_effective_fps(duration_seconds: float | None, requested_fps: float, max_frames: int) -> float:
    if duration_seconds is None or duration_seconds <= 0:
        return requested_fps
    estimated_frames = duration_seconds * requested_fps
    if estimated_frames <= max_frames:
        return requested_fps
    reduced = max_frames / duration_seconds
    return max(0.2, round(reduced, 3))


def extract_frames(video_path: Path, frames_dir: Path, fps: float) -> list[Path]:
    frames_dir.mkdir(parents=True, exist_ok=True)
    run_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(video_path),
            "-vf",
            f"fps={fps}",
            str(frames_dir / "frame_%04d.jpg"),
        ]
    )
    frames = sorted(frames_dir.glob("frame_*.jpg"))
    if not frames:
        raise RuntimeError("No frames were extracted from the video.")
    return frames


def read_images_as_base64(image_paths: list[Path]) -> list[str]:
    return [base64.b64encode(path.read_bytes()).decode("ascii") for path in image_paths]


def build_ollama_prompt(custom_prompt: str, frame_count: int, fps: float) -> str:
    base = (
        f"你将收到来自同一段视频的连续关键帧，共 {frame_count} 帧，"
        f"采样率约为 {fps:.3g} FPS。请只根据画面内容分析，不要使用音频，不要臆测未展示的信息。"
        "请用中文输出四部分：1. 总结 2. 按时间顺序的关键变化 "
        "3. 场景/人物/物体/动作 4. 不确定点。"
    )
    if custom_prompt.strip():
        return f"{base}\n\n用户补充要求：{custom_prompt.strip()}"
    return base


def build_gemini_prompt(custom_prompt: str) -> str:
    base = (
        "请分析这个视频的视觉内容。若模型可访问音频，也请把音频相关信息与画面信息区分开写。"
        "请用中文输出四部分：1. 总结 2. 按时间顺序的关键变化 "
        "3. 场景/人物/物体/动作 4. 不确定点。不要臆测未展示的信息。"
    )
    if custom_prompt.strip():
        return f"{base}\n\n用户补充要求：{custom_prompt.strip()}"
    return base


def strip_explanatory_footer(text: str) -> str:
    cleaned = text.strip()
    if not cleaned:
        return cleaned

    footer_heading = re.search(r"(?:\n|^)\s*方式说明\s*$", cleaned, flags=re.MULTILINE)
    if footer_heading:
        tail = cleaned[footer_heading.start():]
        if any(marker in tail for marker in ("Ollama 当前公开接口", "自动抽帧", "images 数组", "video 文件")):
            cleaned = cleaned[:footer_heading.start()].rstrip()

    filtered_lines: list[str] = []
    for line in cleaned.splitlines():
        normalized = line.strip()
        if not normalized:
            filtered_lines.append(line)
            continue
        if "Ollama 当前公开接口是 images 数组，不是直接 video 文件" in normalized:
            continue
        if "这个结果来自自动抽帧后送入 Qwen3-VL" in normalized:
            continue
        filtered_lines.append(line)

    return "\n".join(filtered_lines).strip()


def extract_text_from_gemini_response(response: dict[str, Any]) -> str:
    texts: list[str] = []
    for candidate in response.get("candidates", []):
        content = candidate.get("content", {})
        for part in content.get("parts", []):
            text = part.get("text")
            if text:
                texts.append(text)
    if not texts:
        raise RuntimeError(f"Gemini returned no text candidates: {json.dumps(response, ensure_ascii=False)}")
    return strip_explanatory_footer("\n".join(texts))


def extract_text_from_ollama_response(response: dict[str, Any]) -> str:
    content = response.get("response", "")
    if not content:
        raise RuntimeError(f"Ollama returned no content: {json.dumps(response, ensure_ascii=False)}")
    return strip_explanatory_footer(content)


def normalize_gemini_file(payload: dict[str, Any]) -> dict[str, Any]:
    return payload.get("file", payload)


def gemini_upload_file(api_key: str, file_path: Path, mime_type: str) -> dict[str, Any]:
    upload_start_url = f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={urllib.parse.quote(api_key)}"
    num_bytes = file_path.stat().st_size
    metadata_body = json_bytes({"file": {"display_name": file_path.name}})
    _, headers = request_bytes(
        upload_start_url,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(num_bytes),
            "X-Goog-Upload-Header-Content-Type": mime_type,
            "x-goog-api-key": api_key,
        },
        body=metadata_body,
    )
    upload_url = headers.get("x-goog-upload-url")
    if not upload_url:
        raise RuntimeError("Gemini Files API did not return an upload URL.")
    data, _ = request_json(
        upload_url,
        method="POST",
        headers={
            "Content-Length": str(num_bytes),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
        },
        body=file_path.read_bytes(),
        timeout=1800,
    )
    file_info = normalize_gemini_file(data)
    if not file_info:
        raise RuntimeError(f"Gemini upload response did not include file info: {json.dumps(data, ensure_ascii=False)}")
    return file_info


def gemini_get_file(api_key: str, file_name: str) -> dict[str, Any]:
    encoded_name = urllib.parse.quote(file_name, safe="/")
    data, _ = request_json(
        f"https://generativelanguage.googleapis.com/v1beta/{encoded_name}?key={urllib.parse.quote(api_key)}",
        headers={"x-goog-api-key": api_key},
    )
    return normalize_gemini_file(data)


def gemini_delete_file(api_key: str, file_name: str) -> None:
    encoded_name = urllib.parse.quote(file_name, safe="/")
    request_bytes(
        f"https://generativelanguage.googleapis.com/v1beta/{encoded_name}?key={urllib.parse.quote(api_key)}",
        method="DELETE",
        headers={"x-goog-api-key": api_key},
    )


def gemini_wait_until_ready(api_key: str, file_name: str, job_id: str, item_index: int, timeout_seconds: int = 900) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        data = gemini_get_file(api_key, file_name)
        state = data.get("state")
        if state == "ACTIVE":
            return data
        if state == "FAILED":
            raise RuntimeError(f"Gemini file processing failed: {json.dumps(data, ensure_ascii=False)}")
        append_job_item_log(job_id, item_index, f"Gemini 正在处理视频文件，当前状态: {state or 'UNKNOWN'}")
        time.sleep(2)
    raise RuntimeError("Timed out while waiting for Gemini to process the uploaded video.")


def gemini_generate_content(api_key: str, model: str, file_uri: str, mime_type: str, prompt: str) -> dict[str, Any]:
    payload = {
        "contents": [
            {
                "parts": [
                    {"file_data": {"mime_type": mime_type, "file_uri": file_uri}},
                    {"text": prompt},
                ]
            }
        ]
    }
    data, _ = request_json(
        f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model)}:generateContent?key={urllib.parse.quote(api_key)}",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        body=json_bytes(payload),
        timeout=1800,
    )
    return data


def run_ollama_pipeline(
    *,
    job_id: str,
    item_index: int,
    video_path: Path,
    custom_prompt: str,
    requested_fps: float,
    max_frames: int,
) -> dict[str, Any]:
    if not ollama_has_model(OLLAMA_MODEL):
        raise RuntimeError(f"Local Ollama model {OLLAMA_MODEL} is not available.")

    append_job_item_log(job_id, item_index, f"确认本地模型 {OLLAMA_MODEL} 可用")
    update_processing_stage(job_id, item_index, "probing")
    append_job_item_log(job_id, item_index, "读取视频元数据")
    metadata = probe_video(video_path)
    summary = summarize_video_metadata(metadata)

    duration_seconds = summary.get("duration_seconds")
    effective_fps = compute_effective_fps(duration_seconds, requested_fps, max_frames)
    append_job_item_log(job_id, item_index, f"计划按 {effective_fps:.3g} FPS 抽帧，最多约 {max_frames} 帧")

    update_processing_stage(job_id, item_index, "extracting_frames")
    frames_dir = Path(tempfile.mkdtemp(prefix="video-lens-frames-"))
    try:
        frame_paths = extract_frames(video_path, frames_dir, effective_fps)
        if len(frame_paths) > max_frames:
            frame_paths = frame_paths[:max_frames]
        append_job_item_log(job_id, item_index, f"已抽取 {len(frame_paths)} 张关键帧")
        images = read_images_as_base64(frame_paths)
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)

    prompt = build_ollama_prompt(custom_prompt, len(images), effective_fps)
    update_processing_stage(job_id, item_index, "calling_ollama")
    append_job_item_log(job_id, item_index, "向本地 Ollama 发送关键帧并等待分析结果")
    started_at = time.perf_counter()
    response = ollama_generate(
        {
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "images": images,
            "stream": False,
            "keep_alive": "30m",
        }
    )
    elapsed = time.perf_counter() - started_at
    analysis = extract_text_from_ollama_response(response)
    return {
        "provider": "ollama",
        "provider_label": "Ollama",
        "analysis": analysis,
        "model": OLLAMA_MODEL,
        "video": summary,
        "prompt_used": prompt,
        "requested_fps": requested_fps,
        "effective_fps": effective_fps,
        "frame_count": len(images),
        "processing_seconds": round(elapsed, 2),
        "durations": {
            "total_duration_ns": response.get("total_duration"),
            "load_duration_ns": response.get("load_duration"),
            "prompt_eval_count": response.get("prompt_eval_count"),
            "eval_count": response.get("eval_count"),
        },
    }


def run_gemini_pipeline(
    *,
    job_id: str,
    item_index: int,
    video_path: Path,
    custom_prompt: str,
    api_key: str,
    model_name: str,
) -> dict[str, Any]:
    if not api_key.strip():
        raise RuntimeError("Gemini provider requires an API key.")

    mime_type = guess_mime_type(video_path)
    append_job_item_log(job_id, item_index, f"准备把视频直接上传到 Gemini Files API，模型 {model_name}")
    update_processing_stage(job_id, item_index, "uploading_video")
    uploaded_file = gemini_upload_file(api_key, video_path, mime_type)
    file_name = uploaded_file.get("name")
    file_uri = uploaded_file.get("uri")
    if not file_name or not file_uri:
        raise RuntimeError(f"Gemini upload succeeded but response was incomplete: {json.dumps(uploaded_file, ensure_ascii=False)}")

    append_job_item_log(job_id, item_index, "视频已上传，等待 Gemini 完成服务端视频处理")
    update_processing_stage(job_id, item_index, "processing_video")
    ready_file = gemini_wait_until_ready(api_key, file_name, job_id, item_index)
    file_uri = ready_file.get("uri", file_uri)

    prompt = build_gemini_prompt(custom_prompt)
    append_job_item_log(job_id, item_index, "Gemini 视频文件就绪，开始生成分析结果")
    update_processing_stage(job_id, item_index, "calling_gemini")
    started_at = time.perf_counter()
    try:
        response = gemini_generate_content(
            api_key=api_key,
            model=model_name,
            file_uri=file_uri,
            mime_type=mime_type,
            prompt=prompt,
        )
        analysis = extract_text_from_gemini_response(response)
    finally:
        try:
            gemini_delete_file(api_key, file_name)
            append_job_item_log(job_id, item_index, "Gemini 临时视频文件已删除")
        except Exception:
            append_job_item_log(job_id, item_index, "Gemini 临时视频文件删除失败，系统会在 48 小时后自动删除")
    elapsed = time.perf_counter() - started_at
    return {
        "provider": "gemini",
        "provider_label": "Gemini",
        "analysis": analysis,
        "model": model_name,
        "video": {
            "mime_type": mime_type,
            "display_name": video_path.name,
            "remote_file": {
                "name": ready_file.get("name"),
                "uri": ready_file.get("uri"),
                "state": ready_file.get("state"),
                "size_bytes": ready_file.get("sizeBytes"),
                "video_metadata": ready_file.get("videoMetadata"),
            },
        },
        "prompt_used": prompt,
        "processing_seconds": round(elapsed, 2),
    }


def build_job_result(job_id: str, provider: str, mode: str, total_seconds: float) -> dict[str, Any]:
    with jobs_lock:
        job = jobs[job_id]
        summary = summarize_job_items(job)
        if mode == "single" and job.items:
            first_result = job.items[0].get("result")
            if first_result:
                first_result["job_seconds_total"] = round(total_seconds, 2)
                return first_result
        return {
            "kind": mode,
            "provider": provider,
            "provider_label": "Ollama" if provider == "ollama" else "Gemini",
            "job_seconds_total": round(total_seconds, 2),
            "summary": summary,
        }


def process_job(job_id: str, uploads: list[dict[str, Any]], options: dict[str, str], temp_root: Path) -> None:
    started = time.perf_counter()
    provider = options.get("provider", "ollama")
    mode = options.get("scope", "single")
    append_job_log(job_id, f"收到 {len(uploads)} 个视频，开始顺序处理")
    update_job(job_id, stage="starting", status="running")

    try:
        for item_index, upload in enumerate(uploads):
            mark_job_item_started(job_id, item_index)
            append_job_item_log(job_id, item_index, "开始处理")
            item_started = time.perf_counter()
            try:
                if provider == "gemini":
                    result = run_gemini_pipeline(
                        job_id=job_id,
                        item_index=item_index,
                        video_path=upload["path"],
                        custom_prompt=options.get("prompt", ""),
                        api_key=options.get("gemini_api_key", ""),
                        model_name=options.get("gemini_model", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL,
                    )
                else:
                    result = run_ollama_pipeline(
                        job_id=job_id,
                        item_index=item_index,
                        video_path=upload["path"],
                        custom_prompt=options.get("prompt", ""),
                        requested_fps=parse_float(options.get("fps"), DEFAULT_OLLAMA_FPS),
                        max_frames=parse_int(options.get("max_frames"), DEFAULT_OLLAMA_MAX_FRAMES),
                    )
                result["job_seconds_total"] = round(time.perf_counter() - item_started, 2)
                mark_job_item_finished(job_id, item_index, "completed", result=result)
                append_job_item_log(job_id, item_index, "分析完成")
            except Exception as exc:
                traceback.print_exc()
                mark_job_item_finished(job_id, item_index, "failed", error=str(exc))
                append_job_item_log(job_id, item_index, f"失败: {exc}")
            finally:
                try:
                    upload["path"].unlink(missing_ok=True)
                except Exception:
                    pass

        total_seconds = time.perf_counter() - started
        update_job(
            job_id,
            stage="completed",
            status=final_job_status(job_id),
            current_item_index=None,
            current_item_label=None,
            result=build_job_result(job_id, provider, mode, total_seconds),
        )
        append_job_log(job_id, "全部任务处理完成")
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, stage="failed", status="failed", error=str(exc))
        append_job_log(job_id, f"任务失败: {exc}")
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


def final_job_status(job_id: str) -> str:
    job = get_job(job_id)
    if not job:
        return "failed"
    summary = summarize_job_items(job)
    if summary["failed"] == 0:
        return "completed"
    if summary["completed"] == 0:
        return "failed"
    return "completed_with_errors"


def parse_multipart_form(content_type: str, body: bytes) -> tuple[dict[str, str], dict[str, list[dict[str, Any]]]]:
    raw_message = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
    message = BytesParser(policy=default).parsebytes(raw_message)
    if not message.is_multipart():
        raise ValueError("Request is not multipart/form-data.")

    fields: dict[str, str] = {}
    files: dict[str, list[dict[str, Any]]] = {}

    for part in message.iter_parts():
        disposition = part.get_content_disposition()
        if disposition != "form-data":
            continue
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if not name:
            continue
        if filename:
            relative_path = sanitize_relative_path(filename)
            files.setdefault(name, []).append(
                {
                    "filename": sanitize_filename(filename),
                    "relative_path": relative_path,
                    "content_type": part.get_content_type(),
                    "data": payload,
                }
            )
        else:
            charset = part.get_content_charset() or "utf-8"
            fields[name] = payload.decode(charset, errors="replace")

    return fields, files


def write_uploads_to_temp(files: list[dict[str, Any]]) -> tuple[Path, list[dict[str, Any]]]:
    temp_root = Path(tempfile.mkdtemp(prefix="video-lens-batch-"))
    uploads: list[dict[str, Any]] = []
    for index, upload in enumerate(files):
        suffix = Path(upload["filename"]).suffix or ".bin"
        temp_path = temp_root / f"{index:04d}-{uuid.uuid4().hex}{suffix}"
        temp_path.write_bytes(upload["data"])
        uploads.append(
            {
                "path": temp_path,
                "filename": upload["filename"],
                "relative_path": upload["relative_path"],
                "content_type": upload.get("content_type"),
            }
        )
    return temp_root, uploads


def build_job_items(uploads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "item_id": uuid.uuid4().hex,
            "filename": upload["filename"],
            "relative_path": upload["relative_path"],
            "status": "queued",
            "stage": "queued",
            "logs": [],
            "result": None,
            "error": None,
            "started_at": None,
            "finished_at": None,
        }
        for upload in uploads
    ]


class AppHandler(BaseHTTPRequestHandler):
    server_version = "VideoLens/1.0"

    def do_GET(self) -> None:
        if self.path in {"/", "/index.html"}:
            self.serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
            return
        if self.path.startswith("/static/"):
            path = STATIC_DIR / self.path.removeprefix("/static/")
            if path.is_file():
                self.serve_file(path, mimetypes.guess_type(path.name)[0] or "application/octet-stream")
                return
        if self.path == "/api/config":
            self.handle_config()
            return
        if self.path.startswith("/api/jobs/"):
            self.handle_job_status()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        if self.path == "/api/analyze":
            self.handle_analyze()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def log_message(self, format: str, *args: Any) -> None:
        return

    def serve_file(self, path: Path, content_type: str) -> None:
        resolved = path.resolve()
        if STATIC_DIR.resolve() not in resolved.parents and resolved != STATIC_DIR.resolve():
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden")
            return
        data = resolved.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_request_body(self) -> bytes:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise ValueError("Empty request body.")
        if content_length > MAX_UPLOAD_BYTES:
            raise ValueError(f"Upload too large. Limit is {MAX_UPLOAD_MB} MB.")
        return self.rfile.read(content_length)

    def handle_config(self) -> None:
        ollama_ready = False
        ollama_error = None
        try:
            ollama_ready = ollama_has_model(OLLAMA_MODEL)
        except Exception as exc:
            ollama_error = str(exc)
        self.send_json(
            {
                "app_name": "Video Lens",
                "providers": {
                    "ollama": {
                        "model": OLLAMA_MODEL,
                        "ready": ollama_ready,
                        "error": ollama_error,
                        "default_fps": DEFAULT_OLLAMA_FPS,
                        "default_max_frames": DEFAULT_OLLAMA_MAX_FRAMES,
                    },
                "gemini": {
                        "model": DEFAULT_GEMINI_MODEL,
                        "ready": True,
                        "note": "Requires a user-supplied Gemini API key.",
                    },
                },
            }
        )

    def handle_job_status(self) -> None:
        job_id = self.path.rsplit("/", 1)[-1]
        job = get_job(job_id)
        if not job:
            self.send_json({"error": "Job not found."}, status=HTTPStatus.NOT_FOUND)
            return
        self.send_json({"job": serialize_job(job)})

    def handle_analyze(self) -> None:
        try:
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                raise ValueError("Expected multipart/form-data upload.")

            body = self.read_request_body()
            fields, files = parse_multipart_form(content_type, body)
            scope = (fields.get("scope") or "single").strip().lower()
            provider = (fields.get("provider") or "ollama").strip().lower()

            raw_uploads = files.get("videos", []) + files.get("video", [])
            uploads = [upload for upload in raw_uploads if is_video_upload(upload["filename"], upload.get("content_type"))]
            if not uploads:
                raise ValueError("No video files were uploaded.")

            if scope == "single":
                uploads = uploads[:1]
            else:
                uploads = sorted(uploads, key=lambda upload: upload["relative_path"].lower())

            temp_root, upload_specs = write_uploads_to_temp(uploads)
            items = build_job_items(upload_specs)
            if scope == "single":
                job_label = upload_specs[0]["filename"]
            else:
                job_label = infer_batch_label([upload["relative_path"] for upload in upload_specs])

            job = create_job(filename=job_label, provider=provider, mode=scope, items=items)
            thread = threading.Thread(
                target=process_job,
                args=(job.job_id, upload_specs, fields, temp_root),
                daemon=True,
            )
            thread.start()
            self.send_json({"job_id": job.job_id, "job": serialize_job(job)}, status=HTTPStatus.ACCEPTED)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            traceback.print_exc()
            self.send_json({"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Video Lens running at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()

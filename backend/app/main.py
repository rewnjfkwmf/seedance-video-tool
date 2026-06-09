from __future__ import annotations

import json
import os
import shutil
import subprocess
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("SEEDANCE_DATA_DIR", str(BASE_DIR / "data"))).resolve()
JOBS_DIR = DATA_DIR / "jobs"
CORS_ORIGINS_RAW = os.getenv("SEEDANCE_CORS_ORIGINS", "*").strip()

ALLOWED_ANALYSIS_MODES = {"fast", "detail"}


def parse_cors_origins(raw: str) -> list[str]:
    if not raw or raw == "*":
        return ["*"]
    return [item.strip() for item in raw.split(",") if item.strip()]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def format_time(seconds: float) -> str:
    safe = max(0.0, float(seconds))
    mins = int(safe // 60)
    secs = safe % 60
    return f"{mins:02d}:{secs:04.1f}"


def run_command(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        check=False,
    )


@dataclass
class ShotScript:
    index: int
    time: str
    visual: str
    camera_motion: str
    voiceover: str


@dataclass
class SegmentResult:
    index: int
    label: str
    time: str
    shot_range: str
    visuals: str
    camera_motion: str
    voiceover: str
    copy_prompt: str
    shots: list[ShotScript] = field(default_factory=list)


@dataclass
class JobRecord:
    job_id: str
    status: Literal["queued", "processing", "completed", "failed"]
    created_at: str
    updated_at: str
    filename: str
    analysis_mode: str
    segment_max_seconds: int
    video_path: str
    error: str | None = None
    result: dict[str, Any] | None = None


class JobCreatedResponse(BaseModel):
    job_id: str
    status: str
    status_url: str
    result_url: str


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    created_at: str
    updated_at: str
    filename: str
    analysis_mode: str
    segment_max_seconds: int
    error: str | None = None
    result_ready: bool = False


class HealthResponse(BaseModel):
    status: str = "ok"
    ffmpeg: bool
    ffprobe: bool


def get_job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def get_job_meta_path(job_id: str) -> Path:
    return get_job_dir(job_id) / "job.json"


def save_job(job: JobRecord) -> None:
    job.updated_at = utc_now()
    job_dir = get_job_dir(job.job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    get_job_meta_path(job.job_id).write_text(
        json.dumps(asdict(job), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_job(job_id: str) -> JobRecord:
    meta_path = get_job_meta_path(job_id)
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="任务不存在")
    payload = json.loads(meta_path.read_text(encoding="utf-8"))
    return JobRecord(**payload)


def check_binary_available(name: str) -> bool:
    result = run_command([name, "-version"])
    return result.returncode == 0


def probe_video(video_path: Path) -> dict[str, Any]:
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(video_path),
        ]
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffprobe 探测失败")

    payload = json.loads(result.stdout or "{}")
    duration = float(payload.get("format", {}).get("duration", 0) or 0)
    video_stream = next(
        (stream for stream in payload.get("streams", []) if stream.get("codec_type") == "video"),
        {},
    )

    return {
        "duration": duration,
        "width": int(video_stream.get("width") or 0),
        "height": int(video_stream.get("height") or 0),
        "codec": video_stream.get("codec_name") or "",
    }


def detect_shot_boundaries(video_path: Path, threshold: float = 0.25) -> list[float]:
    result = run_command(
        [
            "ffmpeg",
            "-i",
            str(video_path),
            "-filter:v",
            f"select='gt(scene,{threshold})',showinfo",
            "-vsync",
            "vfr",
            "-f",
            "null",
            "-",
        ]
    )
    raw = f"{result.stdout}\n{result.stderr}"
    times: list[float] = []

    for line in raw.splitlines():
        if "pts_time:" not in line:
            continue
        try:
            value = float(line.split("pts_time:")[1].split()[0])
        except (IndexError, ValueError):
            continue
        times.append(value)

    deduped: list[float] = []
    for item in sorted(times):
        if not deduped or abs(item - deduped[-1]) >= 0.8:
            deduped.append(item)
    return deduped


def build_shots(duration: float, boundaries: list[float]) -> list[dict[str, float | int]]:
    points = [0.0, *[value for value in boundaries if 0 < value < duration], duration]
    shots: list[dict[str, float | int]] = []
    for idx in range(len(points) - 1):
        start = points[idx]
        end = points[idx + 1]
        if end - start < 0.3:
            continue
        shots.append({"index": len(shots) + 1, "start": start, "end": end})
    return shots


def pack_segments(shots: list[dict[str, float | int]], max_seconds: int) -> list[list[dict[str, float | int]]]:
    segments: list[list[dict[str, float | int]]] = []
    current: list[dict[str, float | int]] = []
    current_start = 0.0

    for shot in shots:
        start = float(shot["start"])
        end = float(shot["end"])
        if not current:
            current = [shot]
            current_start = start
            continue

        if end - current_start <= max_seconds:
            current.append(shot)
        else:
            segments.append(current)
            current = [shot]
            current_start = start

    if current:
        segments.append(current)

    return segments


def infer_visual(position: int, total: int, shot_duration: float) -> str:
    if position == 0:
        return "开场环境或主体引入镜头，先交代场景，再把注意力带到主体上。"
    if position == total - 1:
        return "收尾展示镜头，保留主体最终状态或结果画面，形成结束感。"
    if shot_duration >= 4:
        return "主体持续展示镜头，突出产品外观、摆放状态或使用场景。"
    if shot_duration <= 1:
        return "快切补充镜头，用来强化信息、情绪或卖点。"
    return "承接前后内容的产品展示镜头，保持与原视频一致的画面顺序。"


def infer_camera_motion(position: int, shot_duration: float) -> str:
    if position == 0:
        return "轻微推进，先交代环境再进入主体。"
    if shot_duration <= 1:
        return "快切插入镜头，短暂停留后立即切到下一个画面。"
    if shot_duration <= 2.2:
        return "近景停留或轻微推近，节奏紧凑。"
    return "中近景平稳展示，镜头自然承接前后镜头。"


def infer_voiceover(position: int, total: int) -> str:
    if position == 0:
        return "先把开场氛围立住，再把注意力引到主体上。"
    if position == total - 1:
        return "这一镜负责把这一段自然收住，并形成最后记忆点。"
    return "延续上一镜头的展示逻辑，把卖点继续往下讲。"


def build_segment_prompt(segment: SegmentResult) -> str:
    return "\n".join(
        [
            segment.label,
            f"时间：{segment.time}",
            "画面：",
            segment.visuals,
            "镜头运动：",
            segment.camera_motion,
            "旁白：",
            segment.voiceover,
        ]
    )


def build_result(video_path: Path, analysis_mode: str, segment_max_seconds: int) -> dict[str, Any]:
    metadata = probe_video(video_path)
    boundaries = detect_shot_boundaries(video_path)
    shots = build_shots(metadata["duration"], boundaries)
    grouped = pack_segments(shots, segment_max_seconds)

    segments: list[SegmentResult] = []
    for segment_idx, shot_group in enumerate(grouped, start=1):
        shot_scripts: list[ShotScript] = []
        for position, shot in enumerate(shot_group):
            start = float(shot["start"])
            end = float(shot["end"])
            shot_scripts.append(
                ShotScript(
                    index=int(shot["index"]),
                    time=f"{format_time(start)}-{format_time(end)}",
                    visual=infer_visual(position, len(shot_group), end - start),
                    camera_motion=infer_camera_motion(position, end - start),
                    voiceover=infer_voiceover(position, len(shot_group)),
                )
            )

        visuals = "\n".join(f"{idx + 1}. {shot.visual}" for idx, shot in enumerate(shot_scripts))
        camera_motion = "\n".join(f"{idx + 1}. {shot.camera_motion}" for idx, shot in enumerate(shot_scripts))
        voiceover = "".join(shot.voiceover for shot in shot_scripts)
        time_range = f"{format_time(float(shot_group[0]['start']))}-{format_time(float(shot_group[-1]['end']))}"

        segment = SegmentResult(
            index=segment_idx,
            label=f"段落{['一','二','三','四','五','六','七','八','九','十'][segment_idx - 1] if segment_idx <= 10 else segment_idx}",
            time=time_range,
            shot_range=f"{shot_scripts[0].index}-{shot_scripts[-1].index}",
            visuals=visuals,
            camera_motion=camera_motion,
            voiceover=voiceover,
            copy_prompt="",
            shots=shot_scripts,
        )
        segment.copy_prompt = build_segment_prompt(segment)
        segments.append(segment)

    return {
        "meta": {
            "analysis_mode": analysis_mode,
            "segment_max_seconds": segment_max_seconds,
            "duration_seconds": metadata["duration"],
            "width": metadata["width"],
            "height": metadata["height"],
            "codec": metadata["codec"],
            "original_shot_count": len(shots),
            "segment_count": len(segments),
            "note": "当前后端骨架已接通 ffprobe/ffmpeg，但画面理解仍是规则生成，下一步建议接入多模态模型。",
        },
        "segments": [
            {
                "index": item.index,
                "label": item.label,
                "time": item.time,
                "shot_range": item.shot_range,
                "visuals": item.visuals,
                "camera_motion": item.camera_motion,
                "voiceover": item.voiceover,
                "copy_prompt": item.copy_prompt,
                "shots": [asdict(shot) for shot in item.shots],
            }
            for item in segments
        ],
    }


def process_job(job_id: str) -> None:
    job = load_job(job_id)
    job.status = "processing"
    save_job(job)

    try:
        video_path = Path(job.video_path)
        job.result = build_result(
            video_path=video_path,
            analysis_mode=job.analysis_mode,
            segment_max_seconds=job.segment_max_seconds,
        )
        job.status = "completed"
        job.error = None
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
    finally:
        save_job(job)


app = FastAPI(title="Seedance Backend Skeleton", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=parse_cors_origins(CORS_ORIGINS_RAW),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def ensure_dirs() -> None:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        ffmpeg=check_binary_available("ffmpeg"),
        ffprobe=check_binary_available("ffprobe"),
    )


@app.post("/api/jobs", response_model=JobCreatedResponse, status_code=202)
async def create_job(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    analysis_mode: str = Form("fast"),
    segment_max_seconds: int = Form(15),
) -> JobCreatedResponse:
    if analysis_mode not in ALLOWED_ANALYSIS_MODES:
        raise HTTPException(status_code=400, detail="analysis_mode 只能是 fast 或 detail")

    if segment_max_seconds < 5 or segment_max_seconds > 15:
        raise HTTPException(status_code=400, detail="segment_max_seconds 必须在 5 到 15 之间")

    job_id = uuid.uuid4().hex
    job_dir = get_job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "upload.mp4").suffix or ".mp4"
    target_path = job_dir / f"input{suffix}"
    with target_path.open("wb") as output:
        shutil.copyfileobj(file.file, output)

    job = JobRecord(
        job_id=job_id,
        status="queued",
        created_at=utc_now(),
        updated_at=utc_now(),
        filename=file.filename or target_path.name,
        analysis_mode=analysis_mode,
        segment_max_seconds=segment_max_seconds,
        video_path=str(target_path),
    )
    save_job(job)
    background_tasks.add_task(process_job, job_id)

    return JobCreatedResponse(
        job_id=job_id,
        status=job.status,
        status_url=f"/api/jobs/{job_id}",
        result_url=f"/api/jobs/{job_id}/result",
    )


@app.get("/api/jobs/{job_id}", response_model=JobStatusResponse)
def get_job(job_id: str) -> JobStatusResponse:
    job = load_job(job_id)
    return JobStatusResponse(
        job_id=job.job_id,
        status=job.status,
        created_at=job.created_at,
        updated_at=job.updated_at,
        filename=job.filename,
        analysis_mode=job.analysis_mode,
        segment_max_seconds=job.segment_max_seconds,
        error=job.error,
        result_ready=job.result is not None and job.status == "completed",
    )


@app.get("/api/jobs/{job_id}/result")
def get_job_result(job_id: str) -> JSONResponse:
    job = load_job(job_id)
    if job.status == "failed":
        raise HTTPException(status_code=500, detail=job.error or "任务执行失败")
    if job.status != "completed" or not job.result:
        raise HTTPException(status_code=409, detail="任务尚未完成")
    return JSONResponse(content=job.result)

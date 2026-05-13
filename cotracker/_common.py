"""Shared CoTracker3 helpers used by both Cloud Function and local MPS server.

Protocol:
  POST { video: base64 MP4/WebM, queries: [{pointId, frameIdx, x, y}], resolution?: 'native'|'512' }
  →   { videoWidth, videoHeight, numFrames, points: { pointId: [[x,y], ...] }, executionTimeMs }

`resolution` controls the inference resolution :
  - 'native' (default) : video décodée en résolution native
  - '512'              : downscale isotrope pour que le côté long ≤ 512 px

Les coordonnées des `queries` et les tracks retournés sont toujours exprimés dans
la résolution **originale** de la vidéo. Le scaling interne est transparent pour
le client.
"""

from __future__ import annotations
import base64
import io
import os
import tempfile
from collections import defaultdict
from typing import Any

import cv2  # type: ignore[import-untyped]
import numpy as np
import torch

MAX_FRAMES = 1000
MAX_VIDEO_BYTES = 50 * 1024 * 1024


def validate_payload(payload: dict[str, Any]) -> None:
    if "video" not in payload:
        raise ValueError("Missing 'video' field")
    if "queries" not in payload or not isinstance(payload["queries"], list):
        raise ValueError("Missing or invalid 'queries' field")
    if len(payload["queries"]) == 0:
        raise ValueError("No queries provided")


def resolve_max_long_side(resolution: Any) -> int | None:
    """Map the `resolution` payload field to an optional max-long-side cap (px)."""
    if resolution is None or resolution == "native":
        return None
    if resolution == "512" or resolution == 512:
        return 512
    raise ValueError(f"Unknown resolution mode: {resolution!r} (expected 'native' or '512')")


def decode_video(
    video_b64: str,
    max_long_side: int | None = None,
) -> tuple[np.ndarray, int, int, int, int, int]:
    """Decode base64 video.

    Returns (frames T×H_proc×W_proc×3 RGB uint8, h_proc, w_proc, num_frames, h_orig, w_orig).
    Si `max_long_side` est défini et que le côté long de la vidéo dépasse cette
    valeur, chaque frame est downscale isotrope avec INTER_AREA.
    """
    data = base64.b64decode(video_b64)
    if len(data) > MAX_VIDEO_BYTES:
        raise ValueError(f"Video too large: {len(data) / 1024 / 1024:.1f} MB > 50 MB")

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(data)
        path = f.name

    try:
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            raise ValueError("Failed to open video")
        w_orig = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h_orig = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # Compute downscaled size if requested.
        w_proc, h_proc = w_orig, h_orig
        if max_long_side is not None and max(w_orig, h_orig) > max_long_side:
            scale = max_long_side / max(w_orig, h_orig)
            w_proc = max(1, int(round(w_orig * scale)))
            h_proc = max(1, int(round(h_orig * scale)))

        frames: list[np.ndarray] = []
        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                break
            if (w_proc, h_proc) != (w_orig, h_orig):
                frame_bgr = cv2.resize(frame_bgr, (w_proc, h_proc), interpolation=cv2.INTER_AREA)
            frames.append(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
            if len(frames) >= MAX_FRAMES:
                break
        cap.release()
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass

    if not frames:
        raise ValueError("Video has no decodable frames")
    arr = np.stack(frames, axis=0).astype(np.uint8)  # T×H×W×3 RGB
    return arr, h_proc, w_proc, arr.shape[0], h_orig, w_orig


def load_cotracker(device: torch.device):
    """Load CoTracker3 offline model — cached on the predictor instance.

    Uses the offline (full-video) predictor which gives best quality for short clips.
    """
    model = torch.hub.load("facebookresearch/co-tracker", "cotracker3_offline")
    return model.to(device).eval()


def run_inference(
    frames_rgb: np.ndarray,
    queries: list[dict[str, Any]],
    device: torch.device,
    model: Any | None = None,
    query_scale: float = 1.0,
) -> dict[str, list[list[float]]]:
    """Run CoTracker3 tracking. Returns { pointId: [[x,y], ...] } per frame
    en coordonnées **originales** de la vidéo (queries entrent et sorties sortent
    toutes deux à l'échelle originale ; `query_scale` < 1.0 quand la vidéo a été
    downscale en interne).
    """
    if model is None:
        model = load_cotracker(device)

    # Build queries tensor: each query is (t, x, y). Track unique pointIds and a
    # mapping query_idx → pointId so we can aggregate the output.
    pid_to_qidx: dict[str, list[int]] = defaultdict(list)
    flat_queries: list[list[float]] = []
    for q in queries:
        pid = str(q["pointId"])
        pid_to_qidx[pid].append(len(flat_queries))
        # Scale incoming queries (original coords) into processing resolution.
        flat_queries.append([
            float(q["frameIdx"]),
            float(q["x"]) * query_scale,
            float(q["y"]) * query_scale,
        ])

    # Tensor: B=1, N×3
    q_tensor = torch.tensor([flat_queries], dtype=torch.float32, device=device)

    # Video tensor: B×T×3×H×W in [0, 255]
    video = torch.from_numpy(frames_rgb).permute(0, 3, 1, 2).unsqueeze(0).float().to(device)

    with torch.no_grad():
        # CoTracker3 returns pred_tracks B×T×N×2 and pred_visibility B×T×N
        pred_tracks, _vis = model(video, queries=q_tensor)

    tracks = pred_tracks[0].cpu().numpy()  # T×N×2
    t_frames = tracks.shape[0]
    inv_scale = 1.0 / query_scale if query_scale != 0 else 1.0
    out: dict[str, list[list[float]]] = {}
    for pid, qidxs in pid_to_qidx.items():
        # Average over query indices for the same pointId
        per_frame = np.mean(tracks[:, qidxs, :], axis=1)  # T×2
        out[pid] = [[float(x) * inv_scale, float(y) * inv_scale] for x, y in per_frame]
        if len(out[pid]) > t_frames:
            out[pid] = out[pid][:t_frames]

    return out


def build_response(
    out: dict[str, list[list[float]]],
    width: int,
    height: int,
    num_frames: int,
    execution_time_ms: float | None = None,
    resolution_used: str | None = None,
    inference_width: int | None = None,
    inference_height: int | None = None,
) -> dict[str, Any]:
    resp: dict[str, Any] = {
        "videoWidth": width,
        "videoHeight": height,
        "numFrames": num_frames,
        "points": out,
    }
    if execution_time_ms is not None:
        resp["executionTimeMs"] = round(execution_time_ms, 1)
    if resolution_used is not None:
        resp["resolutionUsed"] = resolution_used
    if inference_width is not None and inference_height is not None:
        resp["inferenceWidth"] = inference_width
        resp["inferenceHeight"] = inference_height
    return resp

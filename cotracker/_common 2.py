"""Shared CoTracker3 helpers used by both Cloud Function and local MPS server.

Protocol:
  POST {
    video: base64 MP4/WebM,
    queries: [{pointId, frameIdx, x, y}],
    resolution?: 'native'|'512',                 // alias: 'native' = no override, '512' = (384,512)
    interpShape?: [h, w] | null                  // override explicite de model.model.interp_shape
  }
  →   { videoWidth, videoHeight, numFrames, points: { pointId: [[x,y], ...] }, executionTimeMs, interpShapeUsed }

⚠️ Note importante :
`CoTrackerPredictor` resize la vidéo en interne via `model.model.interp_shape`
(défaut ~384×512) — la résolution **d'entrée** envoyée au serveur n'influence donc
PAS la vitesse d'inférence, seul `interp_shape` la contrôle. C'est pourquoi on
n'applique plus de downscale OpenCV en amont (gaspillage CPU pur).
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


def resolve_interp_shape(payload: dict[str, Any]) -> tuple[int, int] | None:
    """Map payload['resolution'] / payload['interpShape'] → interp_shape override.

    Priorité à `interpShape` explicite si fourni, sinon mapping `resolution` :
      - 'native' (défaut) → None (utilise le défaut du modèle)
      - '512'             → (384, 512) — défaut explicite, sert de baseline mesurable
    """
    explicit = payload.get("interpShape")
    if explicit is not None:
        if not (isinstance(explicit, (list, tuple)) and len(explicit) == 2):
            raise ValueError("interpShape must be a [h, w] pair")
        return (int(explicit[0]), int(explicit[1]))
    resolution = payload.get("resolution", "native")
    if resolution is None or resolution == "native":
        return None
    if resolution == "512" or resolution == 512:
        return (384, 512)
    raise ValueError(f"Unknown resolution mode: {resolution!r}")


def decode_video(
    video_b64: str,
    subsample: int = 1,
) -> tuple[np.ndarray, int, int, int, int]:
    """Decode base64 video.

    `subsample` = 1 → toutes les frames (24fps). 2 → 1 sur 2 (12fps), etc.
    Renvoie (frames_kept T_kept×H×W×3, h, w, n_orig, subsample_applied).
    n_orig = nombre total de frames sources lues (avant subsample).
    """
    if subsample < 1:
        subsample = 1
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
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        frames: list[np.ndarray] = []
        n_orig = 0
        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                break
            if n_orig % subsample == 0:
                frames.append(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
            n_orig += 1
            if n_orig >= MAX_FRAMES * subsample:
                break
        cap.release()
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass

    if not frames:
        raise ValueError("Video has no decodable frames")
    arr = np.stack(frames, axis=0).astype(np.uint8)
    return arr, h, w, n_orig, subsample


_MODEL_CACHE: dict[str, Any] = {}


def load_cotracker(device: torch.device, engine: str = "offline"):
    """Load CoTracker3 model — `engine` = 'offline' (full-video, default) ou 'online'
    (fenêtres glissantes 16 frames, ~×2 plus rapide, qualité quasi-identique).

    Les deux modèles sont cachés pour éviter de re-télécharger entre requêtes.
    """
    key = f"{engine}:{device}"
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]
    hub_name = "cotracker3_online" if engine == "online" else "cotracker3_offline"
    model = torch.hub.load("facebookresearch/co-tracker", hub_name)
    model = model.to(device).eval()
    _MODEL_CACHE[key] = model
    return model


def _try_get_interp_shape(model: Any) -> tuple[int, int] | None:
    """Best-effort lecture du `interp_shape` courant du modèle (varie selon versions)."""
    for path in ("model.interp_shape", "interp_shape"):
        obj = model
        ok = True
        for attr in path.split("."):
            if not hasattr(obj, attr):
                ok = False
                break
            obj = getattr(obj, attr)
        if ok:
            try:
                return (int(obj[0]), int(obj[1]))
            except Exception:
                pass
    return None


def _try_set_interp_shape(model: Any, shape: tuple[int, int]) -> bool:
    """Tente d'écrire `interp_shape` sur le modèle (varie selon versions CoTracker)."""
    for path in ("model.interp_shape", "interp_shape"):
        obj = model
        attrs = path.split(".")
        for attr in attrs[:-1]:
            if not hasattr(obj, attr):
                obj = None
                break
            obj = getattr(obj, attr)
        if obj is not None and hasattr(obj, attrs[-1]):
            try:
                setattr(obj, attrs[-1], shape)
                return True
            except Exception:
                continue
    return False


def _run_online_inference(
    video_full: torch.Tensor,
    queries_tensor: torch.Tensor,
    model: Any,
) -> torch.Tensor:
    """Inférence par fenêtres glissantes pour CoTracker3 online.

    Pattern (cf. README facebookresearch/co-tracker) :
      - fenêtre = `model.step * 2` frames (typique 8)
      - premier appel : `is_first_step=True` + `queries=...` → init état + retourne tracks
      - appels suivants : `is_first_step=False` → propagent et accumulent
    Le dernier appel retourne `pred_tracks` shape [1, T_total, N, 2] couvrant toute la vidéo.
    """
    T = int(video_full.shape[1])
    step = int(getattr(model, "step", 4))
    window = step * 2

    is_first = True
    pred_tracks = None

    def _call(start: int, end: int, first: bool) -> torch.Tensor | None:
        chunk = video_full[:, start:end]
        kwargs: dict[str, Any] = {"is_first_step": first}
        if first:
            kwargs["queries"] = queries_tensor
        out = model(chunk, **kwargs)
        if isinstance(out, tuple) and len(out) >= 1:
            return out[0]
        return None

    # Sliding windows at indices step, 2*step, ... (cf. README: `if i % step == 0 and i != 0`)
    for i in range(step, T, step):
        end = i + 1
        start = max(0, end - window)
        tracks = _call(start, end, is_first)
        if tracks is not None:
            pred_tracks = tracks
        is_first = False

    # Final partial window
    last_i = T - 1
    remainder = last_i % step
    final_size = remainder + step + 1
    start = max(0, T - final_size)
    tracks = _call(start, T, is_first)
    if tracks is not None:
        pred_tracks = tracks

    if pred_tracks is None:
        raise RuntimeError("CoTracker online: aucune track produite (vidéo trop courte ?)")
    return pred_tracks


def run_inference(
    frames_rgb: np.ndarray,
    queries: list[dict[str, Any]],
    device: torch.device,
    model: Any | None = None,
    interp_shape: tuple[int, int] | None = None,
    subsample: int = 1,
    n_orig: int | None = None,
    engine: str = "offline",
) -> tuple[dict[str, list[list[float]]], tuple[int, int] | None]:
    """Run CoTracker3 tracking. Returns ({pointId: [[x,y],...]}, interp_shape_effective).

    Si `subsample > 1`, les queries' `frameIdx` (en coords frames originales) sont
    remappées sur les frames échantillonnées avant inférence, puis les tracks
    sont re-expanded à `n_orig` frames par interpolation linéaire. Cela permet
    au client de continuer à raisonner en coords originales (24fps).
    """
    if model is None:
        model = load_cotracker(device)

    if interp_shape is not None:
        applied = _try_set_interp_shape(model, interp_shape)
        if not applied:
            import logging
            logging.warning("Could not set interp_shape=%s on model; using default", interp_shape)

    effective_shape = _try_get_interp_shape(model)
    t_sub = frames_rgb.shape[0]

    pid_to_qidx: dict[str, list[int]] = defaultdict(list)
    flat_queries: list[list[float]] = []
    for q in queries:
        pid = str(q["pointId"])
        pid_to_qidx[pid].append(len(flat_queries))
        # Remap frameIdx (coords originales) → index dans les frames échantillonnées.
        f_orig = float(q["frameIdx"])
        f_sub = max(0.0, min(float(t_sub - 1), f_orig / subsample))
        flat_queries.append([f_sub, float(q["x"]), float(q["y"])])

    q_tensor = torch.tensor([flat_queries], dtype=torch.float32, device=device)
    video = torch.from_numpy(frames_rgb).permute(0, 3, 1, 2).unsqueeze(0).float().to(device)

    with torch.no_grad():
        if engine == "online":
            pred_tracks = _run_online_inference(video, q_tensor, model)
        else:
            pred_tracks, _vis = model(video, queries=q_tensor)

    tracks_sub = pred_tracks[0].cpu().numpy()  # T_sub × N × 2
    t_out = tracks_sub.shape[0]
    target_n = int(n_orig) if (n_orig is not None and subsample > 1) else t_out

    out: dict[str, list[list[float]]] = {}
    for pid, qidxs in pid_to_qidx.items():
        per_frame_sub = np.mean(tracks_sub[:, qidxs, :], axis=1)  # T_sub × 2
        if subsample <= 1 or target_n == t_out:
            out[pid] = [[float(x), float(y)] for x, y in per_frame_sub]
        else:
            # Linear interp from t_out kept frames to target_n original-frame slots.
            expanded: list[list[float]] = []
            for f in range(target_n):
                idx_f = f / subsample
                i_lo = int(idx_f)
                if i_lo >= t_out - 1:
                    expanded.append([float(per_frame_sub[t_out - 1][0]), float(per_frame_sub[t_out - 1][1])])
                    continue
                t = idx_f - i_lo
                x = per_frame_sub[i_lo][0] * (1.0 - t) + per_frame_sub[i_lo + 1][0] * t
                y = per_frame_sub[i_lo][1] * (1.0 - t) + per_frame_sub[i_lo + 1][1] * t
                expanded.append([float(x), float(y)])
            out[pid] = expanded

    return out, effective_shape


def build_response(
    out: dict[str, list[list[float]]],
    width: int,
    height: int,
    num_frames: int,
    execution_time_ms: float | None = None,
    resolution_used: str | None = None,
    interp_shape_used: tuple[int, int] | None = None,
    subsample_used: int | None = None,
    engine_used: str | None = None,
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
    if interp_shape_used is not None:
        resp["interpShapeUsed"] = [interp_shape_used[0], interp_shape_used[1]]
    if subsample_used is not None and subsample_used > 1:
        resp["subsampleUsed"] = subsample_used
    if engine_used is not None:
        resp["engineUsed"] = engine_used
    return resp

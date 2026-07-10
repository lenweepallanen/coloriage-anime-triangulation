"""Google Cloud Function entry point for CoTracker3 point tracking.

Deploy:
  gcloud functions deploy cotracker-track \
    --gen2 --runtime python311 --trigger-http --allow-unauthenticated \
    --memory 16384MB --cpu 4 --timeout 540s --concurrency 1 \
    --min-instances 0 --max-instances 2 \
    --source cotracker/ --entry-point cotracker_track \
    --project coloriage-anime-prod --region europe-west1
"""

from __future__ import annotations
import json
import logging
import time
from typing import Any

import functions_framework
import torch

from _common import (
    build_response, decode_video, run_inference, validate_payload, load_cotracker,
    resolve_interp_shape,
)

_DEVICE: torch.device | None = None


def _get_device() -> torch.device:
    global _DEVICE
    if _DEVICE is None:
        _DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logging.info("[cotracker] Device = %s", _DEVICE)
    return _DEVICE


def _get_model(engine: str = "offline") -> tuple[Any, torch.device]:
    device = _get_device()
    model = load_cotracker(device, engine=engine)
    return model, device


@functions_framework.http
def cotracker_track(request):  # type: ignore[no-untyped-def]
    # CORS preflight
    if request.method == "OPTIONS":
        return ("", 204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "3600",
        })

    headers = {"Access-Control-Allow-Origin": "*"}

    if request.method == "GET":
        # Warmup: pre-load offline (default). Online sera chargé à la demande.
        try:
            _get_model("offline")
            return (json.dumps({"status": "warm"}), 200, {**headers, "Content-Type": "application/json"})
        except Exception as e:  # noqa: BLE001
            return (json.dumps({"status": "warmup_failed", "error": str(e)}), 200, {**headers, "Content-Type": "application/json"})

    if request.method != "POST":
        return (json.dumps({"error": "Method not allowed"}), 405, headers)

    try:
        payload = request.get_json(silent=True) or {}
        validate_payload(payload)
        resolution = payload.get("resolution", "native")
        interp_shape = resolve_interp_shape(payload)
        subsample = max(1, int(payload.get("subsample", 1)))
        engine = payload.get("engine", "offline")
        if engine not in ("offline", "online"):
            raise ValueError(f"Unknown engine: {engine!r} (expected 'offline' or 'online')")
        model, device = _get_model(engine)
        t0 = time.perf_counter()
        frames, h, w, n_orig, subsample_applied = decode_video(payload["video"], subsample=subsample)
        logging.info(
            "[cotracker] engine=%s resolution=%s interp_shape=%s subsample=%d video=%dx%d frames_orig=%d frames_kept=%d",
            engine, resolution, interp_shape, subsample_applied, w, h, n_orig, frames.shape[0],
        )
        out, vis_out, interp_used = run_inference(
            frames, payload["queries"], device, model,
            interp_shape=interp_shape, subsample=subsample_applied, n_orig=n_orig,
            engine=engine,
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        logging.info(
            "[cotracker] inference done in %.1f ms (interp_shape=%s, subsample=%d)",
            elapsed_ms, interp_used, subsample_applied,
        )
        resp = build_response(
            out, w, h, n_orig,
            execution_time_ms=elapsed_ms,
            resolution_used=str(resolution),
            interp_shape_used=interp_used,
            subsample_used=subsample_applied,
            engine_used=engine,
            visibility=vis_out,
        )
        return (json.dumps(resp), 200, {**headers, "Content-Type": "application/json"})
    except ValueError as e:
        return (json.dumps({"error": str(e)}), 400, {**headers, "Content-Type": "application/json"})
    except Exception as e:  # noqa: BLE001
        logging.exception("[cotracker] internal error")
        return (json.dumps({"error": f"internal: {e}"}), 500, {**headers, "Content-Type": "application/json"})

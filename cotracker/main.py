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
    resolve_max_long_side,
)

_MODEL: Any | None = None
_DEVICE: torch.device | None = None


def _get_model() -> tuple[Any, torch.device]:
    global _MODEL, _DEVICE
    if _MODEL is None or _DEVICE is None:
        _DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logging.info("[cotracker] Loading model on %s", _DEVICE)
        _MODEL = load_cotracker(_DEVICE)
    return _MODEL, _DEVICE


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
        # Warmup: pre-load model so the next POST hits a warm instance.
        try:
            _get_model()
            return (json.dumps({"status": "warm"}), 200, {**headers, "Content-Type": "application/json"})
        except Exception as e:  # noqa: BLE001
            return (json.dumps({"status": "warmup_failed", "error": str(e)}), 200, {**headers, "Content-Type": "application/json"})

    if request.method != "POST":
        return (json.dumps({"error": "Method not allowed"}), 405, headers)

    try:
        payload = request.get_json(silent=True) or {}
        validate_payload(payload)
        resolution = payload.get("resolution", "native")
        max_long_side = resolve_max_long_side(resolution)
        model, device = _get_model()
        t0 = time.perf_counter()
        frames, h_proc, w_proc, n, h_orig, w_orig = decode_video(payload["video"], max_long_side)
        query_scale = w_proc / w_orig if w_orig > 0 else 1.0
        logging.info(
            "[cotracker] resolution=%s original=%dx%d proc=%dx%d frames=%d",
            resolution, w_orig, h_orig, w_proc, h_proc, n,
        )
        out = run_inference(frames, payload["queries"], device, model, query_scale=query_scale)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        logging.info("[cotracker] inference done in %.1f ms", elapsed_ms)
        resp = build_response(
            out, w_orig, h_orig, n,
            execution_time_ms=elapsed_ms,
            resolution_used=str(resolution),
            inference_width=w_proc,
            inference_height=h_proc,
        )
        return (json.dumps(resp), 200, {**headers, "Content-Type": "application/json"})
    except ValueError as e:
        return (json.dumps({"error": str(e)}), 400, {**headers, "Content-Type": "application/json"})
    except Exception as e:  # noqa: BLE001
        logging.exception("[cotracker] internal error")
        return (json.dumps({"error": f"internal: {e}"}), 500, {**headers, "Content-Type": "application/json"})

"""Local Flask server exposing the same CoTracker3 API as the Cloud Function.

Runs on Mac MPS (Apple Silicon) for ~5-15× speedup vs CPU. Same REST contract as
cotracker/main.py — the TypeScript client (`cotrackerTracking.ts`) switches between
cloud and local via the `VITE_COTRACKER_FUNCTION_URL` env var.

Usage:
    cd cotracker-local
    pip install -r requirements.txt
    PYTORCH_ENABLE_MPS_FALLBACK=1 python server.py
"""

from __future__ import annotations
import argparse
import json
import logging
import sys
import time
from pathlib import Path

# Re-use shared helpers from sibling cotracker/ directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "cotracker"))

import torch
from flask import Flask, jsonify, request

from _common import (  # type: ignore[import-not-found]
    build_response, decode_video, run_inference, validate_payload, load_cotracker,
    resolve_interp_shape,
)

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

_DEVICE: torch.device | None = None


def _pick_device(forced: str | None) -> torch.device:
    if forced:
        return torch.device(forced)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _get_model(engine: str = "offline"):
    global _DEVICE
    if _DEVICE is None:
        _DEVICE = _pick_device(app.config.get("FORCED_DEVICE"))
        logging.info("Device = %s", _DEVICE)
    model = load_cotracker(_DEVICE, engine=engine)
    return model, _DEVICE


@app.route("/", methods=["GET", "POST", "OPTIONS"])
def root():
    if request.method == "OPTIONS":
        return ("", 204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        })
    if request.method == "GET":
        try:
            _get_model()
            return jsonify({"status": "warm"})
        except Exception as e:  # noqa: BLE001
            return jsonify({"status": "warmup_failed", "error": str(e)}), 200

    try:
        payload = request.get_json(force=True, silent=True) or {}
        validate_payload(payload)
        resolution = payload.get("resolution", "native")
        interp_shape = resolve_interp_shape(payload)
        subsample = max(1, int(payload.get("subsample", 1)))
        engine = payload.get("engine", "offline")
        if engine not in ("offline", "online"):
            raise ValueError(f"Unknown engine: {engine!r}")
        model, device = _get_model(engine)
        t0 = time.perf_counter()
        frames, h, w, n_orig, subsample_applied = decode_video(payload["video"], subsample=subsample)
        logging.info(
            "engine=%s resolution=%s interp_shape=%s subsample=%d video=%dx%d frames_orig=%d frames_kept=%d",
            engine, resolution, interp_shape, subsample_applied, w, h, n_orig, frames.shape[0],
        )
        out, vis_out, interp_used = run_inference(
            frames, payload["queries"], device, model,
            interp_shape=interp_shape, subsample=subsample_applied, n_orig=n_orig,
            engine=engine,
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        logging.info(
            "inference done in %.1f ms (interp=%s subsample=%d)",
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
        return app.response_class(json.dumps(resp), mimetype="application/json")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:  # noqa: BLE001
        logging.exception("internal")
        return jsonify({"error": f"internal: {e}"}), 500


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--device", type=str, default=None, help="mps | cuda | cpu (default auto)")
    args = parser.parse_args()
    app.config["FORCED_DEVICE"] = args.device
    app.run(host="127.0.0.1", port=args.port, debug=False, threaded=False)

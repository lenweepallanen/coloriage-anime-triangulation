"""
Cloud Function — SAM 2 video segmentation

Receives a video (base64 MP4) + a list of zones with prompt points (foreground/background)
on frame 0, runs SAM 2 video predictor, and returns RLE-encoded masks per zone per frame.

Used by the `members-bones` animation pipeline (étape 2 "Définir Zones") to segment the
body + legs of an animated character on every frame, so the tracking step can clamp
characteristic points to their assigned zone (occlusion robustness).

The actual SAM 2 work lives in `sam2/_common.py` so that `sam2-local/server.py` (the
local Mac M2 MPS server) can reuse it.

Deploy:
  gcloud functions deploy sam2-segment \\
    --gen2 --runtime python311 --trigger-http --allow-unauthenticated \\
    --memory 16384MB --cpu 4 --timeout 540s --concurrency 1 \\
    --min-instances 0 --max-instances 2 \\
    --source sam2/ --entry-point sam2_segment \\
    --project coloriage-anime-prod --region europe-west1
"""

import os

import torch

# Optimize PyTorch for CPU inference
torch.set_num_threads(4)
torch.set_grad_enabled(False)

import functions_framework
from flask import jsonify

from _common import run_sam2_inference, validate_sam2_request

# Load SAM 2 video predictor at module level (persists across invocations on same instance).
# The model checkpoint (~150MB for Hiera Tiny) is downloaded from HuggingFace at first call
# and cached on disk in the instance.
print("Loading SAM 2 Hiera Tiny video predictor...")

from sam2.build_sam import build_sam2_video_predictor

# Resolve SAM 2 checkpoint path. Two strategies:
# 1) Pre-bundled in the function source under `checkpoints/sam2_hiera_tiny.pt`
# 2) Downloaded from HuggingFace at cold start (cached in /tmp)
CHECKPOINT_LOCAL = os.path.join(os.path.dirname(__file__), "checkpoints", "sam2_hiera_tiny.pt")
CHECKPOINT_CACHE = "/tmp/sam2_hiera_tiny.pt"
HF_CHECKPOINT_URL = "https://huggingface.co/facebook/sam2-hiera-tiny/resolve/main/sam2_hiera_tiny.pt"


def resolve_checkpoint_path() -> str:
    if os.path.exists(CHECKPOINT_LOCAL):
        return CHECKPOINT_LOCAL
    if os.path.exists(CHECKPOINT_CACHE):
        return CHECKPOINT_CACHE
    print(f"Downloading SAM 2 checkpoint from {HF_CHECKPOINT_URL}...")
    import urllib.request
    urllib.request.urlretrieve(HF_CHECKPOINT_URL, CHECKPOINT_CACHE)
    print("Download complete.")
    return CHECKPOINT_CACHE


CHECKPOINT_PATH = resolve_checkpoint_path()
MODEL_CFG = "sam2_hiera_t.yaml"

predictor = build_sam2_video_predictor(MODEL_CFG, CHECKPOINT_PATH, device="cpu")
print("SAM 2 ready.")


@functions_framework.http
def sam2_segment(request):
    """HTTP Cloud Function for SAM 2 video segmentation."""
    # Handle CORS preflight
    if request.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "3600",
        }
        return ("", 204, headers)

    cors_headers = {"Access-Control-Allow-Origin": "*"}

    # Health check — lightweight ping to trigger cold start
    if request.method == "GET":
        return (jsonify({"status": "ready"}), 200, cors_headers)

    try:
        parsed, error = validate_sam2_request(request.get_json(silent=True))
        if error:
            return (jsonify({"error": error["error"]}), error["status"], cors_headers)

        result = run_sam2_inference(predictor, parsed["video_bytes"], parsed["zones"])
        return (jsonify(result), 200, cors_headers)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return (jsonify({"error": str(e)}), 500, cors_headers)

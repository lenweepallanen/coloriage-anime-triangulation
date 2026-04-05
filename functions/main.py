"""
Cloud Function — LaMa Inpainting

Receives a scan image + binary mask (base64), runs LaMa inpainting,
returns the inpainted image (base64 JPEG).

Deploy:
  gcloud functions deploy lama-inpaint \
    --gen2 --runtime python311 --trigger-http --allow-unauthenticated \
    --memory 2048MB --cpu 2 --timeout 120s --concurrency 1 \
    --min-instances 0 --max-instances 3 \
    --source functions/ --entry-point lama_inpaint \
    --project coloriage-anime-prod --region europe-west1
"""

import base64
import io
import os

import torch

# Optimize PyTorch for CPU inference
torch.set_num_threads(4)
torch.set_grad_enabled(False)

import functions_framework
from flask import jsonify
from PIL import Image
from simple_lama_inpainting import SimpleLama

# Load model at module level (persists across invocations on same instance)
lama = SimpleLama()

MAX_DIMENSION = 2048


def decode_base64_image(b64_string: str) -> Image.Image:
    """Decode a base64 image (PNG or JPEG) to a PIL Image."""
    image_bytes = base64.b64decode(b64_string)
    return Image.open(io.BytesIO(image_bytes))


def encode_image_jpeg_base64(image: Image.Image, quality: int = 85) -> str:
    """Encode a PIL Image to a base64 JPEG string (much smaller than PNG)."""
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


@functions_framework.http
def lama_inpaint(request):
    """HTTP Cloud Function for LaMa inpainting."""
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
        data = request.get_json(silent=True)
        if not data:
            return (jsonify({"error": "Missing JSON body"}), 400, cors_headers)

        if "image" not in data or "mask" not in data:
            return (
                jsonify({"error": "Missing 'image' or 'mask' field"}),
                400,
                cors_headers,
            )

        # Decode images (accepts both PNG and JPEG)
        image = decode_base64_image(data["image"]).convert("RGB")
        mask = decode_base64_image(data["mask"]).convert("L")

        # Validate dimensions
        if image.size != mask.size:
            return (
                jsonify({"error": f"Dimension mismatch: image={image.size}, mask={mask.size}"}),
                400,
                cors_headers,
            )

        if image.width > MAX_DIMENSION or image.height > MAX_DIMENSION:
            return (
                jsonify({"error": f"Image too large: max {MAX_DIMENSION}x{MAX_DIMENSION}"}),
                400,
                cors_headers,
            )

        # Run LaMa inpainting with inference_mode for speed
        with torch.inference_mode():
            result = lama(image, mask)

        # Encode result as JPEG (much smaller payload = faster response)
        result_b64 = encode_image_jpeg_base64(result, quality=90)

        return (jsonify({"inpainted": result_b64}), 200, cors_headers)

    except Exception as e:
        return (jsonify({"error": str(e)}), 500, cors_headers)

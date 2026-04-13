"""
Local SAM 2 server — Flask + PyTorch MPS (Apple Silicon GPU)

Same REST API as the cloud function `sam2/main.py`, but runs locally on the admin's
Mac with PyTorch MPS for 5-15× speedup vs cloud CPU. Used by the `members-bones`
animation pipeline (étape "Définir Zones") when the client is configured with
`VITE_SAM2_FUNCTION_URL=/api/sam2/` and the Vite dev server is proxying to this
local Flask app.

Setup (one-time):
  cd sam2-local
  python3 -m venv venv
  source venv/bin/activate
  pip install -r requirements.txt

Run:
  source venv/bin/activate
  python server.py
  # Server up on http://127.0.0.1:8765
  # Health check: curl http://127.0.0.1:8765/

Options:
  python server.py --device cpu       # force CPU (if MPS crashes)
  python server.py --port 9000        # custom port
  PYTORCH_ENABLE_MPS_FALLBACK=1 python server.py  # let MPS ops fall back to CPU
"""

import argparse
import os
import sys

import torch

# Allow `from _common import ...` by appending the sibling sam2/ directory to sys.path.
# That dir contains _common.py with all the SAM 2 inference helpers shared with the
# cloud function (sam2/main.py).
HERE = os.path.dirname(os.path.abspath(__file__))
SAM2_DIR = os.path.normpath(os.path.join(HERE, "..", "sam2"))
if SAM2_DIR not in sys.path:
    sys.path.insert(0, SAM2_DIR)

from _common import run_sam2_inference, validate_sam2_request  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local SAM 2 Flask server (MPS by default)")
    parser.add_argument(
        "--device",
        choices=("auto", "mps", "cuda", "cpu"),
        default="auto",
        help="Compute device. 'auto' picks MPS > CUDA > CPU.",
    )
    parser.add_argument("--port", type=int, default=8765, help="Listen port (default 8765)")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default 127.0.0.1)")
    return parser.parse_args()


def resolve_device(arg: str) -> torch.device:
    if arg == "cpu":
        return torch.device("cpu")
    if arg == "mps":
        if not torch.backends.mps.is_available():
            print("ERROR: --device mps requested but MPS is not available", file=sys.stderr)
            sys.exit(1)
        return torch.device("mps")
    if arg == "cuda":
        if not torch.cuda.is_available():
            print("ERROR: --device cuda requested but CUDA is not available", file=sys.stderr)
            sys.exit(1)
        return torch.device("cuda")
    # auto
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def download_checkpoint_if_needed() -> str:
    """Download the SAM 2 Hiera Tiny checkpoint to ~/.cache/sam2 if not present."""
    cache_dir = os.path.expanduser("~/.cache/sam2")
    os.makedirs(cache_dir, exist_ok=True)
    checkpoint_path = os.path.join(cache_dir, "sam2_hiera_tiny.pt")
    if os.path.exists(checkpoint_path):
        return checkpoint_path

    url = "https://huggingface.co/facebook/sam2-hiera-tiny/resolve/main/sam2_hiera_tiny.pt"
    print(f"Downloading SAM 2 checkpoint from {url}...")
    print("(One-time, ~150 MB)")
    import urllib.request
    urllib.request.urlretrieve(url, checkpoint_path)
    print(f"Saved to {checkpoint_path}")
    return checkpoint_path


def build_app(predictor):
    """Build the Flask application bound to the given predictor."""
    from flask import Flask, jsonify, request
    from flask_cors import CORS

    app = Flask(__name__)
    CORS(app)  # Permissive CORS for local testing (curl, etc.). Vite proxy hides this in prod.

    @app.route("/", methods=["GET", "POST", "OPTIONS"])
    def sam2_segment():
        if request.method == "OPTIONS":
            return ("", 204)

        if request.method == "GET":
            return jsonify({"status": "ready"}), 200

        try:
            parsed, error = validate_sam2_request(request.get_json(silent=True))
            if error:
                return jsonify({"error": error["error"]}), error["status"]

            result = run_sam2_inference(predictor, parsed["video_bytes"], parsed["zones"])
            return jsonify(result), 200

        except Exception as e:
            import traceback
            traceback.print_exc()
            return jsonify({"error": str(e)}), 500

    return app


def main() -> None:
    args = parse_args()

    # PyTorch knobs
    torch.set_grad_enabled(False)

    device = resolve_device(args.device)
    print(f"Using device: {device}")

    print("Loading SAM 2 Hiera Tiny video predictor...")
    checkpoint_path = download_checkpoint_if_needed()

    from sam2.build_sam import build_sam2_video_predictor

    predictor = build_sam2_video_predictor("sam2_hiera_t.yaml", checkpoint_path, device=str(device))
    print("SAM 2 ready.")

    app = build_app(predictor)
    print(f" * SAM 2 local server listening on http://{args.host}:{args.port}")
    print(f" * Health: curl http://{args.host}:{args.port}/")
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False, threaded=False)


if __name__ == "__main__":
    main()

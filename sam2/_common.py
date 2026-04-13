"""
SAM 2 inference helpers shared between the cloud and local servers.

Both `sam2/main.py` (Cloud Function) and `sam2-local/server.py` (local Flask)
import from this module to avoid duplication. The HTTP transport is the only
thing that differs between the two — the actual SAM 2 work is identical.
"""

import base64
import os
import shutil
import tempfile

import cv2
import numpy as np

# Limits enforced by both servers
MAX_VIDEO_BYTES = 50 * 1024 * 1024  # 50 MB max upload
MAX_FRAMES = 300                     # Cap to avoid CPU timeout
MAX_ZONES = 5                        # body + 4 legs


def decode_video_to_frame_dir(video_bytes: bytes) -> tuple[str, int, int, int]:
    """
    Decode the MP4 bytes to a temporary directory of JPEG frames named 00000.jpg, 00001.jpg, ...
    SAM 2's `init_state(video_path=<dir>)` accepts this format and bypasses the decord
    dependency (which has no Linux wheel for Cloud Run).

    Returns: (frame_dir, num_frames, video_width, video_height)
    Caller is responsible for cleaning up the directory with shutil.rmtree.
    """
    frame_dir = tempfile.mkdtemp(prefix="sam2_frames_")

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        tmp.write(video_bytes)
        tmp_path = tmp.name

    try:
        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            raise ValueError("Failed to open video")

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        frame_idx = 0
        while frame_idx < MAX_FRAMES:
            ret, frame_bgr = cap.read()
            if not ret:
                break
            out_path = os.path.join(frame_dir, f"{frame_idx:05d}.jpg")
            cv2.imwrite(out_path, frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 95])
            frame_idx += 1
        cap.release()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    if frame_idx == 0:
        shutil.rmtree(frame_dir, ignore_errors=True)
        raise ValueError("No frames decoded from video")

    return frame_dir, frame_idx, width, height


def encode_rle_uncompressed(mask: np.ndarray) -> dict:
    """
    Encode a binary mask (numpy uint8, shape [H, W]) to a JSON-friendly RLE
    in COCO uncompressed format: {"size": [H, W], "counts": [bg, fg, bg, fg, ...]}.
    The counts list always starts with a background run (length may be 0).
    """
    h, w = mask.shape
    flat = mask.flatten(order="F")  # column-major (Fortran), like COCO RLE convention
    counts: list[int] = []
    current = 0  # 0 = background
    run = 0
    for v in flat:
        v = int(v > 0)
        if v == current:
            run += 1
        else:
            counts.append(run)
            current = v
            run = 1
    counts.append(run)
    # Ensure list starts with background
    if len(counts) > 0 and mask.flatten(order="F")[0] != 0:
        counts.insert(0, 0)
    return {"size": [int(h), int(w)], "counts": counts}


def validate_sam2_request(data: dict | None) -> tuple[dict | None, dict | None]:
    """
    Validate a SAM 2 segment request body. Returns (parsed, error) where exactly one
    of the two is non-None. `parsed` is a dict with keys {video_bytes, zones}.
    `error` is a dict {error: str, status: int}.
    """
    if not data:
        return None, {"error": "Missing JSON body", "status": 400}

    for field in ("video", "zones"):
        if field not in data:
            return None, {"error": f"Missing field: {field}", "status": 400}

    zones = data["zones"]
    if not isinstance(zones, list) or len(zones) == 0:
        return None, {"error": "zones must be a non-empty list", "status": 400}
    if len(zones) > MAX_ZONES:
        return None, {"error": f"Too many zones: {len(zones)} (max {MAX_ZONES})", "status": 400}
    for z in zones:
        if "id" not in z or "prompts" not in z:
            return None, {"error": "Each zone must have 'id' and 'prompts'", "status": 400}
        if not isinstance(z["prompts"], list) or len(z["prompts"]) == 0:
            return None, {"error": f"Zone '{z['id']}' has no prompts", "status": 400}

    video_bytes = base64.b64decode(data["video"])
    if len(video_bytes) > MAX_VIDEO_BYTES:
        return None, {
            "error": f"Video too large: {len(video_bytes)} bytes (max {MAX_VIDEO_BYTES})",
            "status": 413,
        }

    return {"video_bytes": video_bytes, "zones": zones}, None


def run_sam2_inference(predictor, video_bytes: bytes, zones: list[dict]) -> dict:
    """
    Full SAM 2 inference pipeline (no HTTP).

    1. Decode video bytes to a directory of JPEG frames
    2. predictor.init_state(video_path=frame_dir)
    3. add_new_points_or_box(frame_idx=0, obj_id, points, labels) for each zone
    4. propagate_in_video → collect masks per zone per frame
    5. Encode each mask as RLE uncompressed

    Returns a JSON-ready dict matching the API contract:
    {
        "videoWidth": int,
        "videoHeight": int,
        "numFrames": int,
        "masks": { zoneId: [RLEMask, ...] },  // one RLE per frame, in frame order
    }
    """
    import torch  # imported lazily so the helper module is cheap to import

    frame_dir, num_frames_decoded, video_w_decoded, video_h_decoded = decode_video_to_frame_dir(video_bytes)

    try:
        inference_state = predictor.init_state(video_path=frame_dir)

        # SAM 2 requires obj_id to be int. Map zoneId (string) → int and back.
        zone_id_to_int = {z["id"]: i + 1 for i, z in enumerate(zones)}
        int_to_zone_id = {v: k for k, v in zone_id_to_int.items()}

        # Add prompts for each zone on frame 0
        for z in zones:
            zone_id_str = z["id"]
            obj_id_int = zone_id_to_int[zone_id_str]
            points_xy = np.array(
                [[float(p["x"]), float(p["y"])] for p in z["prompts"]],
                dtype=np.float32,
            )
            labels = np.array(
                [int(p["label"]) for p in z["prompts"]],
                dtype=np.int32,
            )
            predictor.add_new_points_or_box(
                inference_state=inference_state,
                frame_idx=0,
                obj_id=obj_id_int,
                points=points_xy,
                labels=labels,
            )

        # masks_per_zone[zone_id_str] = list of RLE dicts (one per frame, in order)
        masks_per_zone: dict[str, list[dict]] = {z["id"]: [] for z in zones}
        num_frames_seen = 0

        with torch.inference_mode():
            for frame_idx, obj_ids, mask_logits in predictor.propagate_in_video(inference_state):
                if frame_idx >= MAX_FRAMES:
                    break
                num_frames_seen = frame_idx + 1
                for i, obj_id_int in enumerate(obj_ids):
                    zone_id_str = int_to_zone_id.get(int(obj_id_int))
                    if zone_id_str is None:
                        continue
                    # mask_logits[i] shape (1, H, W) — > 0 means foreground
                    mask = (mask_logits[i] > 0.0).cpu().numpy().astype(np.uint8)
                    if mask.ndim == 3:
                        mask = mask[0]
                    rle = encode_rle_uncompressed(mask)
                    masks_per_zone[zone_id_str].append(rle)

        return {
            "videoWidth": int(video_w_decoded),
            "videoHeight": int(video_h_decoded),
            "numFrames": int(num_frames_seen),
            "masks": masks_per_zone,
        }
    finally:
        shutil.rmtree(frame_dir, ignore_errors=True)

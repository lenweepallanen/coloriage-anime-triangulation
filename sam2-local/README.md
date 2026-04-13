# SAM 2 local server (Mac M2 MPS)

Local Flask server that runs SAM 2 video segmentation on the Mac's GPU (Metal Performance Shaders) instead of the cloud function CPU. **5-15× faster** for the `members-bones` animation pipeline.

Same REST API as `sam2/main.py` (the cloud function), so the client code (`src/utils/sam2Segmentation.ts`) doesn't need to change — only the URL via `VITE_SAM2_FUNCTION_URL`.

## Setup (one-time)

```bash
cd sam2-local
python3.12 -m venv venv
venv/bin/pip install --upgrade pip
venv/bin/pip install -r requirements.txt
```

Requires **Python 3.11+**. If your default `python3` is older (macOS often ships 3.9), use `python3.12` or `python3.11` explicitly. Install via `brew install python@3.12` if missing.

> **Note** : we invoke `venv/bin/pip` and `venv/bin/python` directly instead of using `source venv/bin/activate`. This avoids a macOS Sonoma+ issue where the `com.apple.provenance` extended attribute can cause `source: operation not permitted` in some zsh configurations. The behavior is identical.

The first run will download the SAM 2 Hiera Tiny checkpoint (~150 MB) from HuggingFace into `~/.cache/sam2/`. Subsequent runs reuse it.

## Run

```bash
cd sam2-local
venv/bin/python server.py
```

Should print:
```
Using device: mps
Loading SAM 2 Hiera Tiny video predictor...
SAM 2 ready.
 * SAM 2 local server listening on http://127.0.0.1:8765
```

Test:
```bash
curl http://127.0.0.1:8765/
# {"status":"ready"}
```

## Switching the client to local mode

Create `.env.local` in the project root:
```
VITE_SAM2_FUNCTION_URL=/api/sam2/
VITE_COTRACKER_FUNCTION_URL=/api/cotracker/
```

Then **restart Vite** (`npm run dev`). The browser will fetch `https://localhost:5174/api/sam2/`, which Vite proxies to `http://127.0.0.1:8765/`.

When you don't want to use the local server (e.g. you forgot to launch it, or you want to test the cloud path), comment out or remove the `.env.local` lines and restart Vite — the client falls back to the deployed cloud functions.

## Options

| Flag | Default | Effect |
|---|---|---|
| `--device cpu` | `auto` (MPS > CUDA > CPU) | Force CPU. Use if MPS crashes on a SAM 2 op. |
| `--device mps` | — | Force MPS (errors if not available) |
| `--port 9000` | `8765` | Custom port (also update `vite.config.ts` proxy target) |
| `PYTORCH_ENABLE_MPS_FALLBACK=1` (env var) | unset | Tells PyTorch to silently fall back to CPU on unsupported MPS ops instead of erroring |

Example with MPS fallback:
```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 python server.py
```

## Troubleshooting

- **`NotImplementedError: aten::*`** — A PyTorch op isn't implemented for MPS. Either set `PYTORCH_ENABLE_MPS_FALLBACK=1` or run with `--device cpu`.
- **`Failed to fetch` in the browser** — The server isn't running. Look at the Vite dev server logs for proxy errors. Restart `python server.py` and reload the browser.
- **Out of memory** — SAM 2 Hiera Tiny + 145 frames × 5 zones uses ~4-6 GB unified memory. Close other apps or test on a shorter video.
- **Slow first launch** — Normal: downloading the 150 MB checkpoint. Subsequent launches load from cache in ~5-10s.

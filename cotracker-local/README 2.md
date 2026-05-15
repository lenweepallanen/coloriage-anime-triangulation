# CoTracker3 local server (Mac MPS)

Mirror of the `cotracker/` Cloud Function, runs on `127.0.0.1:8766` with PyTorch MPS
for ~5-15× speedup vs cloud CPU on Apple Silicon.

## Setup

```bash
cd cotracker-local
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

CoTracker3 is loaded via `torch.hub` at first request — first run downloads the
checkpoint (~150 MB) and caches it.

## Run

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 python server.py
# or force CPU if MPS ops are missing for your model version:
python server.py --device cpu
```

## Switch the frontend

Create / edit `.env.local` at the project root and **restart Vite** :

```
VITE_COTRACKER_FUNCTION_URL=/api/cotracker/
```

To switch back to the Cloud Function, comment the line out.

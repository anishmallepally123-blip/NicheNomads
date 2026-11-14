"""Settings. Everything can be overridden with environment variables."""
from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent

# IRSA endpoints
IRSA_SIA_URL = os.getenv("IRSA_SIA_URL", "https://irsa.ipac.caltech.edu/SIA")

# Where downloaded cutouts and search results are kept between requests.
CACHE_DIR = Path(os.getenv("SPHEREX_CACHE_DIR", BACKEND_DIR / ".cache"))

# How long a "which images cover this spot" answer is reused before we ask
# IRSA again. New SPHEREx observations show up after at most this long.
SEARCH_TTL_SECONDS = int(os.getenv("SPHEREX_SEARCH_TTL", "3600"))

# How many cutouts we download from IRSA at the same time.
MAX_PARALLEL_DOWNLOADS = int(os.getenv("SPHEREX_MAX_PARALLEL", "4"))

# IRSA sometimes answers "server busy". How many times to try again.
DOWNLOAD_RETRIES = int(os.getenv("SPHEREX_DOWNLOAD_RETRIES", "6"))

HTTP_TIMEOUT_SECONDS = float(os.getenv("SPHEREX_HTTP_TIMEOUT", "120"))

# Limits for the viewer
MIN_FOV_ARCMIN = 1.0
MAX_FOV_ARCMIN = 60.0
DEFAULT_FOV_ARCMIN = 10.0
DEFAULT_IMAGE_SIZE = 256
MAX_IMAGE_SIZE = 768

# Built frontend (created by `npm run build`). Served by FastAPI if present.
FRONTEND_DIST = REPO_DIR / "frontend" / "dist"

CORS_ORIGINS = os.getenv("SPHEREX_CORS_ORIGINS", "*").split(",")

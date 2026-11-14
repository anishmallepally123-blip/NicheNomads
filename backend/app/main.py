"""App entry point: `uvicorn app.main:app`."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import config, data_access
from .api import router
from .monitoring import init_monitoring
from .overlays_api import router as overlays_router

init_monitoring()


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await data_access.close()


app = FastAPI(title="SPHEREx Blink Viewer API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["X-Wavelength-Um", "X-Bandwidth-Um", "X-Coverage", "X-Flagged-Fraction",
                    "X-Filled-Fraction", "X-Frames-Used", "X-Wave-Min-Um", "X-Wave-Max-Um",
                    "X-Clipped-Fraction"],
)
app.include_router(router)
app.include_router(overlays_router)

# In production the built frontend is served from the same server.
if config.FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="frontend")

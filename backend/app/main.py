from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import boilers, curves, demo, documents, health, insights, live, startups
from .api.health import health as health_payload
from .config import settings
from .db import init_db
from .services.demo import seed_demo


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_demo()
    yield


app = FastAPI(
    title="Boiler Startup Intelligence",
    version=settings.version,
    description=(
        "Compares approved boiler startup curves with historian data. Analytics quantify "
        "the difference; the LLM only explains the evidence. Read-only by design."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (health.router, boilers.router, curves.router, startups.router, insights.router, live.router, demo.router, documents.router):
    app.include_router(router, prefix="/api")


@app.get("/health", include_in_schema=False)
def root_health() -> dict:
    return health_payload()


@app.get("/")
def root() -> dict:
    return {
        "service": "boiler-startup-intelligence",
        "version": settings.version,
        "docs": "/docs",
        "health": "/api/health",
        "ui": "Run the Vite app in ../frontend (npm run dev) and open http://localhost:5173",
    }

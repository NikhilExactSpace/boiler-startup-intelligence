from __future__ import annotations

import json
import time

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..config import settings
from ..services import live

router = APIRouter(tags=["live"])


@router.get("/live/{boiler_id}")
def live_snapshot(
    boiler_id: str, startup_type: str = Query(default="auto", pattern="^(auto|cold|warm|hot)$")
) -> dict:
    if settings.kairos_mode != "mock":
        return {
            "mode": settings.kairos_mode,
            "state": "unavailable",
            "note": (
                "Live Kairos polling is not enabled in this build. Set KAIROS_MODE=mock "
                "for the accelerated demo, or use the Kairos adapter for historical import."
            ),
        }
    try:
        resolved = (
            live.classify_startup_type(boiler_id)["startup_type"]
            if startup_type == "auto"
            else startup_type
        )
        return live.get_simulator(boiler_id, resolved).snapshot()
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/live/{boiler_id}/simulate")
def restart_simulation(
    boiler_id: str, startup_type: str = Query(default="auto", pattern="^(auto|cold|warm|hot)$")
) -> dict:
    if settings.kairos_mode != "mock":
        raise HTTPException(409, "Simulation is only available when KAIROS_MODE=mock")
    try:
        resolved = (
            live.classify_startup_type(boiler_id)["startup_type"]
            if startup_type == "auto"
            else startup_type
        )
        simulator = live.restart(boiler_id, resolved)
        return {"ok": True, "snapshot": simulator.snapshot()}
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/live/{boiler_id}/stream")
def live_stream(
    boiler_id: str, startup_type: str = Query(default="auto", pattern="^(auto|cold|warm|hot)$")
) -> StreamingResponse:
    resolved = (
        live.classify_startup_type(boiler_id)["startup_type"]
        if startup_type == "auto"
        else startup_type
    )

    def events():
        while True:
            try:
                snapshot = live.get_simulator(boiler_id, resolved).snapshot()
                yield f"data: {json.dumps(snapshot, default=str)}\n\n"
            except Exception as exc:  # keep the stream honest about failures
                yield f"event: error\ndata: {json.dumps({'error': str(exc)})}\n\n"
                break
            time.sleep(max(0.5, settings.live_poll_seconds))

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

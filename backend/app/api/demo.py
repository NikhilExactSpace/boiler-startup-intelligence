from __future__ import annotations

from fastapi import APIRouter

from ..services import demo
from ..services.curves import load_seed_text

router = APIRouter(tags=["demo"])


@router.post("/demo/reset")
def reset_demo() -> dict:
    return demo.seed_demo(reset=True)


@router.get("/demo/sop-text")
def sop_text() -> dict:
    text = load_seed_text()
    return {
        "document": "SOP-202",
        "revision": "3.0",
        "equipment": "Boiler B-101",
        "characters": len(text),
        "text": text,
        "note": "Example procedure bundled with the demo. Upload your own PDF or paste text.",
    }

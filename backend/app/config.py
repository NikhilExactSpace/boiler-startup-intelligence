"""Runtime configuration. Everything is env-overridable; no secrets are committed."""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


def _load_dotenv() -> None:
    """Tiny .env loader so the demo does not need python-dotenv."""
    for candidate in (PROJECT_DIR / ".env", BACKEND_DIR / ".env"):
        if not candidate.exists():
            continue
        for raw in candidate.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


class Settings:
    version = "0.1.0"

    def __init__(self) -> None:
        self.kairos_mode = os.getenv("KAIROS_MODE", "mock").strip().lower()
        self.dc_query_url = os.getenv("DC_QUERY_URL", "").strip()
        self.kairos_username = os.getenv("KAIROS_USERNAME", "").strip()
        self.kairos_password = os.getenv("KAIROS_PASSWORD", "").strip()
        self.kairos_timeout_s = float(os.getenv("KAIROS_TIMEOUT_S", "30"))
        self.kairos_batch_size = int(os.getenv("KAIROS_BATCH_SIZE", "8"))

        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
        # PDF/image transcription benefits from the same multimodal flash model; keep a
        # separate override so extraction can be pinned without changing insights.
        self.gemini_extraction_model = os.getenv(
            "GEMINI_EXTRACTION_MODEL", self.gemini_model
        ).strip()
        self.insight_provider = os.getenv(
            "INSIGHT_PROVIDER", "gemini" if self.gemini_api_key else "deterministic"
        ).strip()
        self.extraction_provider = os.getenv(
            "EXTRACTION_PROVIDER", "gemini" if self.gemini_api_key else "deterministic"
        ).strip().lower()
        self.prompt_version = "bsi-insight-v1"

        self.database_path = Path(
            os.getenv("DATABASE_PATH", str(BACKEND_DIR / "data" / "bsi.db"))
        )
        self.rag_database_url = os.getenv(
            "RAG_DATABASE_URL", "postgresql://localhost:5432/boileriq"
        ).strip()
        self.demo_boiler_id = os.getenv("DEMO_BOILER_ID", "B-101").strip()
        self.live_time_scale = float(os.getenv("LIVE_TIME_SCALE", "120"))
        self.live_poll_seconds = float(os.getenv("LIVE_POLL_SECONDS", "2"))
        self.cors_origins = [
            origin.strip()
            for origin in os.getenv(
                "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
            ).split(",")
            if origin.strip()
        ]

    @property
    def llm_configured(self) -> bool:
        return self.insight_provider == "gemini" and bool(self.gemini_api_key)

    @property
    def extraction_ai_configured(self) -> bool:
        return self.extraction_provider == "gemini" and bool(self.gemini_api_key)

    @property
    def kairos_configured(self) -> bool:
        return bool(self.dc_query_url)


settings = Settings()

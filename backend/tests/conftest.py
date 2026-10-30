"""Test bootstrap.

The app reads its database path at import time, so the environment must be set before
any ``app.*`` import happens. Every test starts from the deterministic demo seed.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

TEST_DB = Path(tempfile.gettempdir()) / f"bsi-test-{os.getpid()}.db"
os.environ["DATABASE_PATH"] = str(TEST_DB)
os.environ["KAIROS_MODE"] = "mock"
os.environ["INSIGHT_PROVIDER"] = "deterministic"
os.environ["EXTRACTION_PROVIDER"] = "deterministic"
os.environ.pop("GEMINI_API_KEY", None)


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
    TEST_DB.unlink(missing_ok=True)


@pytest.fixture()
def demo(client):
    response = client.post("/api/demo/reset")
    assert response.status_code == 200, response.text
    return client

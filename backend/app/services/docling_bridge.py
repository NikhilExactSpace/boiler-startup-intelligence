"""Docling bridge.

The Contextual-RAG project already ships a working Docling environment. Rather than
duplicating its heavy model stack in this app, call that interpreter as a subprocess and
reuse its PDF/image -> Markdown conversion.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


def _python() -> Path | None:
    override = os.getenv("CONTEXTUAL_RAG_PYTHON", "").strip()
    candidates = [
        Path(override) if override else None,
        Path.home() / "Desktop" / "Contextual-RAG" / "backend" / ".venv" / "bin" / "python",
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    return None


def available() -> bool:
    python = _python()
    if python is None:
        return False
    try:
        completed = subprocess.run(
            [str(python), "-c", "import docling"],
            check=False,
            capture_output=True,
            timeout=20,
        )
        return completed.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def convert(path: Path) -> dict | None:
    """Return {'markdown': str, 'tables': list[str]} or None if Docling is unavailable."""
    python = _python()
    if python is None:
        return None
    script = """
import json, sys
from docling.document_converter import DocumentConverter
result = DocumentConverter().convert(sys.argv[1])
doc = result.document
tables = []
try:
    for table in doc.tables:
        md = table.export_to_markdown()
        if md and md.strip():
            tables.append(md)
except Exception:
    pass
print(json.dumps({"markdown": doc.export_to_markdown() or "", "tables": tables}))
"""
    try:
        completed = subprocess.run(
            [str(python), "-c", script, str(path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=240,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    for line in reversed(completed.stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
                if isinstance(payload, dict):
                    return payload
            except json.JSONDecodeError:
                continue
    return None

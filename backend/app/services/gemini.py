"""Small Gemini REST client shared by curve extraction and the insight layer.

No SDK dependency: the demo only needs one endpoint, and keeping the request shape in
one place makes the "model may only transcribe / explain" contract easy to audit.
"""

from __future__ import annotations

import json
import re
from typing import Any

import requests

from ..config import settings

API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiError(RuntimeError):
    """Provider or response-shape failure. Callers decide whether to fall back."""


def configured() -> bool:
    return bool(settings.gemini_api_key)


def generate_content(
    parts: list[dict[str, Any]],
    *,
    model: str,
    temperature: float = 0.2,
    max_output_tokens: int = 2400,
    response_schema: dict[str, Any] | None = None,
    json_mode: bool = False,
    thinking_budget: int | None = None,
    timeout: int = 90,
) -> tuple[str, dict[str, Any]]:
    """Call generateContent and return (text, usage metadata)."""
    if not configured():
        raise GeminiError("GEMINI_API_KEY is not configured")

    generation: dict[str, Any] = {
        "temperature": temperature,
        "maxOutputTokens": max_output_tokens,
    }
    if response_schema is not None or json_mode:
        generation["responseMimeType"] = "application/json"
    if response_schema is not None:
        generation["responseSchema"] = response_schema
    if thinking_budget is not None:
        generation["thinkingConfig"] = {"thinkingBudget": thinking_budget}

    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": generation,
    }
    try:
        response = requests.post(
            f"{API_ROOT}/{model}:generateContent",
            params={"key": settings.gemini_api_key},
            json=body,
            timeout=timeout,
        )
    except requests.RequestException as exc:  # pragma: no cover - network dependent
        raise GeminiError(f"Gemini request failed: {exc}") from exc

    if response.status_code >= 400:
        detail = response.text[:400]
        try:
            detail = json.dumps(response.json().get("error", {}))[:400]
        except ValueError:
            pass
        raise GeminiError(f"Gemini returned HTTP {response.status_code}: {detail}")

    try:
        data = response.json()
    except ValueError as exc:
        raise GeminiError("Gemini returned a non-JSON response") from exc

    candidates = data.get("candidates") or []
    if not candidates:
        feedback = data.get("promptFeedback") or {}
        blocked = feedback.get("blockReason")
        raise GeminiError(
            f"Gemini returned no candidates{f' (blocked: {blocked})' if blocked else ''}"
        )
    parts_out = candidates[0].get("content", {}).get("parts") or []
    text = "".join(part.get("text", "") for part in parts_out).strip()
    if not text:
        finish = candidates[0].get("finishReason")
        raise GeminiError(f"Gemini returned an empty response (finishReason={finish})")
    return text, data.get("usageMetadata") or {}


def embed(texts: list[str], *, model: str = "gemini-embedding-001", timeout: int = 90) -> list[list[float]]:
    """Embed texts with Gemini. Returns one vector per input."""
    if not configured():
        raise GeminiError("GEMINI_API_KEY is not configured")
    if not texts:
        return []
    requests_payload = []
    for text in texts:
        requests_payload.append(
            {
                "model": f"models/{model}",
                "content": {"parts": [{"text": text[:8000]}]},
            }
        )
    try:
        response = requests.post(
            f"{API_ROOT}/{model}:batchEmbedContents",
            params={"key": settings.gemini_api_key},
            json={"requests": requests_payload},
            timeout=timeout,
        )
    except Exception as exc:
        raise GeminiError(f"Gemini embedding request failed: {exc}") from exc
    if response.status_code >= 400:
        raise GeminiError(f"Gemini embedding returned HTTP {response.status_code}: {response.text[:300]}")
    data = response.json()
    return [item.get("values", []) for item in data.get("embeddings", [])]


def generate_content_stream(
    parts: list[dict[str, Any]],
    *,
    model: str,
    temperature: float = 0.2,
    max_output_tokens: int = 1600,
    timeout: int = 90,
):
    """Yield text deltas from Gemini's streamGenerateContent SSE endpoint."""
    if not configured():
        raise GeminiError("GEMINI_API_KEY is not configured")
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    try:
        response = requests.post(
            f"{API_ROOT}/{model}:streamGenerateContent",
            params={"key": settings.gemini_api_key, "alt": "sse"},
            json=body,
            stream=True,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise GeminiError(f"Gemini stream request failed: {exc}") from exc
    if response.status_code >= 400:
        raise GeminiError(f"Gemini stream returned HTTP {response.status_code}: {response.text[:300]}")
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw or raw == "[DONE]":
            continue
        try:
            payload = json.loads(raw)
        except ValueError:
            continue
        for candidate in payload.get("candidates", []):
            for part in candidate.get("content", {}).get("parts", []):
                text = part.get("text")
                if text:
                    yield text


def parse_json(text: str) -> dict[str, Any]:
    """Parse a JSON object, tolerating accidental fenced or prefixed output."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```$", "", cleaned)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            payload = json.loads(cleaned[start : end + 1])
        else:
            raise
    if not isinstance(payload, dict):
        raise ValueError("expected a JSON object")
    return payload

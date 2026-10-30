"""KairosDB adapter for real historian data.

The payload shape mirrors the existing Multi-Agent RCA client: POST tag queries to
``DC_QUERY_URL`` with HTTP basic auth, chunked metric batches, and optional ``avg``
downsampling. Nothing here writes to the historian.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Iterable

import requests

from ..config import settings
from ..schemas import DesignCurve, Signal


class KairosError(RuntimeError):
    pass


class KairosClient:
    def __init__(self) -> None:
        if not settings.dc_query_url:
            raise KairosError("DC_QUERY_URL is not configured")
        self.session = requests.Session()
        if settings.kairos_username:
            self.session.auth = (settings.kairos_username, settings.kairos_password)
        self.session.headers.update({"Content-Type": "application/json"})

    def _fetch_chunk(
        self,
        signals: list[Signal],
        start_ms: int,
        end_ms: int,
        downsample_minutes: int | None,
        tag_map: dict[str, str] | None = None,
    ) -> dict[str, list[tuple[int, float]]]:
        metrics = []
        for signal in signals:
            metric = (tag_map or {}).get(signal.key) or signal.kairos.metric
            entry: dict[str, Any] = {"name": metric, "tags": signal.kairos.tags or {}}
            if downsample_minutes:
                entry["aggregators"] = [
                    {"name": "avg", "sampling": {"value": downsample_minutes, "unit": "minutes"}}
                ]
            metrics.append(entry)

        payload = {
            "start_absolute": start_ms,
            "end_absolute": end_ms,
            "metrics": metrics,
        }
        try:
            response = self.session.post(
                settings.dc_query_url, json=payload, timeout=settings.kairos_timeout_s
            )
            response.raise_for_status()
            data = response.json()
        except requests.RequestException as exc:
            raise KairosError(f"KairosDB request failed: {exc}") from exc
        except ValueError as exc:
            raise KairosError("KairosDB returned invalid JSON") from exc

        by_metric: dict[str, list[tuple[int, float]]] = {}
        for query in data.get("queries", []):
            for result in query.get("results", []):
                name = result.get("name")
                values = [(int(ts), float(value)) for ts, value in result.get("values", [])]
                if name:
                    by_metric[name] = sorted(values)
        return by_metric

    def fetch_signals(
        self,
        signals: Iterable[Signal],
        start_ms: int,
        end_ms: int,
        *,
        downsample_minutes: int | None = None,
        tag_map: dict[str, str] | None = None,
    ) -> dict[str, list[tuple[int, float]]]:
        ordered = list(signals)
        chunks = [
            ordered[index : index + settings.kairos_batch_size]
            for index in range(0, len(ordered), settings.kairos_batch_size)
        ]
        by_metric: dict[str, list[tuple[int, float]]] = {}
        if len(chunks) <= 1:
            if chunks:
                by_metric = self._fetch_chunk(
                    chunks[0], start_ms, end_ms, downsample_minutes, tag_map
                )
        else:
            with ThreadPoolExecutor(max_workers=min(4, len(chunks))) as pool:
                futures = [
                    pool.submit(
                        self._fetch_chunk,
                        chunk,
                        start_ms,
                        end_ms,
                        downsample_minutes,
                        tag_map,
                    )
                    for chunk in chunks
                ]
                for future in futures:
                    by_metric.update(future.result())

        out: dict[str, list[tuple[int, float]]] = {}
        for signal in ordered:
            metric = (tag_map or {}).get(signal.key) or signal.kairos.metric
            out[signal.key] = by_metric.get(metric, [])
        return out

    def health(self) -> dict[str, Any]:
        return {
            "configured": True,
            "url_host": settings.dc_query_url.split("//")[-1].split("/")[0],
            "batch_size": settings.kairos_batch_size,
        }


def _interp(values: list[tuple[int, float]], ts: int, max_gap_ms: int = 5 * 60 * 1000) -> float | None:
    if not values:
        return None
    if ts < values[0][0] or ts > values[-1][0]:
        return None
    low, high = 0, len(values) - 1
    while low <= high:
        mid = (low + high) // 2
        if values[mid][0] == ts:
            return values[mid][1]
        if values[mid][0] < ts:
            low = mid + 1
        else:
            high = mid - 1
    if high < 0 or low >= len(values):
        return None
    t0, v0 = values[high]
    t1, v1 = values[low]
    if t1 - t0 > max_gap_ms:
        return None
    ratio = (ts - t0) / (t1 - t0)
    return v0 + (v1 - v0) * ratio


def startup_series_from_kairos(
    curve: DesignCurve,
    fetched: dict[str, list[tuple[int, float]]],
    *,
    t0_ms: int,
    end_ms: int,
    step_s: int = 15,
    pre_roll_min: float = 15.0,
) -> dict[str, Any]:
    """Convert absolute historian points into the compact relative series format."""
    step_ms = step_s * 1000
    start_ms = t0_ms - int(pre_roll_min * 60_000)
    grid = list(range(start_ms, end_ms + 1, step_ms))
    signals: dict[str, list[float | None]] = {}
    for signal in curve.signals:
        values = fetched.get(signal.key) or []
        column: list[float | None] = []
        for ts in grid:
            value = _interp(values, ts)
            if value is None:
                column.append(None)
            elif signal.kind == "state":
                column.append(1.0 if value >= 0.5 else 0.0)
            else:
                column.append(round(value, signal.decimals))
        signals[signal.key] = column
    return {
        "step_s": step_s,
        "start_min": -pre_roll_min,
        "signals": signals,
    }

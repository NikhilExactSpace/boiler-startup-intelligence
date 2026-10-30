"""Pydantic models for the approved design curve.

The curve is the source of truth for *what should have happened*. It is deliberately
strict:

* `design` tracks encode the expected trajectory (with an explicit, non-safety
  `analytics_default` tolerance).
* `limits` encode document-sourced boundaries. `op` describes what MUST hold, so a
  violation is simply the negation of the condition.
* every limit carries a `source_ref` pointing back at the approved procedure.

Nothing in this file encodes safety logic. It only represents approved expectations.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

Op = Literal["gt", "gte", "lt", "lte", "between", "eq"]
Severity = Literal["watch", "abort"]


class KairosBinding(BaseModel):
    metric: str
    tags: dict[str, str] = Field(default_factory=dict)


class StartupTypeConfig(BaseModel):
    enabled: bool = True
    design_duration_min: float = Field(gt=0, le=1440)


class TrackPoint(BaseModel):
    t: float
    value: float


class Track(BaseModel):
    phase: str
    points: list[TrackPoint]
    tolerance: float | None = None
    tolerance_provenance: Literal["document", "analytics_default"] = "analytics_default"
    max_rate_per_min: float | None = None
    rate_direction: Literal["up", "down", "abs"] = "up"
    source_ref: str | None = None

    @model_validator(mode="after")
    def _validate(self) -> "Track":
        if len(self.points) < 2:
            raise ValueError("a track needs at least two points")
        if self.points != sorted(self.points, key=lambda p: p.t):
            raise ValueError("track points must be sorted by time")
        if self.points[0].t == self.points[-1].t:
            raise ValueError("track points must span a non-zero time window")
        if self.tolerance is not None and self.tolerance < 0:
            raise ValueError("tolerance must be non-negative")
        return self


class Limit(BaseModel):
    key: str
    op: Op
    value: float | None = None
    min: float | None = None
    max: float | None = None
    severity: Severity
    label: str | None = None
    active_from_min: float | None = None
    active_to_min: float | None = None
    active_from_event: Literal["signal_first_truthy"] | None = None
    hold_seconds: float = 0
    min_duration_min: float = 0
    source_ref: str

    @model_validator(mode="after")
    def _validate(self) -> "Limit":
        if self.op == "between":
            if self.min is None or self.max is None or self.min >= self.max:
                raise ValueError("between limits require min < max")
        elif self.value is None:
            raise ValueError(f"{self.op} limit requires a value")
        if not self.source_ref.strip():
            raise ValueError("every limit must cite a source_ref")
        return self


class Milestone(BaseModel):
    key: str
    label: str
    value: float
    source_ref: str | None = None


class Signal(BaseModel):
    key: str
    label: str
    unit: str = ""
    kind: Literal["analog", "state"] = "analog"
    decimals: int = 2
    required: bool = True
    chart_order: int = 99
    kairos: KairosBinding
    design: list[Track] = Field(default_factory=list)
    limits: list[Limit] = Field(default_factory=list)
    milestones: list[Milestone] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique(self) -> "Signal":
        limit_keys = [limit.key for limit in self.limits]
        if len(limit_keys) != len(set(limit_keys)):
            raise ValueError(f"duplicate limit keys on signal {self.key}")
        return self


class Phase(BaseModel):
    key: str
    label: str
    order: int
    start_min: float
    end_min: float
    source_ref: str = ""
    note: str = ""

    @model_validator(mode="after")
    def _validate(self) -> "Phase":
        if self.end_min <= self.start_min:
            raise ValueError(f"phase {self.key} must have end_min > start_min")
        return self


class Prerequisite(BaseModel):
    key: str
    label: str
    signal_key: str | None = None
    op: Op = "between"
    value: float | None = None
    min: float | None = None
    max: float | None = None
    mode: Literal["auto", "manual"] = "auto"
    window_min: float = 15
    must_hold_all_samples: bool = True
    source_ref: str


class ManualCriterion(BaseModel):
    key: str
    label: str
    detail: str = ""
    source_ref: str


class CurveSource(BaseModel):
    document: str
    revision: str
    file_name: str = ""
    sha256: str = ""
    uploaded_by: str = ""
    approved_by: str = ""
    approved_at: str = ""
    notes: str = ""


class TimeOrigin(BaseModel):
    type: Literal["startup_detected", "operator_mark"] = "startup_detected"
    tag: str
    description: str = "t = 0 when the startup is detected"


class DesignCurve(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    curve_id: str
    boiler_id: str
    name: str
    status: Literal["draft", "approved"] = "draft"
    startup_type: Literal["cold", "warm", "hot"] = "cold"
    source: CurveSource
    time_origin: TimeOrigin
    phases: list[Phase]
    signals: list[Signal]
    prerequisites: list[Prerequisite] = Field(default_factory=list)
    manual_criteria: list[ManualCriterion] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    extras: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate(self) -> "DesignCurve":
        if not self.phases:
            raise ValueError("a curve needs at least one phase")
        if not self.signals:
            raise ValueError("a curve needs at least one signal")

        phase_keys = [p.key for p in self.phases]
        if len(phase_keys) != len(set(phase_keys)):
            raise ValueError("duplicate phase keys")
        signal_keys = [s.key for s in self.signals]
        if len(signal_keys) != len(set(signal_keys)):
            raise ValueError("duplicate signal keys")

        ordered = sorted(self.phases, key=lambda p: p.order)
        if abs(ordered[0].start_min) > 0.01:
            raise ValueError("the first phase must start at t=0")
        for previous, current in zip(ordered, ordered[1:]):
            if abs(previous.end_min - current.start_min) > 0.01:
                raise ValueError(
                    f"phases must be contiguous: {previous.key} ends at "
                    f"{previous.end_min}, {current.key} starts at {current.start_min}"
                )

        known_phases = set(phase_keys)
        for signal in self.signals:
            for track in signal.design:
                if track.phase not in known_phases:
                    raise ValueError(f"track on {signal.key} references unknown phase {track.phase}")

        return self

    @property
    def phase_map(self) -> dict[str, Phase]:
        return {phase.key: phase for phase in self.phases}

    @property
    def signal_map(self) -> dict[str, Signal]:
        return {signal.key: signal for signal in self.signals}

    @property
    def duration_min(self) -> float:
        return max(phase.end_min for phase in self.phases)

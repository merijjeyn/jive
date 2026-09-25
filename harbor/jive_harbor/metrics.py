"""Metrics from durable events. Missing telemetry is never inferred from a screen."""

import json
from pathlib import Path


def read_jsonl(path: Path, warnings: list[str]) -> list[dict]:
    records = []
    with path.open() as stream:
        for number, line in enumerate(stream, 1):
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    records.append(value)
            except ValueError:
                warnings.append(f"Invalid JSON at {path.name}:{number}")
    return records


def read_json(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


def _tokens(usage: dict, *keys: str) -> int | None:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            return int(value)
    return None


def _sum_known(values: list[int | None]) -> int | None:
    return sum(values) if all(v is not None for v in values) else None


def extract(logs: Path) -> tuple[dict, list[dict]]:
    warnings: list[str] = []
    execution = read_json(logs / "execution.json")
    sessions = []
    for path in sorted((logs / "native/sessions").glob("*/session.jsonl")):
        if path.parent.name not in execution.get("initial_sessions", []):
            sessions += read_jsonl(path, warnings)
    # Session snapshots duplicate execution events; raw per-graph logs are authoritative.
    events = []
    for path in sorted((logs / "native/runs").glob("*/events.jsonl")):
        if path.parent.name not in execution.get("initial_runs", []):
            events += read_jsonl(path, warnings)
    events = list({(e.get("graphId"), e.get("sequence")): e for e in events}.values())
    sessions = list({e.get("id", (e.get("sequence"), e.get("timestamp"))): e for e in sessions}.values())
    messages = [e for e in sessions if e.get("type") == "planner.message"]
    assistants = [e for e in messages if e.get("data", {}).get("message", {}).get("role") == "assistant"]
    usage = [e["data"].get("usage", {}) for e in assistants]
    has_planner = bool(sessions) or execution.get("demo", False)
    requests = [e for e in sessions if e.get("type") == "planner.request"]
    jev = [e for e in events if e.get("type") == "jev.request"]
    jev_responses = [e.get("data", {}) for e in events if e.get("type") == "jev.response"]
    nodes = {}
    for event in events:
        key = (event.get("graphId"), event.get("nodeId"))
        data = event.get("data", {})
        if event.get("type") in ("node.created", "node.started", "node.finished"):
            node = nodes.setdefault(key, {})
            node["type"] = data.get("result", {}).get("type", data.get("type", node.get("type")))
            if event["type"] == "node.started":
                node["started"] = True
    attempts_path = logs / "jev-attempts.jsonl"
    attempts = read_jsonl(attempts_path, warnings) if attempts_path.exists() else None
    values = {
        "schema_version": 1,
        "token_scope": "planner_reported",
        "agent_wall_ms": execution.get("duration_ms"),
        "planner_calls": len(requests) if has_planner else None,
        "planner_retries": sum(e.get("type") == "transport.retry" for e in sessions) if has_planner else None,
        "planner_tool_calls": sum(len(e["data"]["message"].get("tool_calls", [])) for e in assistants) if has_planner else None,
        "planner_input_tokens": _sum_known([_tokens(u, "promptTokens") for u in usage]) if has_planner else None,
        "planner_output_tokens": _sum_known([_tokens(u, "completionTokens") for u in usage]) if has_planner else None,
        "planner_cached_tokens": _sum_known([_tokens(u, "cachedTokens") for u in usage]) if has_planner else None,
        "planner_responses_with_usage": sum(bool(u) for u in usage),
        "graphs": sum(e.get("type") == "graph.started" for e in events),
        "bash_steps": sum(n.get("started", False) and n.get("type") == "bash" for n in nodes.values()),
        "jev_steps": sum(n.get("started", False) and n.get("type") == "jev" for n in nodes.values()),
        "jev_calls": len(jev),
        "jev_questions": sum(len(e.get("data", {}).get("questions", {})) for e in jev),
        "jev_http_attempts": sum(e.get("type") == "attempt" for e in attempts) if attempts is not None else None,
        "jev_http_retries": sum(e.get("type") == "retry" for e in attempts) if attempts is not None else None,
        "jev_input_tokens": _sum_known([_tokens(e.get("usage", {}), "prompt_tokens", "input_tokens", "promptTokens") for e in jev_responses]) if len(jev_responses) == len(jev) else None,
        "jev_output_tokens": _sum_known([_tokens(e.get("usage", {}), "completion_tokens", "output_tokens", "completionTokens") for e in jev_responses]) if len(jev_responses) == len(jev) else None,
        "changes_collected": execution.get("changes_collected"),
        "warnings": warnings,
        "coverage": {
            "planner_tokens": "Recorded successful planner responses; unavailable provider usage may be normalized to zero by Jive.",
            "llm_calls": "Planner requests and logical Jev evaluations are separate. Session naming, failed-attempt tokens and API calls from shell subprocesses are not included.",
            "jev_tokens": "Only known when every recorded Jev call has recognized response usage fields; retries may consume additional unreported tokens.",
        },
    }
    return values, messages


def write_outputs(logs: Path, model: str | None, version: str) -> dict:
    from harbor.models.trajectories import Agent, FinalMetrics, Metrics, Observation, ObservationResult, Step, ToolCall, Trajectory

    metrics, messages = extract(logs)
    steps = []
    calls = {}
    for event in messages:
        data = event["data"]
        message = data["message"]
        role = message.get("role")
        if role == "tool":
            step = calls.get(message.get("tool_call_id"))
            if step:
                if step.observation is None:
                    step.observation = Observation(results=[])
                step.observation.results.append(ObservationResult(source_call_id=message.get("tool_call_id"), content=message.get("content")))
            continue
        if role not in ("system", "user", "assistant"):
            continue
        step = Step(step_id=len(steps) + 1, timestamp=event.get("timestamp"),
                    source="agent" if role == "assistant" else role, message=message.get("content") or "")
        if role == "assistant":
            step.model_name = data.get("returnedModel") or model
            step.llm_call_count = 1
            step.reasoning_content = message.get("reasoning")
            usage = data.get("usage", {})
            step.metrics = Metrics(prompt_tokens=_tokens(usage, "promptTokens"),
                                   completion_tokens=_tokens(usage, "completionTokens"), cached_tokens=_tokens(usage, "cachedTokens"))
            tool_calls = []
            for call in message.get("tool_calls", []):
                function = call.get("function", {})
                raw = function.get("arguments", "{}")
                try:
                    arguments = json.loads(raw)
                except (ValueError, TypeError):
                    arguments = {"raw": raw}
                if not isinstance(arguments, dict):
                    arguments = {"raw": raw}
                tool_calls.append(ToolCall(tool_call_id=call["id"], function_name=function["name"], arguments=arguments))
                calls[call["id"]] = step
            step.tool_calls = tool_calls or None
        steps.append(step)
    (logs / "metrics.json").write_text(json.dumps(metrics, indent=2))
    if steps:
        trajectory = Trajectory(
            agent=Agent(name="jive", version=version, model_name=model), steps=steps,
            notes="Planner conversation. Full graph traces and tool output artifacts are in native/. Token totals cover recorded planner usage only; see metrics.json for Jev counters and coverage.",
            final_metrics=FinalMetrics(total_prompt_tokens=metrics["planner_input_tokens"],
                                      total_completion_tokens=metrics["planner_output_tokens"],
                                      total_cached_tokens=metrics["planner_cached_tokens"], total_steps=len(steps), extra=metrics),
        )
        (logs / "trajectory.json").write_text(trajectory.model_dump_json(indent=2, exclude_none=True))
    return metrics

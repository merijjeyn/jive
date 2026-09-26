"""Export retained Harbor metrics; run jobs with Harbor's own CLI."""

import argparse
import csv
from datetime import datetime
import json
from pathlib import Path
import sys


def duration(start, end):
    if not start or not end:
        return None
    return round((datetime.fromisoformat(end.replace("Z", "+00:00")) - datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds() * 1000)


def report(directory: Path) -> list[dict]:
    rows = []
    for path in sorted(directory.rglob("result.json")):
        value = json.loads(path.read_text())
        if "trial_name" not in value or "agent_info" not in value:
            continue
        agent = value.get("agent_result") or {}
        contexts = [agent] if agent else [s["agent_result"] for s in value.get("step_results") or [] if s.get("agent_result")]

        def total(key):
            values = [c.get(key) for c in contexts]
            return sum(values) if values and all(v is not None for v in values) else None

        trajectory_paths = [path.parent / "agent/trajectory.json"]
        trajectory_paths += sorted((path.parent / "steps").glob("*/agent/trajectory.json"))
        agent_steps = []
        found = False
        for trajectory_path in trajectory_paths:
            if trajectory_path.exists():
                found = True
                trajectory = json.loads(trajectory_path.read_text())
                agent_steps += [s for s in trajectory.get("steps", []) if s.get("source") == "agent" and not s.get("is_copied_context")]
        counts = [s.get("llm_call_count") for s in agent_steps]
        phase = value.get("agent_execution") or {}
        row = {
            "trial": value["trial_name"], "task": value["task_name"],
            "agent": value["agent_info"]["name"],
            "model": (value["agent_info"].get("model_info") or {}).get("name"),
            "error": (value.get("exception_info") or {}).get("exception_type"),
            "rewards": (value.get("verifier_result") or {}).get("rewards"),
            "trial_wall_ms": duration(value.get("started_at"), value.get("finished_at")),
            "agent_wall_ms": duration(phase.get("started_at"), phase.get("finished_at")),
            "input_tokens": total("n_input_tokens"), "output_tokens": total("n_output_tokens"),
            "cached_tokens": total("n_cache_tokens"), "cost_usd": total("cost_usd"),
            "trajectory_llm_calls": sum(counts) if found and all(n is not None for n in counts) else None,
            "trajectory_tool_calls": sum(len(s.get("tool_calls") or []) for s in agent_steps) if found else None,
            "result_path": str(path.resolve()),
        }
        jive = (agent.get("metadata") or {}).get("jive")
        if jive:
            for key, v in jive.items():
                if key not in ("coverage", "warnings", "schema_version"):
                    row[f"jive_{key}"] = v
            row["coverage"] = jive["coverage"]
            row["warnings"] = jive["warnings"]
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description="Export retained Harbor trial metrics")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--format", choices=("json", "csv"), default="json")
    options = parser.parse_args()
    if not options.directory.is_dir():
        parser.error(f"Not a results directory: {options.directory}")
    rows = report(options.directory)
    if options.format == "json":
        print(json.dumps(rows, indent=2))
    elif rows:
        writer = csv.DictWriter(sys.stdout, fieldnames=list(dict.fromkeys(key for row in rows for key in row)))
        writer.writeheader()
        writer.writerows({key: json.dumps(v) if isinstance(v, (dict, list)) else v for key, v in row.items()} for row in rows)


if __name__ == "__main__":
    main()

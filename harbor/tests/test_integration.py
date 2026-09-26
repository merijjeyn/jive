import json
from pathlib import Path
import tempfile
import unittest

from harbor.models.task.task import Task
from harbor.models.trajectories import Trajectory
from jive_harbor.report import report
from jive_harbor.metrics import extract, write_outputs
from jive_harbor.runtime import collect_changes, inventory
from jive_harbor.source import read_manifest, snapshot


def jsonl(path, events):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(e) + "\n" for e in events))


class MetricsTests(unittest.TestCase):
    def test_usage_tools_retries_and_no_duplicate_graph_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = [
                {"sequence": 1, "graphId": "g", "type": "graph.started"},
                {"sequence": 2, "graphId": "g", "nodeId": "bash", "type": "node.created", "data": {"type": "bash"}},
                {"sequence": 3, "graphId": "g", "nodeId": "bash", "type": "node.started"},
                {"sequence": 4, "graphId": "g", "type": "jev.request", "data": {"questions": {"a": {}, "b": {}}}},
                {"sequence": 5, "graphId": "g", "type": "jev.response", "data": {"usage": {"input_tokens": 11, "output_tokens": 7}}},
            ]
            jsonl(root / "native/runs/g/events.jsonl", events + [events[-1]])
            session = [
                {"id": "q", "type": "planner.request"},
                {"id": "retry", "type": "transport.retry"},
                {"id": "u", "type": "planner.message", "data": {"message": {"role": "user", "content": "Fix it"}}},
                {"id": "a", "type": "planner.message", "data": {"message": {"role": "assistant", "content": None, "tool_calls": [{"id": "call", "function": {"name": "execute_graph", "arguments": "{}"}}]}, "usage": {"promptTokens": 100, "completionTokens": 20, "cachedTokens": 30}}},
                {"id": "t", "type": "planner.message", "data": {"message": {"role": "tool", "tool_call_id": "call", "content": "done"}}},
                *[{"id": f"e{i}", "type": "execution.event", "data": {"event": event}} for i, event in enumerate(events)],
            ]
            jsonl(root / "native/sessions/s/session.jsonl", session + [session[3]])
            jsonl(root / "jev-attempts.jsonl", [{"type": "attempt"}, {"type": "retry"}, {"type": "attempt"}])
            metrics = write_outputs(root, "provider/model", "test")
            self.assertEqual(metrics["planner_input_tokens"], 100)
            self.assertEqual(metrics["planner_output_tokens"], 20)
            self.assertEqual(metrics["planner_cached_tokens"], 30)
            self.assertEqual(metrics["planner_calls"], 1)
            self.assertEqual(metrics["planner_retries"], 1)
            self.assertEqual(metrics["planner_tool_calls"], 1)
            self.assertEqual(metrics["bash_steps"], 1)
            self.assertEqual(metrics["graphs"], 1)
            self.assertEqual(metrics["jev_calls"], 1)
            self.assertEqual(metrics["jev_questions"], 2)
            self.assertEqual(metrics["jev_http_attempts"], 2)
            self.assertEqual(metrics["jev_http_retries"], 1)
            self.assertEqual(metrics["jev_input_tokens"], 11)
            trajectory = Trajectory.model_validate_json((root / "trajectory.json").read_text())
            self.assertEqual(trajectory.steps[1].observation.results[0].source_call_id, "call")

    def test_missing_usage_and_truncated_logs_are_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "native/runs/g/events.jsonl"
            jsonl(path, [{"graphId": "g", "sequence": 1, "type": "jev.request"}])
            with path.open("a") as stream:
                stream.write('{"sequence":')
            metrics, _ = extract(root)
            self.assertIsNone(metrics["planner_input_tokens"])
            self.assertIsNone(metrics["jev_input_tokens"])
            self.assertIsNone(metrics["jev_http_attempts"])
            self.assertEqual(metrics["jev_calls"], 1)
            self.assertEqual(len(metrics["warnings"]), 1)

    def test_existing_task_sessions_are_not_billed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "execution.json").write_text(json.dumps({"initial_sessions": ["old"]}))
            jsonl(root / "native/sessions/old/session.jsonl", [{"id": "old", "type": "planner.request"}])
            metrics, _ = extract(root)
            self.assertIsNone(metrics["planner_calls"])

    def test_generic_report_keeps_unknown_call_counts_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            trial = Path(directory) / "trial"
            (trial / "agent").mkdir(parents=True)
            (trial / "result.json").write_text(json.dumps({
                "trial_name": "trial", "task_name": "task", "agent_info": {"name": "codex"},
                "started_at": "2026-01-01T00:00:00Z", "finished_at": "2026-01-01T00:00:05Z",
                "agent_result": {"n_input_tokens": 100, "n_output_tokens": 10},
            }))
            (trial / "agent/trajectory.json").write_text(json.dumps({"steps": [
                {"source": "agent", "tool_calls": [{"tool_call_id": "c"}]},
            ]}))
            row = report(Path(directory))[0]
            self.assertEqual(row["trial_wall_ms"], 5000)
            self.assertIsNone(row["trajectory_llm_calls"])
            self.assertEqual(row["trajectory_tool_calls"], 1)
            self.assertEqual(row["input_tokens"], 100)


class ArtifactTests(unittest.TestCase):
    def test_changed_new_deleted_binary_and_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "work"
            root.mkdir()
            (root / "changed").write_text("before")
            (root / "deleted").write_text("deleted")
            (root / ".env").write_text("PRIVATE=secret")
            before = inventory(root)
            (root / "changed").write_text("after")
            (root / "deleted").unlink()
            (root / "binary").write_bytes(b"\x00\x01")
            (root / "link").symlink_to("/outside/workspace")
            output = Path(directory) / "artifacts"
            collect_changes(root, before, output)
            changes = {c["path"]: c for c in json.loads((output / "manifest.json").read_text())["changes"]}
            self.assertEqual(set(changes), {"changed", "deleted", "binary", "link"})
            self.assertIsNone(changes["deleted"]["after"])
            self.assertEqual((output / "files/binary").read_bytes(), b"\x00\x01")
            self.assertEqual(changes["link"]["after"]["link"], "/outside/workspace")

    def test_bundle_excludes_workspaces_secrets_and_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            for name, text in {"package.json": '{"version":"1"}', "bun.lock": "lock", "bin/jive": "entry", "bin/jive.ts": "entry", "src/cli.tsx": "source", ".env": "secret", "taskground/fixture": "huge", "node_modules/pkg": "huge"}.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            bundle = snapshot(root, Path(directory) / "cache")
            manifest = read_manifest(bundle)
            self.assertEqual(set(manifest["files"]), {"package.json", "bun.lock", "bin/jive", "bin/jive.ts", "src/cli.tsx"})
            self.assertEqual(bundle, snapshot(root, Path(directory) / "cache"))
            with bundle.open("ab") as stream:
                stream.write(b"tampered")
            with self.assertRaisesRegex(ValueError, "checksum"):
                read_manifest(bundle)

    def test_example_uses_real_harbor_schema(self):
        task = Task(Path(__file__).resolve().parents[1] / "tasks/fix-average")
        self.assertEqual(task.name, "jive/fix-average")


if __name__ == "__main__":
    unittest.main()

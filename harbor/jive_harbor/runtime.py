"""Runs inside the sandbox; only Python's standard library is required."""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

EXCLUDED = {".git", ".jev", ".context", "node_modules", ".cache", "__pycache__", ".venv"}


def inventory(root: Path) -> dict:
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED)
        links = [d for d in dirs if (Path(directory) / d).is_symlink()]
        dirs[:] = [d for d in dirs if d not in links]
        for name in sorted(files + links):
            if name == ".env" or name.startswith(".env.") or name in EXCLUDED:
                continue
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                result[relative] = {"link": os.readlink(path)}
            elif path.is_file():
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                result[relative] = {"sha256": digest, "mode": path.stat().st_mode & 0o777}
    return result


def collect_changes(root: Path, before: dict, destination: Path) -> None:
    after = inventory(root)
    changes = []
    for name in sorted(before.keys() | after.keys()):
        if before.get(name) == after.get(name):
            continue
        change = {"path": name, "before": before.get(name), "after": after.get(name)}
        changes.append(change)
        if name in after and "link" not in after[name]:
            target = destination / "files" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / name, target)
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "manifest.json").write_text(json.dumps({
        "schema_version": 1, "changes": changes,
        "excluded_names": sorted(EXCLUDED | {".env", ".env.*"}),
    }, indent=2))


def main() -> int:
    config = json.loads(Path(sys.argv[1]).read_text())
    logs = Path(config["logs"])
    root = Path.cwd().resolve()
    if root == Path("/"):
        raise RuntimeError("Task must set a working directory such as /app")
    if logs == root or root in logs.parents:
        raise RuntimeError("Agent logs must be outside the task working directory")
    native = logs / "native"
    local = root / ".jev"
    if local.is_symlink():
        raise RuntimeError("Task .jev directory must not already be a symlink")
    if local.exists():
        shutil.move(str(local), str(native))
    else:
        native.mkdir(parents=True)
    local.symlink_to(native, target_is_directory=True)
    attempts = logs / "jev-attempts.jsonl"
    attempts.touch()
    before = inventory(root)
    (logs / "workspace-before.json").write_text(json.dumps(before))
    # The package's optional Bun npm shim needs postinstall; use our pinned runtime.
    # Native session/graph logs retain the full trace. Planner --json repeats the
    # entire growing state on each update, producing hundreds of MB per task.
    argv = ["/usr/local/bin/bun", "/opt/jive/bin/jive.ts", "--headless", "--cwd", str(root)]
    if config.get("demo"):
        argv += ["--demo", "--json"]
    else:
        argv += ["--model", config["model"], "--prompt", config["instruction"]]
        if config.get("effort"):
            argv += ["--effort", config["effort"]]
    env = {**os.environ, "JEV_METRICS_FILE": str(attempts)}
    state = {"started_at": datetime.now(timezone.utc).isoformat(), "cwd": str(root), "demo": config.get("demo", False),
             "initial_sessions": [p.name for p in (native / "sessions").glob("*")],
             "initial_runs": [p.name for p in (native / "runs").glob("*")]}
    (logs / "execution.json").write_text(json.dumps(state))
    started = time.monotonic()
    stdout_name = "stdout.jsonl" if config.get("demo") else "stdout.log"
    with (logs / stdout_name).open("wb") as stdout, (logs / "stderr.log").open("wb") as stderr:
        child = subprocess.Popen(argv, env=env, stdout=stdout, stderr=stderr, start_new_session=True)

        def stop(signum, frame):
            try:
                os.killpg(child.pid, signal.SIGINT)
            except ProcessLookupError:
                pass

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            code = child.wait()
        finally:
            # End background commands before taking the final workspace inventory.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            state.update(finished_at=datetime.now(timezone.utc).isoformat(),
                         duration_ms=round((time.monotonic() - started) * 1000), exit_code=child.returncode)
            try:
                collect_changes(root, before, logs / "changes")
                state["changes_collected"] = True
            except Exception as exc:
                state["changes_collected"] = False
                state["collection_error"] = str(exc)
            (logs / "execution.json").write_text(json.dumps(state, indent=2))
    return code if code else (0 if state["changes_collected"] else 1)


if __name__ == "__main__":
    raise SystemExit(main())

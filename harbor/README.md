# Jive + Harbor

Standalone benchmark execution using **Harbor 0.23.0** and Docker. Taskground and
its existing tasks are independent and unchanged. This integration provides a
Jive installed-agent adapter, an example custom task, and JSON/CSV metrics export.
Use Harbor's own CLI and viewer for scheduling, concurrency and result browsing.
Pause/resume, interactive terminal attachment and recording are outside this integration.

## Start

Requirements: Docker running, `uv`, Python 3.12+, and internet access for image,
runtime and dependency downloads. The Jive adapter initially supports Debian/Ubuntu
glibc Linux task images on ARM64 and x86-64, with root available during installation.

Run all commands below from this directory:

```sh
cd harbor
uv sync --python 3.12 --locked

# Reference implementation: must score 1. No model calls.
uv run harbor run -p tasks/fix-average -a oracle -n 1
# Unmodified task: must score 0. No model calls.
uv run harbor run -p tasks/fix-average -a nop -n 1

# Freeze the current checkout and run Jive. Choose an OpenRouter model ID.
export JIVE_MODEL='your-provider/your-model'
uv run jive-harbor run -p tasks/fix-average -m "$JIVE_MODEL" \
  --env-file ../.env --ak effort=high -n 1

# Open Harbor's own local results UI.
uv run harbor view jobs
```

Jive uses `OPENROUTER_API_KEY`; Jev nodes additionally need `JEV_API_TOKEN`
(or `TYPESAFE_API_KEY`). `JEV_MODEL` is optional. These can be exported in the
shell instead of using `--env-file`. Credentials are injected into the agent
process, never into the source bundle or task image.

The `jive-harbor run` wrapper freezes this checkout's runtime source once before
launching Harbor, then forwards the remaining arguments to `harbor run`. It does
not select the primary Git worktree or copy Taskground. Bundles are stored once
per content/provenance hash in `.cache/sources/`. A bundle contains only Jive's
`src/`, entry points, package manifest and lockfile. It includes current local
source edits. Each trial installs that bundle inside its own container; initial
installation still downloads Bun/dependencies. Task image layers are Docker-cached.
Keep bundles referenced by retained runs if you want to reproduce their Jive build.

```sh
# Exercise Jive installation, graph execution and metrics without inference.
# It runs Jive's fixture graph, which does NOT solve fix-average: reward 0 is expected.
uv run jive-harbor run -p tasks/fix-average --ak demo=true -n 1

# Use an upstream dataset; confirm its exact name/version with the registry.
uv run harbor datasets list
uv run jive-harbor run -d 'DATASET@VERSION' -m "$JIVE_MODEL" -n 2

# Inspect the frozen bundle path when building a reusable Harbor job config.
uv run jive-harbor snapshot
```

Custom agents use `jive_harbor.agent:JiveAgent` as their import path. With raw
Harbor configuration, pass `source_bundle` in the agent kwargs. The adapter uses
the exact supplied model ID and accepts `effort`. It does not yet configure task
MCP servers, skills, Windows, or resumed/multi-step agent sessions.

## Claude Code and Codex

Use Harbor's built-in adapters directly. Model IDs and settings must be supported
by the selected harness and provider:

```sh
uv run harbor run -p tasks/fix-average -a claude-code -m "$CLAUDE_MODEL" \
  --ak reasoning_effort=high -n 1
uv run harbor run -p tasks/fix-average -a codex -m "$CODEX_MODEL" \
  --ak reasoning_effort=high -n 1

# Optional native harness configuration (supply your own file).
uv run harbor run -p tasks/fix-average -a codex -m "$CODEX_MODEL" \
  --ak config=/absolute/path/to/config.toml -n 1
```

Set credentials in the shell or through Harbor's agent environment flags.
Harbor supports native Claude settings and Codex configuration files; use those
and the agent's endpoint/auth environment settings for custom providers. Jive's
planner remains on OpenRouter. Pin agent versions with `--ak version=VERSION`
for comparisons; avoid silently upgrading harnesses between experiments.

## Metrics and retained results

```sh
uv run jive-harbor report jobs/JOB_NAME
uv run jive-harbor report jobs/JOB_NAME --format csv > metrics.csv
```

The exporter also reads Claude/Codex Harbor results. Each JSON row represents a
trial; CSV keeps the same fields, with structured fields serialized as JSON.
Unknown values are `null` in JSON and empty in CSV.

| Metric | Meaning/source |
| --- | --- |
| `trial_wall_ms` | Harbor trial start to finish, including setup and verification; excludes queue waiting |
| `agent_wall_ms` | Harbor agent-execution phase; setup and verification excluded |
| `input_tokens`, `output_tokens`, `cached_tokens` | Harbor agent-reported usage; input includes cached tokens |
| `trajectory_llm_calls` | Sum of explicit ATIF inference counts; unknown if an adapter omits them |
| `trajectory_tool_calls` | Tool calls in the top-level ATIF trajectory; not shell commands or graph leaf nodes |
| `jive_planner_calls` | Logical `planner.request` events |
| `jive_planner_retries` | Planner transport retry notices, separate from logical requests |
| `jive_planner_tool_calls` | Planner calls to graph tools, including rejected calls |
| `jive_bash_steps`, `jive_jev_steps` | Started graph leaf executions; loop containers excluded |
| `jive_jev_calls`, `jive_jev_questions` | Logical Jev requests and questions within those requests |
| `jive_jev_http_attempts`, `jive_jev_http_retries` | Instrumented Jev transport attempts/retries |
| `jive_jev_input_tokens`, `jive_jev_output_tokens` | Jev response usage, only when recognized fields cover every recorded call |

For Jive, Harbor's standard token fields and ATIF totals deliberately contain
**recorded planner usage only**. Jev usage remains separate. Session-naming calls,
tokens spent on failed/retried requests without usage, and API calls made by shell
subprocesses are not comprehensively metered. Jive may normalize missing provider
usage to zero; these counters are not a billing ledger. No total LLM-call or total
token figure is invented across these gaps. Full accounting would require additional
transport instrumentation or a metered gateway. Cost remains unknown for Jive.

Every Jive trial retains:

```text
jobs/JOB/TRIAL/
  result.json                 # Harbor timings, score, errors and agent metrics
  agent/
    source.json               # Jive revision, dirty flag and runtime content hash
    stdout.jsonl, stderr.log   # Original CLI output
    native/                   # Live Jive sessions, graph events and full artifacts
    jev-attempts.jsonl         # HTTP attempt/retry telemetry
    execution.json            # Agent timing and workspace collection status
    metrics.json              # Jive counters and coverage limitations
    trajectory.json           # ATIF planner conversation, when a session exists
    workspace-before.json     # Initial file hashes/modes
    changes/manifest.json     # Added, modified, deleted files and symlink metadata
    changes/files/            # Final bytes of added/modified files, including binaries
  verifier/                   # Reward, test output and detailed checks
  artifacts/                  # Task-declared outputs collected by Harbor
```

The fixture-only demo has graph traces but no planner conversation/ATIF file.
The adapter places `.jev` in Harbor's mounted agent log directory so traces survive
container deletion. Workspace changes are collected at normal process completion,
including failed exits. A hard container kill can prevent that final collection;
inspect `changes_collected` and Harbor's artifact manifest. Workspace capture covers
the task working directory and excludes credentials, Git internals, `.jev`, caches,
and dependency directories (exact exclusions are recorded). It saves final changed
files and deletion/link metadata, not every intermediate file revision. Declare
important outputs outside the working directory in `task.toml`.

## Create a custom task

Use `tasks/fix-average/` as a complete example, or scaffold another task:

```sh
uv run harbor task init jive/my-task --tasks-dir tasks
```

```text
tasks/my-task/
  instruction.md              # What the agent must accomplish
  task.toml                   # Identity, resource limits, timeouts, artifacts
  environment/Dockerfile      # Agent-visible environment with a WORKDIR
  environment/...             # Starting files and public tests
  tests/test.sh               # Verification entry point, injected after execution
  tests/...                   # Held-out tests and reference data
  solution/solve.sh            # Reference solution used by the oracle agent
```

1. Put the task instruction in `instruction.md`. Keep it identical across agents.
2. Build the starting environment in `environment/Dockerfile`. Use a bounded work
   directory such as `/app`. Copy only agent-visible files into the image. Pin
   upstream revisions and verify downloaded checksums for external fixtures.
3. Set CPU, memory and time budgets in `task.toml`. Declare outputs to retain with
   `artifacts = ["/app/report.json"]`. Jive's extra trace/change capture is adapter-specific;
   explicit artifact declarations also work with Claude and Codex.
4. Make `tests/test.sh` run your verifier and write `/logs/verifier/reward.txt`
   (one numeric reward) or `reward.json` (named numeric rewards). Save detailed
   checks next to it. A wrong answer should produce a zero reward; infrastructure
   failures should remain errors. Keep tests/reference answers outside the agent image.
5. Add a reference solution, then run both oracle and nop. The reference should
   pass and the untouched starting state should fail before spending model tokens.

The sample verifier uses five held-out checks and emits `{"accuracy": 0.0}` or
`{"accuracy": 1.0}`. A task can score partial credit or multiple dimensions. For
stronger separation, Harbor supports a separate verifier environment; specify the
files transferred to it as artifacts. Performance tasks need controlled CPU/memory
and grading concurrency when comparing timings.

## Development checks

```sh
uv run python -m unittest discover -s tests -v
```

Harbor is pinned in `pyproject.toml` and dependencies in `uv.lock`. Keep this bridge
small and use the pinned Harbor schemas as the authority when changing it.

References: [custom agents](https://docs.harborframework.com/core-concepts/agents/custom-agents),
[task structure](https://docs.harborframework.com/core-concepts/tasks/overview),
[verifiers](https://docs.harborframework.com/core-concepts/tasks/verifier),
[ATIF](https://docs.harborframework.com/core-concepts/agents/atif),
[artifact collection](https://docs.harborframework.com/core-concepts/jobs/artifact-collection).

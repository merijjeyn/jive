# Jive + Harbor

Standalone benchmark execution using **Harbor 0.23.0** and Docker. Taskground and
its existing tasks are independent and unchanged. This integration provides a
Jive installed-agent adapter, an example custom task, and JSON/CSV metrics export.
Run every agent with Harbor's own CLI. There is no separate runner executable.
Use Harbor's viewer for progress and result browsing. Live pause/resume,
interactive terminal attachment and recording are outside this integration.

## Start

Requirements: Docker running, `uv`, Python 3.12+, and internet access for image,
runtime and dependency downloads. The Jive adapter initially supports Debian/Ubuntu
glibc Linux task images on ARM64 and x86-64, with root available during installation.

From the project root, enter this directory once. Run the remaining commands
from `harbor/`:

```sh
cd harbor
uv sync --python 3.12 --locked
mkdir -p jobs
```

`uv run harbor` runs the pinned Harbor installation with the local Jive adapter
available to import. Every run below explicitly uses `--jobs-dir jobs`, which
resolves to **`<project-root>/harbor/jobs`** from this directory. Use a fresh
`--job-name` for each run, or omit it to use Harbor's timestamp default.

## Run the custom Jive adapter

Prepare an immutable bundle of this checkout, then pass its absolute path to
Harbor. Keep using the same shell for commands that reference `JIVE_BUNDLE`:

```sh
JIVE_BUNDLE="$(uv run python -m jive_harbor.source)"
export JIVE_MODEL='your-provider/your-model'

uv run harbor run -p tasks/fix-average \
  --agent jive_harbor.agent:JiveAgent \
  --ak "source_bundle=$JIVE_BUNDLE" --ak effort=high \
  --model "$JIVE_MODEL" --env-file ../.env \
  --jobs-dir jobs --job-name jive-fix-average -n 1
```

The Python preparation command only writes a source archive and prints its path;
Harbor launches and manages the job. Re-run that preparation command after editing
Jive to include your new code in subsequent jobs. Reuse the existing bundle to
compare models against exactly the same Jive build.

Jive uses `OPENROUTER_API_KEY`; Jev nodes additionally need `JEV_API_TOKEN`
(or `TYPESAFE_API_KEY`). `JEV_MODEL` is optional. These can be exported in the
shell instead of using `--env-file`. Credentials are injected into the agent
process, never into the source bundle or task image.

Bundles are stored once per content/provenance hash in `.cache/sources/`. A bundle
contains only this checkout's Jive `src/`, entry points, package manifest and
lockfile, including local source edits. Each trial installs that bundle inside
its own container; initial installation still downloads Bun/dependencies. Task
image layers are Docker-cached. Keep bundles referenced by retained runs if you
want to reproduce their Jive build.

The adapter uses the exact supplied OpenRouter model ID and accepts `effort`.
Jive's headless mode skips automatic session naming, avoiding the extra model
request and its process-exit delay. No additional Harbor option is needed.
Sessions keep their fallback names; native traces and task results are still saved.
Regenerate `JIVE_BUNDLE` to include this behavior; older source bundles still
perform automatic naming in headless mode.
It does not yet configure task MCP servers, skills, Windows, or resumed/multi-step
agent sessions. Compatibility with upstream datasets depends on their task images
and agent requirements.

## Run without model calls

```sh
# Reference implementation: must score 1. No model calls.
uv run harbor run -p tasks/fix-average -a oracle -n 1 \
  --jobs-dir jobs --job-name oracle-fix-average
# Unmodified task: must score 0. No model calls.
uv run harbor run -p tasks/fix-average -a nop -n 1 \
  --jobs-dir jobs --job-name nop-fix-average

# Exercise Jive installation, graph execution and metrics without inference.
# Prepare JIVE_BUNDLE as above. The fixture does not solve the task; reward 0 is expected.
uv run harbor run -p tasks/fix-average \
  -a jive_harbor.agent:JiveAgent \
  --ak "source_bundle=$JIVE_BUNDLE" --ak demo=true -n 1 \
  --jobs-dir jobs --job-name jive-demo
```

## Select other agents and models

Built-in agents need no Jive source bundle. Set the model IDs for your chosen
harness/provider and its credentials in the shell or `../.env`:

```sh
export CLAUDE_MODEL='your-claude-model-id'
export CODEX_MODEL='your-codex-model-id'

uv run harbor run -p tasks/fix-average -a claude-code -m "$CLAUDE_MODEL" \
  --ak reasoning_effort=high --env-file ../.env -n 1 \
  --jobs-dir jobs --job-name claude-fix-average

uv run harbor run -p tasks/fix-average -a codex -m "$CODEX_MODEL" \
  --ak reasoning_effort=high --env-file ../.env -n 1 \
  --jobs-dir jobs --job-name codex-fix-average

# Optional native harness configuration (supply your own file).
uv run harbor run -p tasks/fix-average -a codex -m "$CODEX_MODEL" \
  --ak config=/absolute/path/to/config.toml --env-file ../.env -n 1 \
  --jobs-dir jobs --job-name codex-custom-config
```

Change `-m` to compare models while keeping the agent, task selection and other
settings fixed. Reasoning settings must be supported by that agent/model; Jive
uses `--ak effort=high`, while the built-in Claude/Codex adapters use
`--ak reasoning_effort=high`. Pin built-in agent versions with
`--ak version=VERSION` for comparisons. Jive's build is pinned by `source_bundle`.

Harbor supports native Claude settings and Codex configuration files. Use those
and the agent's endpoint/auth environment settings for custom providers; selecting
a model alone does not configure a custom endpoint. Jive's planner uses OpenRouter.

## Published benchmarks, subsets and concurrency

Find datasets and their versions in the
[Harbor Hub catalog](https://hub.harborframework.com/datasets?scope=all), or open
the registry link with `uv run harbor datasets list`. Replace the placeholder
below with the dataset's published `org/name@version`:

```sh
export HARBOR_DATASET='org/dataset@version'

# Five tasks, at most two concurrent trials, one attempt per task.
uv run harbor run -d "$HARBOR_DATASET" \
  -a jive_harbor.agent:JiveAgent --ak "source_bundle=$JIVE_BUNDLE" \
  -m "$JIVE_MODEL" --env-file ../.env \
  --n-tasks 5 -n 2 -k 1 --jobs-dir jobs --job-name jive-benchmark-smoke

# The same selection with a built-in agent.
uv run harbor run -d "$HARBOR_DATASET" -a claude-code -m "$CLAUDE_MODEL" \
  --env-file ../.env --n-tasks 5 -n 2 -k 1 \
  --jobs-dir jobs --job-name claude-benchmark-smoke

# Specific tasks: replace these names with names from the dataset.
uv run harbor run -d "$HARBOR_DATASET" \
  -a jive_harbor.agent:JiveAgent --ak "source_bundle=$JIVE_BUNDLE" \
  -m "$JIVE_MODEL" --env-file ../.env \
  -i 'task-a' -i 'task-b' -n 2 \
  --jobs-dir jobs --job-name jive-selected-tasks
```

| Flag | Use |
| --- | --- |
| `-p tasks/fix-average` | Run one local task; a directory of tasks is also accepted |
| `-d org/dataset@version` | Run a published dataset pinned to a version |
| `-i 'prefix-*'` | Include names matching a glob; repeat `-i` to include multiple patterns |
| `-x 'task-name'` | Exclude a name or glob; repeatable |
| `--n-tasks 5` / `-l 5` | Take the first five matching tasks after filters; not a random sample |
| `-n 2` | Maximum concurrent trials |
| `-k 3` | Three attempts per task/agent combination |
| `-r 1` | Up to one retry for eligible execution errors; separate from attempts |
| `--jobs-dir jobs` | Write results under this directory's `jobs/` folder |
| `--job-name NAME` | Choose the result subdirectory; omit for a timestamp |

Omit `--n-tasks`, `-i` and `-x` to run the complete dataset. Pin both the dataset
version and Jive bundle when comparing runs. Subset scores describe that subset,
not the complete benchmark. See `uv run harbor run --help` for all options.

### SWE-bench on Apple Silicon

The tested SWE-bench Verified tasks use x86-64 images. On an ARM Mac, add
`--extra-docker-compose configs/linux-amd64.yaml` to the run command to select
Docker's x86-64 emulation. Start with `-n 1`; each tested task requests 4 GB RAM.

Check free space in Docker Desktop's virtual disk before downloading benchmark
images. Free space on the Mac itself does not guarantee free space inside Docker.
A full Docker disk can cause both image extraction failures and misleading APT
"invalid signature" errors during agent installation. Container cleanup leaves
build caches behind, so concurrency alone does not bound image/cache disk usage.

## Save and reuse a Harbor job config

Harbor can save the same CLI settings to a config file without starting a run:

```sh
uv run harbor job init .cache/jive-job.yaml \
  -p tasks/fix-average -a jive_harbor.agent:JiveAgent \
  --ak "source_bundle=$JIVE_BUNDLE" --ak effort=high \
  -m "$JIVE_MODEL" -n 2 --jobs-dir jobs

# Inspect the resolved config without launching trials.
uv run harbor run --config .cache/jive-job.yaml --print-config

# Run it, supplying credentials at execution time.
uv run harbor run --config .cache/jive-job.yaml --env-file ../.env \
  --jobs-dir jobs --job-name jive-from-config
```

The config records the absolute bundle path. To use later Jive edits, prepare a
new bundle and replace that setting with `--ak "source_bundle=$JIVE_BUNDLE"`.

## Monitor and cancel jobs

The launching terminal shows live progress and active trial phases. In a second
terminal, enter `harbor/` and open Harbor's local browser UI:

```sh
uv run harbor view jobs --jobs
```

Open the printed URL (normally `http://127.0.0.1:8080`) and keep the viewer running.
It shows jobs, trial progress, rewards, errors, reported tokens/costs, trajectories
and retained files. The job detail page refreshes while running. Jive's normalized
metrics and ATIF trajectory are generated after the agent phase; native logs are
written during execution. This UI is separate from Taskground and the Hub website.

Press **Ctrl+C once in the launching terminal** to cancel a CLI job, and allow
Harbor to finish cleanup. Completed results remain; interrupted trials may have
partial traces or workspace changes. Harbor's viewer also offers a **New run**
form and a **Stop** button for jobs launched by that viewer instance. It cannot
stop a job launched in another terminal. Launching Jive from the viewer requires
the custom adapter import path and prepared `source_bundle` in the job config.

## Metrics and retained results

Harbor writes its standard `result.json` files and the adapter retains the Jive
metrics described below. For optional JSON/CSV analysis, use the local exporter:

```sh
uv run python -m jive_harbor.report jobs/JOB_NAME
uv run python -m jive_harbor.report jobs/JOB_NAME --format csv > metrics.csv
```

This module only reads retained results; it does not launch or manage jobs. It
also reads Claude/Codex Harbor results. Each JSON row represents a trial; CSV
keeps the same fields, with structured fields serialized as JSON. Unknown values
are `null` in JSON and empty in CSV.

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
**recorded planner usage only**. Jev usage remains separate. Session naming is
disabled for new Jive runs; naming calls in older runs are not included. Tokens
spent on failed/retried requests without usage and API calls made by shell
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
    stdout.log, stderr.log     # Original CLI output (demo uses stdout.jsonl)
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
Normal planner runs omit Jive's `--json` snapshot stream to avoid repeatedly
serializing the entire growing state. Full planner and graph traces remain in
`native/`; `stdout.log` retains the CLI's final text output. Older runs may have
`stdout.jsonl`, or a lossless `stdout.jsonl.gz` archive with a checksum recorded
in `stdout-archive.json`.
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

References: [job commands](https://docs.harborframework.com/core-concepts/jobs/run-a-job),
[viewer](https://docs.harborframework.com/core-concepts/results/view-job-results),
[custom agents](https://docs.harborframework.com/core-concepts/agents/custom-agents),
[task structure](https://docs.harborframework.com/core-concepts/tasks/overview),
[verifiers](https://docs.harborframework.com/core-concepts/tasks/verifier),
[ATIF](https://docs.harborframework.com/core-concepts/agents/atif),
[artifact collection](https://docs.harborframework.com/core-concepts/jobs/artifact-collection).

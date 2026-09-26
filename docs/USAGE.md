# Using Jive

This guide covers the interactive terminal UI, sessions, headless commands, and
per-project configuration. The [overview](README.md) has installation and a
short tour; [GRAPH_CONTRACT.md](GRAPH_CONTRACT.md) describes the graphs the
planner writes; [CONTEXT.md](CONTEXT.md) covers context and compaction.

## Working directory and credentials

`jive` works in the directory you launch it from. `AGENTS.md`, `.jive/skills`,
`.jev/extractors`, `.jev/sessions`, and the model cache are read and written
there, so each project keeps its own sessions and records. `--cwd DIR`
overrides the directory.

Credentials come from the `.env` in the working directory, then any `.env`
further up the tree, and finally the `.env` in the Jive checkout. A project can
therefore override the global keys with its own `.env`.

```dotenv
OPENROUTER_API_KEY=...   # planner model
JEV_API_TOKEN=...        # Jev decision service, used by `jev` nodes
OPENROUTER_MODEL=...     # optional; default google/gemini-3.8-flash
JEV_MODEL=...            # optional; default jev-1.13.0
```

Changing models is explicit, in the UI or with `--model`. There is no automatic
model fallback.

At session creation, Jive snapshots the working directory's `AGENTS.md` into the
system prompt and persists the snapshot with the session. Edits to the file take
effect in a new session (`/new`). Project skill metadata is snapshotted the same
way; see [Project skills](#project-skills).

Every planning request also receives runtime facts: the session cwd, runtime and
contract versions, the configured Jev model and whether credentials are present
(never their values), execution limits, and graph replay support.

## The interface

The empty screen shows a looping flower drawn in Braille dots. The conversation
grows upward from a bottom composer. User messages are green; agent replies
render Markdown headings, emphasis, lists, quotes, links, tables, and code
blocks as selectable terminal text. Selecting text with the mouse copies it on
release. Thinking, writing, graph building, and execution show animated
activity indicators with elapsed time.

Type `/` for a searchable command selector.

| Command | Effect |
| --- | --- |
| `/model` | Choose the planner model |
| `/effort [LEVEL]` | Reasoning effort slider, or set directly (`low`, `medium`, `high`, `xhigh`, `auto`) |
| `/new`, `/clear` | Cancel active work and start a fresh session with the same model and effort |
| `/resume [ID]`, `/sessions` | Open the session picker, or resume by ID or unambiguous prefix |
| `/name TEXT`, `/rename TEXT` | Name the session; automatic naming will not overwrite it |
| `/pin TEXT` | Keep an instruction verbatim through compaction |
| `/quit` | Exit |

| Key | Effect |
| --- | --- |
| Ctrl+C | Interrupt active work |
| Ctrl+G | Focus the graph: arrows select rows, Space toggles a group, Enter opens the evidence inspector, `e`/`c` open or fold every group, Esc returns to chat |
| Ctrl+O | Show or hide the planner's reasoning for every round |
| Ctrl+P | Open model selection |
| Ctrl+J | Insert a newline in the composer |
| Page Up / Page Down | Scroll the conversation |

### Graph display

Graph definitions appear as building nodes while the planner writes them, and
real execution events update those same nodes. Completed nodes and satisfied
edges turn green; failures and handoffs are yellow; blocked work is grey.
Completed Jev nodes are purple and bash nodes green.

Loops are drawn open and cyclic: a `foreach` (`≡`) or `repeat` (`↻`) row shows
its template body once beneath it, bracketed by a loop-back lane, and every pass
re-runs status through those rows. Inspecting a body row opens the instance
behind it. A call that ends up as a single node is drawn as that node, carrying
the graph's title.

When a run changes files in the working tree, its title line ends with a summary
such as `✎ 3 files +42 −7` and the files are named beneath it, largest first.
Git decides the file set: a status taken before the run and one after it, so
ignored paths and the run's own `.jev` artifacts never appear. Outside a
repository nothing is shown.

### Reasoning and effort

The planner's reasoning for each round is kept in the transcript as a dim,
collapsible entry. Reasoning is recorded with the round, so reopening a session
restores it.

`/effort` offers only the selected model's supported levels; unavailable levels
are rejected rather than substituted. `auto` sends medium, or the nearest level
the model supports. For Anthropic models each level is sent as an explicit
thinking budget rather than an effort name. Effort persists with the session.
Model metadata follows [OpenRouter's reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

### Retries

Transient transport failures, such as rate limits, 5xx responses, dropped
connections, or streams that end early, are retried automatically: four
attempts with exponential backoff and jitter, honouring `Retry-After`. A retry
replays the whole request, so it only happens while nothing of the attempt has
reached the transcript. Once reasoning, an answer, or a tool call has streamed,
the failure is reported and the planner decides what to do.

## Sessions

Every session gets a stable friendly fallback name. In interactive mode, after
its first turn, a background request asks `google/gemma-3-27b-it` for a concise title; naming
never blocks the turn. Names are append-only session events and appear in
`--sessions` and the session picker.

Headless mode skips automatic naming, avoiding the extra model request and
waiting for it at process exit. This also applies to Harbor benchmark runs.

The session picker is scoped to the current working directory, newest first,
and searchable by name, ID, or model. Resuming drains active work, flushes the
current log, and restores the transcript, reasoning, graph events, model, and
effort. A missing or corrupt target leaves the current session active.

```sh
jive --sessions
jive --resume SESSION_ID
jive --resume SESSION_ID --search "previous failure"
```

Restarting restores the conversation and evidence. An unfinished graph is marked
interrupted; commands are never automatically replayed, and filesystem effects
that already happened remain in place.

Records live in `.jev/sessions/` and `.jev/runs/`. Graph records include exact
Jev inputs and answers, per-execution results, stdout/stderr artifacts, and UI
events. Command streams are stored completely, with a 2 Mi-character inline
capture bound; truncated stream references are rejected so consumers must read
the complete artifact.

## Headless commands

```sh
jive --headless --prompt "Explain the executor's failure handling"
jive --prefill "Inspect this repository"      # editable draft, interactive only
jive --run examples/parallel.json
jive --run examples/repeat.json
jive --run examples/investigate.json --json
jive --demo --headless --json
jive --models
jive --refresh-models
jive --schema
jive --version
```

`parallel.json` and `repeat.json` need no API keys. `investigate.json` uses the
Jev key to select the graph-execution source file from repository search
results, then reads that file. `--json` with a graph run streams execution
events as JSONL; the final event contains the report.

`execute_graph_mod` replays a saved graph by ID or file with optional edits:

```json
{"base":"earlier-graph-id"}
{"file":"work/graph.json"}
{"file":"work/graph.json","edits":[{"path":"/limits/concurrency","new":8}]}
```

Each call validates and executes in the active session and saves a new graph ID
without changing the source. All nodes run again; there is no result cache.
Standalone replay is `jive --cwd DIR --run FILE --json`.

## Project skills

Each project can supply skills in `.jive/skills/`, relative to the working
directory. Jive discovers `.jive/skills/*/SKILL.md` at session creation and
injects their names, descriptions, and instruction paths into the planner's
system prompt. It does not search parent directories or nested folders.
Symlinked skill directories are supported.

```text
.jive/skills/
  check-api-change/
    SKILL.md
    graph.json
    scripts/
```

`SKILL.md` starts with YAML frontmatter containing a nonempty single-line
`name` and a nonempty `description`. Describe when to use the skill so the
planner can identify relevant tasks.

```markdown
---
name: check-api-change
description: >-
  Review API changes against this project's compatibility rules.
  Use after changing routes, request formats, or response schemas.
---

Read graph.json for the starting procedure. Adapt its checks and execution
steps to the change being reviewed. Supporting scripts are in scripts/.
```

Only the catalog metadata enters the initial prompt. The agent reads a relevant
`SKILL.md` before using it, then loads whatever graphs and supporting files it
needs, for example:

```json
{"file":".jive/skills/check-api-change/graph.json","edits":[{"path":"/context/base","new":"main"}]}
```

Supporting file references in instructions are relative to the skill directory,
but graph node paths still resolve from the session cwd. Malformed metadata or
unreadable entries produce visible session notices and are skipped; duplicate
names keep the first entry and report the conflict.

## Extractor plugins

Extractors turn raw data into the choices and records that Jev decisions take.
Place a TypeScript module in `.jev/extractors/` for one project, or
`~/.config/jev-agent/extractors/` for all projects. The agent can write one with
a bash node; it becomes available in the next graph invocation.

```ts
export default {
  name: "my-extractor",
  description: "Turn JSON text into candidate records",
  inputSchema: { type: "string" },
  outputSchema: { type: "array" },
  async run(input, config, ctx) {
    ctx.log("Parsing candidates");
    return JSON.parse(input);
  }
};
```

The contract also accepts `configSchema` and `examples`. Plugins can use
`ctx.exec`, `ctx.fetch`, `ctx.artifact`, `ctx.log`, `ctx.cwd`, and `ctx.signal`.
Plugin code runs in the agent process and must cooperate with cancellation; it
is not sandboxed. Built-ins are `json`, `lines`, `rg-matches`, and `fetch-text`.
See [examples/word-records.ts](../examples/word-records.ts) for a template.

## Planner evaluation

`bun run eval:planner --model MODEL` runs an opt-in live behaviour suite in
fresh temporary workspaces and records correctness, tool rounds, parallel
structure, semantic decisions, and capability probes. See the
[evaluation guide](../evals/planner/README.md). The [taskground](../taskground/README.md)
holds larger reproducible tasks for comparing Jive with other agents.

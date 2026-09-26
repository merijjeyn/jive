# Jive documentation

Jive is a terminal coding agent that plans work as **executable graphs**. Instead
of calling one tool at a time, the planner model submits a JSON program: bash
commands and bounded model decisions wired together with data references,
branches, loops, and parallel batches. Jive runs that program locally, streams
progress into a terminal UI, and hands the evidence back to the planner. The
result is far fewer round trips for investigation, batch judgment, and
multi-step fixes.

- **One tool, whole plans.** The planner has `execute_graph` and
  `execute_graph_mod`; everything else is expressed inside the graph.
- **Execution overlaps generation.** Nodes start as soon as their definition
  has streamed in, while the planner is still writing the rest.
- **Bounded semantic decisions.** `jev` nodes ask the [Jev](https://typesafe.ai)
  decision service typed questions with explicit acceptance criteria, so
  judgments over hundreds of items run inside the graph instead of the chat.
- **Everything is recorded.** Sessions, graphs, command output, and decisions
  are saved under `.jev/` and can be resumed, inspected, and replayed.
- **Any planner model, any provider.** OpenRouter, Anthropic, OpenAI, Google,
  DeepSeek, Groq and Ollama are built in, and any OpenAI-, Anthropic- or
  Responses-compatible endpoint, such as an internal deployment, can be added in
  `~/.config/jive/models.json`. Switch with `/model` or `--model`.

Built with TypeScript, [Bun](https://bun.sh), and [OpenTUI](https://github.com/sst/opentui).
The architecture is described in [DESIGN.md](../DESIGN.md).

## Install

Requires Git and either Bun or Node.js. The one-line installer clones Jive into
`~/.jive`, installs dependencies, and links `jive` into `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/merijjeyn/jive/main/install.sh | sh
```

Run the same command again, or `jive update`, to move to the latest version.
Set `JIVE_HOME` or `JIVE_BIN` to change the locations.

Alternatively, install the published package:

```sh
bun install -g @merijjeyn/jive     # or: npm install -g @merijjeyn/jive
```

Or run from a checkout:

```sh
git clone https://github.com/merijjeyn/jive.git && cd jive
bun install                        # or: npm install (fetches a pinned Bun binary)
bun run demo                       # try the UI, no API keys needed
./bin/install.sh                   # optional: link ./bin/jive onto PATH
```

There is no build step. `jive` runs the checkout's TypeScript sources through
Bun, so a checkout always reflects the latest changes.

## Quick start

Try the interactive demo first. It simulates streamed graph generation, runs
real but harmless fixture commands, and makes no network calls:

```sh
jive --demo
```

For the real agent, create a `.env` in your project (or home directory; Jive
searches upward) with:

```dotenv
OPENROUTER_API_KEY=your-openrouter-key   # or ANTHROPIC_API_KEY, OPENAI_API_KEY, ...
JEV_API_TOKEN=your-jev-key
```

Then run `jive` inside the project you want to work on:

```sh
cd my-project
jive
jive --prefill "Find where request retries are configured and explain the policy"
jive --headless --prompt "Run the tests and summarise failures"
```

A key for at least one model provider is required. `JEV_API_TOKEN` is needed
only for graphs that use `jev` decision nodes; bash-only graphs run without it.
With an OpenRouter key the planner defaults to `google/gemini-3.8-flash`;
otherwise it uses the default model of the first provider with a key. Choose
another with `--model` (for example `anthropic:claude-opus-5-5`) or
`JIVE_MODEL`. Decisions default to `jev-1.13.0`, overridable with `JEV_MODEL`.
[Model providers](USAGE.md#model-providers) covers other providers and
internal endpoints.

The UI has a bottom composer, a conversation that grows upward, and live graph
rows that turn green as nodes finish. Type `/` for commands (`/model`,
`/effort`, `/resume`, `/pin`, `/new`), Ctrl+G to inspect a graph, and Ctrl+O
to read the planner's reasoning. The full reference is in
[docs/USAGE.md](USAGE.md).

## How it works

Each planner turn can submit a graph. Executable nodes are `bash` and `jev`;
`foreach` and `repeat` groups instantiate templates for parallel expansion and
bounded loops. References are JSON pointers, so a node can consume another
node's stdout, parsed JSON, or a Jev answer without any glue code:

```json
{
  "version": 1,
  "label": "Inspect the manifest",
  "nodes": {
    "manifest": { "type": "bash", "script": "cat package.json" },
    "inspect": {
      "type": "bash",
      "stdin": { "$ref": "/nodes/manifest/output/stdout" },
      "script": "cat"
    }
  },
  "returns": ["inspect"]
}
```

References infer dependencies; `needs` adds ordering without data; `when`
expresses a typed predicate. A failed dependency blocks its dependents while
independent branches finish, and a recovery node can inspect the failure.
Every Jev node declares `accept`, a predicate over the returned answers; a false
predicate yields control back to the planner with the evidence preserved.

Graphs are validated against a JSON Schema (`jive --schema`) and executed with
graph-wide limits on concurrency, time, and Jev calls. See
[docs/GRAPH_CONTRACT.md](GRAPH_CONTRACT.md) for the complete semantics and
[examples/](../examples/) for runnable graphs:

```sh
jive --run examples/parallel.json --json
```

## Project configuration

- **`AGENTS.md`** in the working directory is snapshotted into the system prompt
  at session creation.
- **`.jive/skills/*/SKILL.md`** declares project skills: reusable procedures and
  graphs the planner can discover and adapt.
- **`.jev/extractors/*.ts`** adds extractor plugins that turn raw data into the
  records and choices Jev decisions take.
- **`.env`** holds credentials; a project's file overrides the ones above it.

Details for each are in [docs/USAGE.md](USAGE.md).

## Command line

```text
jive                              Interactive agent in the current directory
jive --demo                       Interactive demo (no API calls)
jive --prefill TEXT               Start with an editable draft prompt
jive --headless --prompt TEXT     Run one prompt; automatic session naming is skipped
jive --run FILE [--json]          Execute a saved graph; --json streams JSONL events
jive --resume ID [--search QUERY] Restore a session, or search its log
jive --sessions                   List saved sessions
jive --models | --refresh-models  List or refresh planner models
jive --schema                     Print the execute_graph JSON Schema
jive --cwd DIR --model ID         Override the working directory or model
jive update                       Pull the latest sources (git installs)
jive --version
```

## Development

```sh
bun install
bun run typecheck
bun test                 # offline; fixtures only, no model calls
bun run eval:planner --model MODEL    # opt-in live planner evaluation
bun run taskground list               # reproducible comparison tasks
```

Tests cover executor ordering, blocking and recovery, parallel limits, bounded
loops, reference binding, plugin reloads, session compaction and restoration,
streaming planner behaviour, and terminal rendering. See
[CONTRIBUTING.md](../CONTRIBUTING.md), the [taskground guide](../taskground/README.md),
and the [planner evaluation guide](../evals/planner/README.md).

## Reference

- [docs/USAGE.md](USAGE.md): interface, sessions, headless commands, skills, extractors
- [docs/GRAPH_CONTRACT.md](GRAPH_CONTRACT.md): the graph language the planner writes
- [docs/CONTEXT.md](CONTEXT.md): planner context, compaction, and Jev input limits
- [DESIGN.md](../DESIGN.md): architecture and confirmed design decisions

## License

[MIT](../LICENSE)

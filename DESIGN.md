# Graph-driven terminal agent

Status: first runnable implementation. Confirmed decisions below reflect the
discussion; evaluation proposals remain future work. See
docs/README.md, the executable examples, and `--schema` for the runnable contract.

## Objective

Build a standalone CLI agent whose main LLM has one primary tool,
`execute_graph`, plus `execute_graph_mod`, which reruns a saved graph after
small edits. The LLM describes a conditional program; the runtime executes
bash commands and Jev decisions against newly observed results before returning
to the LLM. The intended gain is fewer intervening main-LLM turns while retaining
feedback during execution.

Initial evaluation tasks cover repository investigation, simple coding, web
search, and general terminal work. Dependent commands and Jev decisions remain
sequential where their data dependencies require it.

## Confirmed decisions

### Planner models

- Reach planning LLMs through providers: OpenRouter by default, plus native
  Anthropic, OpenAI and any endpoint that speaks a supported protocol.
- Offer a choice of leading models rather than binding the agent to one model.

### Implementation stack

- TypeScript with Bun.
- OpenTUI with React for the terminal interface.
- Own the planner loop, graph scheduler, event log, and context policy directly.

### Graph interface

- The LLM-facing tools are `execute_graph` and `execute_graph_mod`. Every
  submitted graph is saved under `.jev/runs/<graphId>/graph.json`; the mod tool
  edits a saved graph by JSON pointer (substring replacement inside a string, or
  a whole value; null deletes) and executes the result at once, so a large graph
  is fixed without being resent.
- Input is declarative JSON with explicit references.
- The two executable node types are `bash` and `jev`.
- Branching, parallel execution, bounded loops, and dynamic expansion are in
  scope from the first version.
- Loops and parallel workloads are normal supported execution patterns; the
  architecture must not assume every graph is a short, fixed chain.
- Dynamic expansion instantiates subgraph templates supplied by the planning
  LLM using data discovered during execution.
- Plugins do not emit arbitrary new graph structure in the initial design.
- A failed node blocks dependent work while independent branches finish.
  Graphs may declare recovery branches or request a global stop.
- If a Jev decision fails its acceptance criteria, return to the main LLM by
  default. A graph can explicitly provide a retry or evidence-gathering branch.

### Extractor plugins

- Jev nodes may use extractors to convert input data into choices, state, or
  other structures accepted by Jev.
- Extractors are general plugins; they may run commands and access the network.
- Adding an extractor should be easy enough for the agent itself to write one
  during a task and then use it.
- Plugins reload between graph invocations. A newly written plugin does not
  need to become available to later nodes of its authoring graph.

### Context returned to the main LLM

- Provide compact previews for all node executions.
- Provide full outputs, status, and error details for requested results.
- Maintain explicit references so subsequent work can address prior results.

### Planner history and compaction

- Model-visible history is an append-only sequence of messages/events between
  compactions, preserving stable prefixes for prompt caching.
- Compaction is deterministic: keep approximately the latest 30% of the context
  window intact and supply a searchable reference to the complete session.
- Do not use an LLM-generated rolling summary as the compaction mechanism.
- Preserve the original task and explicitly pinned constraints verbatim too.
- Retention boundaries, output headroom, and oversized entries must be handled
  without splitting tool-call/result pairs or silently truncating evidence.

### Session restoration

- Restore conversation history and evidence after restarting the CLI.
- Record unfinished graphs as interrupted and let the planner decide how to
  continue. Do not automatically resume their operations.

### Terminal interface

- Use Amp's terminal experience as inspiration while establishing an original
  visual identity.
- The empty conversation has a large animated form: a dahlia that blooms from a bud on a loop, lit from the upper left and drawn in Braille dots (2×4 per cell) shaded from deep blue to warm white. No stem, no block glyphs (they render as solid tiles in some terminals).
- Colour palette and gradient transitions are important.
- Keep the input composer anchored at the bottom while conversation content
  grows above it; give user messages a distinct presentation.
- Show execution as minimalist connected nodes updated in real time.
- Completed nodes turn green.
- Stopped or failed nodes turn yellow.
- Downstream blocked work is greyed out.
- Edges show green advancing outward from completed nodes.
- Keep steering and interruption behaviour simple initially.

## Runtime contract

The implemented JSON schema is available through `--schema`.

### Execution identity and state

Every node execution has a stable identity including graph ID, template node
ID, expansion item identity, and loop iteration where applicable. Loop
iterations retain separate outputs rather than overwriting prior executions.

Store graph definitions and execution events alongside artifacts. Each command
records its working directory, exit status, stdout, stderr, and completion state.
Each Jev execution records the actual input, question definitions, answers, and
the extractor versions that prepared its input.

Pin extractor implementations for the lifetime of each graph. Registry reload
occurs after execution, and the next main-LLM turn receives the updated catalog
or plugin validation errors.

### References and bindings

References select explicit outputs of prior executions. Candidate extraction
preserves a mapping from stable candidate IDs to original records, so a Jev
selection can be resolved to a path, URL, or object without parsing display text.

Pass resolved command inputs as data through arguments, environment bindings,
stdin, or files. Avoid treating arbitrary tool output as shell source during
reference substitution.

Missing required inputs are execution errors. An intentionally skipped branch
is distinct from a failed or blocked branch. Join behaviour and loop state must
be explicit in the schema.

### Expansion and loops

Provide structural constructs for per-item template expansion and bounded
repetition. They do not add new executable node types. A template can contain
bash and Jev nodes, references, branches, and further bounded structure.

There is no graph-wide node-count cap. Defaults are six concurrent leaf
executions, five minutes per graph, and 100 Jev calls. Graphs can request higher
limits within the schema's ceilings; loops still declare their own bounds.

### Failure and handoff

A command's nonzero exit may represent expected evidence, such as failing tests.
Allow a node to declare the exit codes handled by its graph. An unhandled
execution failure follows the confirmed dependency-blocking policy.

Return to the main LLM when execution ends or yields. Generating a new strategy,
unanticipated command, or original patch can happen on that next planner turn.

When a Jev decision fails acceptance criteria, follow a declared recovery branch
or yield to the planner by default. Preserve its actual decision fields rather
than treating a confidence statistic as a correctness guarantee. Numeric
acceptance criteria depend on the question type and workflow, not one universal
confidence threshold.

## Model providers

The provider layer (`src/providers/`) separates the wire protocol from the
vendor, after the design of the pi coding agent's `pi-ai` package:

- A protocol adapter (`openai-completions`, `anthropic-messages`,
  `openai-responses`) streams one completion into the planner's callbacks and
  returns an OpenAI-shaped `PlannerMessage`, the format sessions persist.
- A provider is data: ID, protocol, base URL, key sources, headers, models and
  `compat` flags. Built-ins live in `builtin.ts`; `~/.config/jive/models.json`
  and a project's `.jive/models.json` add or change providers field by field.
- `compat` records how an endpoint departs from its protocol (how effort is
  requested, OpenRouter's routing and cache fields, Anthropic beta fields).
  Defaults are detected from the host and overridden per provider or model.
- A model reference is an OpenRouter ID or `provider:model`. Assistant messages
  record the reference and protocol that produced them, and the native reply
  (Anthropic content blocks with thinking signatures, Responses output items with
  encrypted reasoning). Adapters replay native state only to the provider or
  model that produced it and send plain text and tool calls to every other model,
  so a session can switch providers.
- The retry rule is shared: a request is replayed only while nothing has reached
  the transcript or the graph builder.

Anthropic's own API is reached through the official SDK, with SDK retries off.
Summarized thinking streams into the transcript, and effort is sent as
`output_config.effort`. Compaction keeps recent turns verbatim after an archive
note, which changes the history their thinking blocks are bound to. The request
therefore asks the API to drop such blocks rather than fail. Where that beta is
unavailable, the request is retried once without thinking history.

### OpenRouter model selection

Use a curated list plus a custom model-ID entry. Refresh available model metadata
from OpenRouter and cache it for startup and offline display. Check tool support
and retain the provider's supported reasoning metadata. Reasoning controls are
not exposed in the initial UI.

Candidate presets checked against OpenRouter's public catalog on 2026-09-17:

- `anthropic/claude-fable-5.1`
- `anthropic/claude-opus-5.5`
- `anthropic/claude-sonnet-5`
- `openai/gpt-6-astra`
- `openai/gpt-6-sol`
- `openai/gpt-5.6-sol`
- `google/gemini-3.1-pro-preview`
- `google/gemini-3.8-flash`
- `moonshotai/kimi-k3`
- `deepseek/deepseek-v4-pro-0813`
- `z-ai/glm-5.3`

This is a candidate menu, not a measured quality ranking for this agent. Preserve
the requested model ID and returned model/provider metadata where available for
each turn. Explicitly chosen IDs make experimental comparisons easier than
silently moving users to a different model. The default is
`google/gemini-3.8-flash`, overridable through the environment, CLI, or UI.

The planner has two tool definitions, `execute_graph` and `execute_graph_mod`,
and may also answer the
user directly. The runtime owns concurrency within a graph. V1
serializes separate graph invocations within one session even if
a model emits multiple tool calls. Streamed execution is automatic: a fully closed
node/group becomes an immutable commitment after validating its complete prefix.
Settings and templates precede work; omitted settings use defaults. An entry
written before a root entry it depends on waits until that dependency commits.
Requested returns may come last. Saved graph replay, and tool arguments a provider
delivers in one fragment (Gemini re-serializes them with shuffled keys), validate
the complete graph before scheduling.
Incomplete JSON values never execute. See docs/README.md for the streaming contract.

Sources: [model catalog](https://openrouter.ai/api/v1/models),
[tool calling](https://openrouter.ai/docs/guides/features/tool-calling).

## Context engineering

The confirmed append-only planner history replaces the earlier proposal for a
mutable session brief. Preserve emitted messages and results; append plugin
catalog changes, project changes, and user corrections as new events rather than
rewriting old history on each turn.

Maintain the complete execution record separately from its model-visible event
stream. A graph result is materialized once and appended to the planner's
history. The TUI may consume much more detailed live events without forcing those
events into every model request.

Jev receives explicitly assembled state for each decision, with relevant
observations and criteria. It does not automatically inherit the planner's
growing conversation or other nodes' full histories. The detailed proposal and
TypeSafe research are in [docs/CONTEXT.md](docs/CONTEXT.md).

Suggested graph result envelope:

```text
graph outcome: status and stopping reason
all executions: identity, status, compact preview, artifact reference
requested results: full output, execution status, error details
```

Persist complete results locally so both the UI and subsequent bash nodes can
retrieve evidence without injecting the entire record into the planner context.
Compaction archives the earlier history and retains an exact recent suffix;
there is no automatic LLM summarization call after each graph or at compaction.

Large graphs and oversized requested outputs need an explicit context-budget
policy. Do not silently label truncated output as complete. Grouping loop
previews must preserve visibility into individual execution outcomes.

Old evidence should retain its source/version identity; previously read file
contents must not be presented as necessarily matching the current workspace.

## Plugin authoring experience

Discover project-local and user-level plugin files. Each plugin supplies its
name, description, input/config/output contracts, examples, and implementation.
The agent's confirmed TypeScript/Bun stack supplies the initial plugin runtime.

Expose runtime helpers for commands, HTTP requests, artifacts, logging, and
cancellation. Operations performed through those helpers can appear beneath the
owning graph node in the UI. General plugin code is not assumed to be pure.

At small scale, give the planner a compact catalog with sufficient contracts to
use installed extractors. Detailed examples and source remain available through
bash. Project plugins live in `.jev/extractors/`; user plugins live in
`~/.config/jev-agent/extractors/`. Bun bundles dependencies into versioned modules
so new graphs load changes while active graphs retain their original version.

## Implementation stack rationale

The confirmed stack uses TypeScript for the agent, graph runtime, and initial
plugin API; Bun as the runtime; and OpenTUI with React for the terminal UI.

OpenTUI provides a native renderer with TypeScript bindings, scroll containers,
inputs, and animation primitives. React can own application composition while
custom renderables handle the graph and ASCII animation. The agent loop,
execution scheduler, persistence, and context policy remain owned by this project
and are testable without the terminal renderer.

TypeScript with Node.js and Ink/React is the main alternative if conventional
Node deployment is preferred. Pi's TUI library is another option with direct
line-rendering components. These are framework choices, not a claim about which
framework Amp uses.

Sources: [OpenTUI](https://opentui.com/docs/),
[runtime support](https://opentui.com/docs/getting-started/runtime-support/),
[ScrollBox](https://opentui.com/docs/components/scrollbox/),
[animation](https://opentui.com/docs/application-apis/animation/),
[Ink](https://github.com/vadimdemedes/ink),
[Pi TUI](https://pi.dev/docs/latest/tui).

## UI behaviour

Use an accent colour for active nodes. Pair all colour states with labels or
symbols. Distinguish pending, skipped, and blocked work, and distinguish an
intentional yield from a failed operation.

Treat advancing green on an edge as a dependency becoming available. A join may
have a satisfied incoming edge while waiting for another dependency.

Preserve existing node positions where possible during expansion. Represent
loops as expandable groups with separate iteration records. Allow inspecting
commands, artifacts, extractor activity, and the exact input sent to Jev.
Planner request records are available in session artifacts.

Drive the TUI from execution events. A headless runner and event stream support
repeatable architecture experiments. Replaying recorded events is
distinct from re-executing commands or plugins.

## Follow-up experiments

- Measure task success, latency, cost, and planner cache reuse on real tasks.
- Tune graph limits, preview sizes, and context estimates using those results.
- Evaluate graph readability at large expansion sizes and narrow terminal widths.
- Decide whether plugins need process isolation beyond cooperative cancellation.

The runtime contract is in [docs/GRAPH_CONTRACT.md](docs/GRAPH_CONTRACT.md).

## Evaluation proposal

Use representative tasks with verifiable outcomes. Compare ordinary main-LLM
tool loops, batching with deterministic conditions, and graphs with Jev
decisions. Track task success, elapsed time including planning, model cost,
unnecessary actions, and handoff frequency. Fewer planner turns alone do not
establish that the architecture is better.

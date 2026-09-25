# Context engineering

Status: implemented planner policy plus researched guidance for Jev.
Research checked 2026-09-18. Session/context implementation is in src/session/.

## Planner: append, archive, retain

The planner's active history is an append-only message/event sequence. Use a
stable system/tool prefix and preserve existing entries when adding new ones.
User corrections, plugin catalog updates, project state changes, graph outcomes,
and retrieved evidence arrive as additional entries.

Avoid a regenerated session summary, current timestamp, reordered tool schema,
or re-rendered catalog near the beginning of every request. The semantic graph
tool definition can remain stable while plugin contracts change through events.

The stable operating policy precedes the graph contract and executable examples.
A separate system message supplies runtime capability facts: cwd, runtime and
contract versions, default limits, configured Jev model and credential presence,
and saved-graph replay semantics. This message is stable while configuration is
unchanged, refreshed when configuration changes, and supplied again after resume
or compaction. It never includes credential values. Credential presence does not
assert service availability; useful task calls establish that.

`planner.context` events store the exact system prefix and tool definitions,
capability data, and a SHA-256 hash, once per change. `planner.request` links each
request to that snapshot and records the history boundary, compaction epoch,
model, and effort. Combined with the append-only message records this preserves
the request's context provenance without copying all history every round.

Maintain a complete local event log and artifacts. Materialize the planner's
graph-result message once; live stdout and animation events can remain in the
execution/UI event stream. Preserve the distinction between original records and
their bounded planner previews.

### Deterministic compaction

Confirmed behaviour: keep approximately the latest 30% of the context window
intact, with a searchable reference to the entire earlier session. No generated
summary is required.

Implemented mechanics:

1. Compact before the next request exceeds its usable input budget. Reserve
   space for the model's output and an anticipated tool result.
2. Select the newest complete conversational units near the retention target.
   Preserve assistant tool calls together with their corresponding results;
   never cut arbitrary characters or create orphaned tool messages.
3. Start a new active-history epoch with stable instructions/tool definitions,
   a deterministic archive locator and omitted event range, and the retained
   entries copied unchanged.
4. Resume append-only history. Retrieved older excerpts become new entries with
   source event IDs and artifact references.

The original task and explicitly pinned user constraints also survive verbatim.
These pins are exact retained text, not a semantic summary or an inferred list
of important facts.

The archive remains accessible through bash inside `execute_graph`; this does
not add another planner tool. Provide a documented way to search records and
retrieve specific event ranges.

An entry larger than the input budget cannot be made to fit by retaining a
percentage of older history. Graph-result messages use a bounded excerpt above
at most 48,000 characters (lower for smaller model windows), with a full saved
artifact and explicit omission markers.
Crash-restored tool results use a conservative 4,000-character excerpt bound
with the same complete-artifact reference. Early execution interrupted before a
complete assistant tool call is saved becomes a standalone evidence message;
recovery never invents a tool call or replays effects.
The planner budget reserves up to 16,384 tokens for output and 12,000 for the
next tool result. Estimates use UTF-8 bytes divided by four; they are approximate.
If the mandatory task, pins, and freshest complete exchange cannot fit, the
request fails with an explicit capacity error instead of silently dropping them.

### Cache behaviour

Stable prefixes support cache reuse between compactions, but cache hit rates
also depend on the selected model/provider, caching configuration, expiry, and
routing. OpenRouter documents a session ID for sticky routing and reports cache
read/write usage. Anthropic requests place breakpoints after the system prompt
and at the end of the history; OpenAI's Responses requests pass the session ID as
`prompt_cache_key`. Track actual metrics rather than assuming append-only history
guarantees a specific hit rate.

Compaction changes the prefix following the stable instructions. Retained text
does not keep its old prefix-cache identity merely because it is copied exactly
to a new position. Expect a cache rebuild for that changed context, followed by
reuse as the new epoch grows.

Source: [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

## Jev: explicit context for each decision

Applied the user-supplied TypeSafe skill at
`/Users/mericungor/Downloads/SKILL (1).md`, which directs integrations to the live
TypeSafe docs and relevant cookbooks. These findings describe the documented
current model, not independent accuracy measurements.

### Documented limits

TypeSafe's Jev 1.13 guidance specifies two simultaneous limits:

- 64k tokens for `state` and all `questions` together.
- 32k tokens for `state` plus the longest individual question.

Question definitions consume input budget, including their instructions and
criteria. More questions do not allow a single question to read a 64k state.
Both constraints must inform request assembly. Use the provider's actual usage
and conservative estimates where an exact compatible tokenizer is unavailable.

The model page currently maps `jev-latest` to `jev-1.13.0`; record the resolved
model version. Version-specific guidance may change with later releases.

Sources: [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[models](https://docs.typesafe.ai/models).

### Guidance from TypeSafe

- Prefer named JSON fields when state contains several related pieces.
- Supply the source evidence and relationships needed for the judgment.
- Ask a narrow, coherent question with explicit boundaries and answer criteria.
- Instructions and criteria can themselves be structured objects or arrays.
- Question IDs are program identifiers, not instructions sent to the model.
  Put the full question meaning in its instructions; reference state paths
  explicitly where helpful.
- Evaluate independent questions over the same state together. Answers within
  that request cannot depend on one another's returned answers.
- Enumerate candidate values in code and let Jev select among them; retain a
  no-match outcome and original source values.
- Keep arithmetic, exact counting, date comparisons, and other deterministic
  calculations in code.
- Reduce unnecessary indirection and unrelated content. The lab reports reduced
  accuracy with irrelevant large state and overly indirect questions.
- Use the planner for open-ended generation and reasoning that cannot be
  expressed as a suitable bounded decision.

Sources: [state](https://docs.typesafe.ai/concepts/state),
[structured instructions and criteria](https://docs.typesafe.ai/primitives/advanced),
[building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one),
[pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook),
[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

### Context assembly

Each Jev node declares relevant context references and an optional extractor
pipeline. The planner chooses the intended evidence and decision; plugins
materialize, parse, retrieve, or format it. Resolve references into actual content
before calling Jev: an artifact ID by itself provides no evidence.

A typical state contains:

```json
{
  "task": {
    "goal": "Locate the implementation relevant to expired-session failures",
    "constraints": ["Select source implementation rather than generated output"]
  },
  "observation": {
    "test_name": "refreshes an expired session",
    "failure_excerpt": "Expected renewed session; received an expired token"
  },
  "candidates": [
    {
      "id": "candidate_7",
      "path": "src/session/refresh.ts",
      "excerpt": "Relevant source excerpt is inserted here by the extractor"
    }
  ],
  "coverage": {"total_candidates": 12, "included_candidates": 1}
}
```

This is an assembly-shape illustration, not evidence from an actual repository
or a complete API request. Questions and their criteria are separate fields in
the Jev request. A choice should include a no-match option.

Distinguish observed facts from planner hypotheses. Preserve enough neighboring
code or document context to interpret an excerpt; minimal input is not the same
as sufficient input. Record source identity and freshness in the execution log.

Do not automatically include the full planner transcript, full graph, other
branches, or earlier iterations. Explicit references can include any of those
when they are relevant to the particular decision. Loop-carried state exposes
the needed observations and prior decisions without accumulating all history.

### Oversized evidence and candidate sets

Prefer scoped retrieval or deterministic extraction before Jev. For material
that remains too large, use an explicit template to score chunks or candidates,
then construct a focused follow-up decision from selected evidence. Report
coverage and omission rather than silently truncating evidence.

Choice probabilities compare alternatives within that question. Do not rank
different batches by naively comparing their winning Choice probabilities.
Use consistent per-candidate rubrics when independent scores must be compared.

Batch questions when their required state genuinely overlaps. Do not combine
unrelated branches into a giant state merely to reduce the request count. If a
later decision depends on a preceding answer or newly fetched evidence, it is a
subsequent request.

Sources: [re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe),
[speculative fan-out](https://docs.typesafe.ai/patterns/fan-out).

### Inspection and evaluation

The graph inspector should show the exact state, question, criteria, extractor
versions, returned distribution, and selected route. This lets us distinguish
missing context, missing candidates, bad criteria, model errors, and runtime
errors.

Measure accuracy and handoff behaviour across representative tasks. The provider
guidance is a starting point, not proof that a particular coding decision can be
delegated reliably.

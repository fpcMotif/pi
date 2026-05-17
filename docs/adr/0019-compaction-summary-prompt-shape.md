# Compaction summary prompt: five flat sections + preservation preamble + omit-empty

Slice 38 introduces `SUMMARIZATION_INSTRUCTION` in `packages/agent/effect/session.ts` — the user message appended to the to-summarise history slice when `Session.send` fires compaction. The prompt asks the LLM to return a structured context checkpoint another assistant can load to continue the work. This ADR records the deliberate simplification relative to the legacy `src/harness/compaction/compaction.ts` `SUMMARIZATION_PROMPT`, AND the correction applied after codex adversarial review surfaced a load-bearing-facts regression in the initial simplification.

The accepted Effect rewrite uses **five flat sections** with an "omit-empty" rule AND an explicit **preservation preamble**:

> "Preserve exact file paths, function names, error messages, and any constraints or blockers verbatim — the conversation prefix being summarised will be DISCARDED, so anything not captured here is lost."

- `## Goals` — user-facing goals of the session, prioritised.
- `## Decisions` — material decisions made and rationale.
- `## Files Touched` — exact file paths read, written, edited, or referenced.
- `## Critical Context` — constraints, preferences, blockers, exact function names, error messages, or any other detail the next assistant must NOT forget.
- `## Next Steps` — concrete actions the next assistant should take.

The legacy `SUMMARIZATION_PROMPT` had **six sections with nested taxonomy**:

- `## Goal` (singular, with a multi-item hint)
- `## Constraints & Preferences`
- `## Progress` with `### Done` / `### In Progress` / `### Blocked` sub-headers
- `## Key Decisions`
- `## Next Steps`
- `## Critical Context`

Vs legacy, the Effect rewrite:

- Drops `## Constraints & Preferences` as a top-level section — constraints now land under `## Critical Context`.
- Drops `## Progress` nested taxonomy (`### Done` / `### In Progress` / `### Blocked`).
- Renames `## Goal` → `## Goals` and `## Key Decisions` → `## Decisions`.
- Adds `## Files Touched` as a new top-level section.
- Keeps `## Next Steps` and `## Critical Context`.

Reasoning:

- **Compaction discards the summarised-away history.** This is the load-bearing constraint. `Session.send`'s compaction step replaces `toSummarize` with the summary text; anything the model omits from the summary is permanently lost from the long-term session state. The preservation preamble plus `## Critical Context` close this gap explicitly.
- **Trust the model to omit-when-empty rather than pad placeholders.** Legacy padded `(none)` placeholders for sections that didn't apply, which clutters the output with noise the next assistant has to parse around. The Effect prompt asks the model to omit the section entirely if empty, which matches how modern post-3.5-class LLMs handle structured-output instructions reliably.
- **`## Files Touched` is a concrete recoverable dimension legacy lacked.** A handoff summary that names exact paths lets the next assistant `Read` them directly instead of inferring file context from prose. This is the single largest practical handoff win in agentic workflows.
- **Flat sections beat nested.** Legacy's `## Progress` with `### Done` / `### In Progress` / `### Blocked` adds two parser-relevant levels for the consumer. Slice 38's flat shape keeps every header at the same depth, simpler to scan and simpler for the model to emit consistently.
- **Pluralizing `Goal` → `Goals`** matches legacy's own hint that the singular section can hold multiple items. Removes the cognitive tax of "what if there's more than one?" without changing semantics.

The prompt is a soft contract: no parser on the consume side enforces these section names. If the model drifts (renames a header, omits one we asked for, adds an extra), the next-turn assistant still ingests it as text. The structure exists for the model's benefit (predictable shape during generation) and the human reader's benefit, not as a wire format. The slice-38 tracer test asserts presence-of-substring for each section header AND for the preservation-preamble key phrases, not byte-equality of the full body.

## Decision evolution

The prompt shape evolved during slice-38/39 review:

1. **Initial simplification (rejected): four flat sections, no preservation preamble.** `## Goals` / `## Decisions` / `## Files Touched` / `## Next Steps` plus an "omit-empty" instruction. ADR-0019's original argument was that legacy's removed sections "rarely held actionable info on handoff" and that the conversation tail would preserve constraint context anyway.
2. **Codex adversarial review** caught the regression: legacy's prompt explicitly instructed the model to "preserve exact file paths, function names, and error messages" and to populate `## Constraints & Preferences` / `## Critical Context`. The Effect simplification dropped those instructions. Because compaction replaces the summarised-away segment with only the summary text, anything not asked for is lost forever from the long-term session state — the "recoverable from conversation tail" defence is false for the summarised-away segment specifically.
3. **Correction (accepted): five sections + preservation preamble.** Add the `## Critical Context` section back and prepend a "preserve verbatim" preamble that names the categories of facts that must survive. Five sections is still simpler than legacy's six + nested taxonomy; the preservation preamble closes the load-bearing-facts gap.

Rejected alternatives:

- **Match legacy exactly (six sections, nested taxonomy)** — preserves existing-user familiarity but inherits over-engineering this rewrite undoes (ADR-0001, ADR-0006). The five-section shape is the minimum viable structure that covers the legacy's load-bearing surface.
- **Free-form prose summary (no sections at all)** — even simpler, but loses the "next assistant can rely on a predictable shape" property that slice 38's CONTEXT.md narrative calls out.
- **Initial four-section design (no preservation preamble)** — covered above; rejected after codex review.
- **Six sections matching legacy structurally but renamed** — pushes the rename cost without gaining the simplification.

## Status

accepted (decision evolved during slice-38/39 review)

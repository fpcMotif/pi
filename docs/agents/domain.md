# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This is a **multi-context** repo. Each surviving package in the ADR-0002 / ADR-0005 target shape is its own context. Per-context docs live next to the package; system-wide docs live at the repo root. During the ADR-0006 phased migration, legacy packages can still exist without a context doc when they are being retired.

```
/
├── CONTEXT-MAP.md                       ← root index pointing at per-package CONTEXT.md files
├── docs/adr/                            ← system-wide decisions (cross-package)
└── packages/
    ├── agent/
    │   ├── CONTEXT.md
    │   └── docs/adr/                    ← agent-specific decisions
    ├── models/
    │   └── CONTEXT.md
    ├── coding-agent/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── tui/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    └── web-ui/
        ├── CONTEXT.md
        └── docs/adr/
```

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per package. Read each one relevant to the topic.
- **`packages/<pkg>/CONTEXT.md`** for whichever package(s) you're touching.
- **`docs/adr/`** at the root for cross-package decisions.
- **`packages/<pkg>/docs/adr/`** for decisions scoped to that package.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

When working in a single package, check both the package-scoped `docs/adr/` and the root `docs/adr/` for relevant decisions.

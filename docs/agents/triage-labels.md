# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

If these labels don't yet exist in the GitHub repo, create them once with `gh label create <name> --description "..."` before the first triage run, or edit the right-hand column above to match labels you already use.

## Orthogonal labels

Triage labels are independent of the `pkg:*` package-scope labels documented in `docs/agents/issue-tracker.md`. Apply both: one triage label plus one or more `pkg:*` labels.

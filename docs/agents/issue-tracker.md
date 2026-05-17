# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues at `github.com/fpcMotif/pi`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <path>`. Always write the body to a temp file first — never pass multi-line markdown directly via `--body` in shell commands.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: write the comment to a temp file, then `gh issue comment <number> --body-file <path>`. Preview the exact text before posting. Post exactly one final comment per turn unless the user asks for multiple.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`
- **Close via commit**: include `fixes #<number>` or `closes #<number>` in the commit message.

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Package labels

When creating an issue, also add one or more `pkg:*` labels to indicate which package(s) it affects:

- `pkg:agent`
- `pkg:ai`
- `pkg:coding-agent`
- `pkg:tui`
- `pkg:web-ui`

If the issue spans multiple packages, add all relevant labels.

## Contributor gating

New issues from new contributors are auto-closed by `.github/workflows/issue-gate.yml`. New PRs from new contributors without PR rights are auto-closed by `.github/workflows/pr-gate.yml`. The `lgtmi` comment approves a user for future issues; `lgtm` approves them for future issues and PRs. Maintainer triage rules live in `CONTRIBUTING.md`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

# codex-sidecar

A TypeScript/Node CLI that lets you ask OpenAI Codex for a background second opinion while you are working in a Claude Code session.

The default behavior is intentionally review-oriented: Codex gets the same Git repository root, receives a targeted prompt, runs in a read-only Codex sandbox by default, and writes its answer into `.codex-sidecar/` so Claude can read or receive it through a hook.

## Install

```bash
npm install
npm run build
npm link
```

Then, from the repo where you use Claude Code:

```bash
codex-sidecar init --install-claude
codex-sidecar doctor
```

This creates:

```text
.codex-sidecar/                    # local state, excluded via .git/info/exclude
.claude/skills/codex-opinion/       # /codex-opinion skill
.claude/settings.local.json         # hooks that capture Claude transcript_path and inject answers
```

## Requirements

- Node.js 20+
- Git repository
- `codex` CLI installed, logged in, and available on `PATH`
- Claude Code, if you want the optional `/codex-opinion` skill and hook integration

## Typical usage

Ask a background second opinion using current Claude context:

```bash
codex-sidecar ask --claude "Review Claude's migration plan skeptically. Find missing tests and rollout risks."
```

Read the latest answer:

```bash
codex-sidecar read
```

Watch until the latest answer is ready:

```bash
codex-sidecar watch
```

Continue the same side thread:

```bash
codex-sidecar ask --claude "Follow-up: what is the safest migration sequence?"
```

Start fresh:

```bash
codex-sidecar clear
codex-sidecar ask --fresh "Blindly inspect checkout for duplicate-charge risks."
```

Use a named side thread:

```bash
codex-sidecar ask -t auth-refactor --claude "Review the auth refactor plan."
codex-sidecar read -t auth-refactor
codex-sidecar clear -t auth-refactor
```

Run synchronously:

```bash
codex-sidecar ask --wait --claude "Review the current diff as a PR reviewer."
```

## Codex loop gate

For higher-risk work, start an opt-in loop that blocks Claude Code's Stop hook until configured checks and a structured Codex review pass:

```bash
codex-sidecar init --install-claude --install-loop-hook
codex-sidecar loop start --mode implement --check "npm run check" fix the auth middleware bug
codex-sidecar loop review
codex-sidecar loop read
codex-sidecar loop stop
```

Plan-only loops review a stable plan file before code is written:

```bash
codex-sidecar loop start --mode plan --plan-file .codex-sidecar/plan.md add team notification settings
```

Loop mode is fail-open by default on Codex infrastructure errors; pass `--fail-closed` when the gate should block on review failures/timeouts.

For more concrete usage patterns, see [Codex Sidecar Workflows](docs/workflows.md).

## Claude Code usage

After `codex-sidecar init --install-claude`, reload Claude Code and use:

```text
/codex-opinion review the current plan skeptically
```

Claude should call `codex-sidecar ask --claude ...`, continue working, and later read the answer with `codex-sidecar read` or receive a completed answer via the installed `UserPromptSubmit` hook.

## State layout

```text
.codex-sidecar/
  latest.md
  latest-default
  claude-session.json
  loop.json
  loop/latest-review.md
  threads/default.json
  runs/<run-id>/
    metadata.json
    prompt.md
    answer.md
    codex.ndjson
    stderr.log
    worker.log
```

## How conversation continuation works

The sidecar uses two layers:

1. It stores the last Codex-side answers in `.codex-sidecar/threads/<thread>.json` and includes recent side-thread turns in follow-up prompts.
2. If the local Codex JSON output exposes a session UUID, the next run also calls `codex exec resume <session-id>`.

That means follow-ups remain useful even if your local Codex build does not expose a parseable session id.

## Safety defaults

By default, the command sent to Codex is shaped like:

```bash
codex exec \
  --cd <repo-root> \
  --sandbox read-only \
  --output-last-message .codex-sidecar/runs/<id>/answer.md \
  --json \
  -c approval_policy=\"never\" \
  -
```

Use `--sandbox workspace-write` only when you explicitly want Codex to run commands that may write build/test artifacts. Avoid `danger-full-access` unless you are inside a throwaway environment.

## Development

```bash
npm install
npm run check
npm run build
node dist/cli.js --help
```

For planned improvements, see [Roadmap Notes](docs/roadmap.md).
For manual smoke testing, see [Manual Smoke Testing](docs/testing.md).

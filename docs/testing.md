# Manual Smoke Testing

Use this checklist before testing Claude Code integration or after changing CLI execution, state management, or prompt construction.

These tests require:

- A real Git repository.
- Node.js 20+.
- A logged-in `codex` CLI on `PATH`.
- Network access.

The `ask` commands call Codex and may take time and consume tokens.

## 1. Package Sanity

From the `codex-sidecar` repository:

```bash
npm install
npm run check
npm run build
npm link
which codex-sidecar
codex-sidecar --help
codex-sidecar doctor
```

Expected:

- Install completes without registry or lockfile issues.
- TypeScript check passes.
- Build succeeds.
- `codex-sidecar` resolves on `PATH`.
- `doctor` finds Git, Node, and `codex`.

## 2. Raw Synchronous Ask

From a small Git repository:

```bash
codex-sidecar init
codex-sidecar ask --wait --fresh "Inspect this repository. What is it? Do not edit files. Return a concise summary."
```

Expected:

- The command prints a Codex answer.
- `.codex-sidecar/runs/<run-id>/answer.md` exists.
- `.codex-sidecar/latest.md` exists.
- `.codex-sidecar/threads/default.json` records the completed turn.

## 3. Background Ask

```bash
codex-sidecar ask --fresh "Review the README for missing setup steps. Do not edit files. Return at most three bullets."
codex-sidecar status
codex-sidecar watch
codex-sidecar read
```

Expected:

- `ask` returns immediately with a run id.
- `status` shows the run as `running` or `done`.
- `watch` waits and then prints the answer.
- `read` prints the latest answer.

## 4. Follow-Up Ask

```bash
codex-sidecar ask --wait "Follow-up: based on your last answer, what is the highest priority improvement? Return one sentence."
```

Expected:

- The command succeeds.
- The latest run metadata includes a `resume <session-id>` command if Codex exposed a session id.
- The thread state keeps the previous turn history.

## 5. Named Thread

```bash
codex-sidecar ask -t smoke-test --wait --fresh "Start a named side thread. What files define this CLI? Return a short answer. Do not edit files."
codex-sidecar read -t smoke-test
codex-sidecar status -t smoke-test
codex-sidecar clear -t smoke-test
codex-sidecar read -t smoke-test
```

Expected:

- The named `ask` succeeds.
- `read -t smoke-test` prints that thread's latest answer.
- `status -t smoke-test` lists matching runs.
- `clear -t smoke-test` removes the thread/latest pointer.
- The final `read -t smoke-test` reports no run found for that thread.

Note: `clear` preserves historical run artifacts unless `--hard` is used, so `status -t smoke-test` may still list old runs after clearing.

## 6. Empty State

Use a temporary empty Git repository so existing local state is not disturbed:

```bash
tmpdir=$(mktemp -d /tmp/codex-sidecar-empty.XXXXXX)
cd "$tmpdir"
git init

codex-sidecar clear
codex-sidecar status
codex-sidecar read
```

Expected:

- `clear` exits successfully.
- `status` prints `No Codex sidecar runs yet.`
- `read` exits non-zero with a clear message like `no run found for thread 'default'`.

Clean up:

```bash
rm -rf "$tmpdir"
```

## 7. Optional Cleanup

To remove smoke-test state from the current repository:

```bash
codex-sidecar clear --hard
```

This removes run artifacts under `.codex-sidecar/runs` for the current repository.

## 8. Claude Code Integration

Run this after the raw sidecar checks pass.

From a repository where you use Claude Code:

```bash
codex-sidecar init --install-claude
codex-sidecar doctor
test -f .claude/skills/codex-opinion/SKILL.md
test -f .claude/settings.local.json
```

Expected:

- `.claude/skills/codex-opinion/SKILL.md` exists.
- `.claude/settings.local.json` contains `SessionStart` and `UserPromptSubmit` hooks that run `codex-sidecar hook`.
- `doctor` reports whether a Claude transcript has been captured.

Reload Claude Code so it picks up the installed skill and hooks.

In Claude Code, run:

```text
/codex-opinion Review this repo setup. Be skeptical. Do not modify files. Return at most three bullets.
```

Expected:

- Claude invokes `codex-sidecar ask --claude ...`.
- The sidecar starts a background run.

From a shell in the same repo:

```bash
codex-sidecar status
codex-sidecar watch
codex-sidecar read
```

Expected:

- `status` shows the run.
- `watch` eventually prints the answer.
- `read` prints the latest answer.
- `.codex-sidecar/claude-session.json` exists after a Claude hook has run.

To test answer injection, start a background `/codex-opinion` request, wait for it to finish, then send Claude another normal prompt in the same repo:

```text
Check whether Codex sidecar returned anything and incorporate it if relevant.
```

Expected:

- The `UserPromptSubmit` hook injects the completed sidecar answer as additional context, or Claude can read it with `codex-sidecar read`.
- The corresponding thread state records `lastInjectedRunId` after injection.

Troubleshooting:

- If Claude does not find `/codex-opinion`, reload Claude Code.
- If hooks do not run, verify `.claude/settings.local.json` and make sure Claude Code can resolve `codex-sidecar` on its `PATH`.
- If `--claude` prompts say no transcript was captured, trigger a new prompt in Claude Code and rerun `codex-sidecar doctor`.

## 9. Codex Loop Gate

Run `npm test` from this repository first. It covers the pure loop helpers with Node's built-in test runner.

Manual loop smoke tests should use a temporary Git repository and a fake `codex` binary on `PATH` that writes canned JSON to the `--output-last-message` path. Verify:

- No active loop makes `codex-sidecar loop hook stop` write no stdout.
- A failed `--check` blocks before invoking Codex.
- A fake `PASS` review allows stop and marks `.codex-sidecar/loop.json` as `passed`.
- A fake `REVISE` review blocks with valid Stop-hook JSON.
- A fake `HUMAN` review blocks once, then `codex-sidecar hook` on `UserPromptSubmit` reactivates the loop.
- Invalid review JSON marks the loop `error`, fail-open by default, and blocks only with `--fail-closed`.

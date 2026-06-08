# Codex Loop MVP Feature Spec

This is the scoped-back first implementation plan for the Codex loop feature.
The original, larger proposal is preserved at `docs/loop-feature/original-plan.md`.

## Executive Summary

Add an opt-in `loop` command family to `codex-sidecar` that lets Claude Code use
Codex as a synchronous implementation review gate.

The MVP is intentionally narrow:

```text
Claude implements
        |
Claude tries to stop
        |
Claude Code Stop hook invokes: codex-sidecar loop hook stop
        |
configured checks run first
        |
Codex reviews the working-tree diff as a read-only reviewer
        |
PASS   -> let Claude stop
REVISE -> block Stop and give Claude concise feedback
ERROR  -> fail open by default
```

The first version should prove the core control-flow value before adding plan
mode, human-decision state, no-progress detection, or advanced configuration.

## Core Value

The core value is:

> Prevent Claude from declaring implementation work complete until objective
> checks and an independent Codex review pass.

The smallest coherent feature that delivers this value is an implementation-only
gate over the current working tree.

## First-Version Scope

Build only:

- one active loop per repo
- implementation mode only
- `loop start`, `loop review`, `loop status`, `loop read`, `loop stop`
- `loop hook stop` for Claude Code Stop hooks
- configured checks before Codex review
- full working-tree diff review, including staged and untracked text files
- structured Codex output via `--output-schema`
- fail-open behavior for Codex/tooling errors
- a hardcoded total timeout budget per Stop evaluation
- minimal local review artifacts

Do not build v2 concepts until this loop has been dogfooded.

## Deferred Scope

Defer:

- plan mode
- `HUMAN` verdict
- `awaiting_human` state
- `UserPromptSubmit` loop reactivation
- no-progress artifact hashes
- blocker fingerprints
- `stuckRounds`
- `--fail-closed`
- `--blind`
- full Claude transcript excerpts
- `--sandbox`, `--approval`, `--profile`, and arbitrary Codex config
- compatibility parser for older Codex versions without `--output-schema`
- Claude `/codex-loop` skill
- multiple active loops or named loops
- plan-to-implementation pipelines

Most deferred behavior can be added without changing the basic state layout if
the MVP proves useful.

## CLI

### Install Hook

Normal Claude integration remains advisory:

```bash
codex-sidecar init --install-claude
```

Loop hook installation is explicit:

```bash
codex-sidecar init --install-claude --install-loop-hook
```

This installs a Stop hook that is inert unless a loop is active.

### Start Loop

```bash
codex-sidecar loop start \
  --check "npm run check" \
  --check "npm test -- auth" \
  fix the auth middleware bug
```

Options:

```text
--check <cmd>          repeatable
```

MVP constants:

```text
LOOP_MAX_ROUNDS = 3
LOOP_TIMEOUT_SEC = 900
sandbox = read-only
approval = never
```

If a Claude session has already been captured, the MVP binds the loop to that
session internally. If no session has been captured, the loop applies to any
session in the repo and prints a warning at `loop start`.

No `--mode` in the MVP. The loop is implementation-only. If users want plan
review, they can keep using:

```bash
codex-sidecar ask --claude "Review this plan skeptically."
```

### Manual Review

```bash
codex-sidecar loop review
```

Runs the same evaluation as the Stop hook, but prints a human-readable result
instead of Claude hook JSON.

Exit codes:

```text
0 = PASS / allowed
1 = REVISE / blocked
2 = ERROR
```

### Status, Read, Stop

```bash
codex-sidecar loop status
codex-sidecar loop read
codex-sidecar loop stop
```

`loop stop` deactivates the loop but preserves review artifacts.

## State Layout

Use the existing `.codex-sidecar/` directory:

```text
.codex-sidecar/
  loop.json
  loop/
    latest-review.md
    latest-review.json
    reviews/
      <review-id>/
        prompt.md
        schema.json
        review.json
        review.md
        codex.ndjson
        stderr.txt
        checks.json
```

The MVP does not need thread pointers, side conversation state, or no-progress
hash state.

## Types

```ts
type LoopStatus = "active" | "passed" | "exhausted" | "error" | "inactive"
type LoopVerdict = "PASS" | "REVISE" | "ERROR"

interface LoopState {
  version: 1
  status: LoopStatus
  task: string

  round: number

  checks: string[]

  sessionId?: string

  armedAt: string
  updatedAt: string

  lastVerdict?: LoopVerdict
  lastReviewId?: string
  lastReviewPath?: string
  lastBlockReason?: string
  lastError?: string
}

interface CheckResult {
  command: string
  exitCode: number
  durationMs: number
  stdoutTail: string
  stderrTail: string
  timedOut: boolean
}

interface LoopReview {
  verdict: LoopVerdict
  summary: string
  blockers: Array<{
    title: string
    evidence: string
    instructionForClaude: string
  }>
  nextInstructionForClaude: string
}

interface StopHookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: "Stop" | string
  last_assistant_message?: string
  background_tasks?: Array<{
    status?: string
    description?: string
    command?: string
  }>
  session_crons?: unknown[]
}
```

## Review Schema

Use `codex exec --output-schema schema.json --output-last-message review.json`.

```ts
const LOOP_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "summary",
    "blockers",
    "nextInstructionForClaude",
  ],
  properties: {
    verdict: { type: "string", enum: ["PASS", "REVISE", "ERROR"] },
    summary: { type: "string" },
    blockers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "evidence", "instructionForClaude"],
        properties: {
          title: { type: "string" },
          evidence: { type: "string" },
          instructionForClaude: { type: "string" },
        },
      },
    },
    nextInstructionForClaude: { type: "string" },
  },
} as const
```

Do not add a free-form fallback parser in the MVP. The verified Codex build
supports `--output-schema`.

## Codex Invocation Refactor

The loop should share only the low-level Codex invocation machinery with the
existing `ask` path.

Refactor `codexCommand(meta, sessionId?)` into:

```ts
interface CodexInvocation {
  repo: string
  sandbox: string
  approval: string
  answerPath: string
  model?: string
  profile?: string
  outputSchemaPath?: string
  resumeSessionId?: string
  skipGitCheck?: boolean
  extraConfig?: string[]
}

function codexCommand(inv: CodexInvocation): string[] {
  const cmd = [
    "codex",
    "exec",
    "--cd", inv.repo,
    "--color", "never",
    "--sandbox", inv.sandbox,
    "--output-last-message", inv.answerPath,
    "--json",
  ]
  if (inv.outputSchemaPath) cmd.push("--output-schema", inv.outputSchemaPath)
  if (inv.model) cmd.push("--model", inv.model)
  if (inv.profile) cmd.push("--profile", inv.profile)
  if (inv.skipGitCheck) cmd.push("--skip-git-repo-check")
  for (const item of inv.extraConfig ?? []) cmd.push("-c", item)
  cmd.push("-c", `approval_policy=${JSON.stringify(inv.approval)}`)
  if (inv.resumeSessionId) cmd.push("resume", inv.resumeSessionId)
  cmd.push("-")
  return cmd
}
```

`model`, `profile`, `skipGitCheck`, and `extraConfig` remain in this shared
type to preserve the existing `ask` command behavior. The MVP loop does not
expose those as loop options.

The existing `ask` path builds a `CodexInvocation` with `resumeSessionId`. The
loop builds one with:

```ts
{
  repo,
  sandbox: "read-only",
  approval: "never",
  answerPath: reviewJsonPath,
  outputSchemaPath: schemaPath,
}
```

Extract the spawn core:

```ts
interface CodexResult {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  error?: Error
}

function runCodex(
  args: string[],
  input: string,
  cwd: string,
  timeoutMs?: number,
): CodexResult {
  const r = spawnSync(args[0], args.slice(1), {
    cwd,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    error: r.error,
  }
}
```

`runWorker` should call `runCodex` without a timeout to preserve current
background-review behavior. The loop passes the remaining evaluation budget.

## Diff Capture

Keep full diff capture in the MVP. It is core review quality, not optional
machinery.

Requirements:

- include unstaged diff
- include staged diff
- include text content for untracked files
- exclude secret-looking paths before reading content
- skip large or binary untracked files
- redact before prompt assembly
- truncate final diff context
- if full diff capture fails, fall back to summary output for both unstaged and
  staged changes

Secret path exclusions:

```ts
const SECRET_PATHSPECS = [
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude)**/.env",
  ":(exclude)**/.env.*",
  ":(exclude)**/*.pem",
  ":(exclude)**/*.key",
  ":(exclude)**/id_rsa*",
  ":(exclude)**/*.p12",
  ":(exclude)**/*.pfx",
  ":(exclude)**/secrets/**",
]
```

Fallback must include staged summaries too:

```ts
const unstagedStat = runCapture("git", ["diff", "--stat", "--", ".", ...SECRET_PATHSPECS], { cwd: repo })
const unstagedNames = runCapture("git", ["diff", "--name-status", "--", ".", ...SECRET_PATHSPECS], { cwd: repo })
const stagedStat = runCapture("git", ["diff", "--cached", "--stat", "--", ".", ...SECRET_PATHSPECS], { cwd: repo })
const stagedNames = runCapture("git", ["diff", "--cached", "--name-status", "--", ".", ...SECRET_PATHSPECS], { cwd: repo })
```

Untracked capture should read at most 100 files, skip files larger than 256 KiB,
and skip buffers containing NUL bytes.

## Prompt Template

Use only the latest assistant message, not the full Claude transcript.

```text
You are Codex acting as a strict but practical implementation review gate for a
Claude Code session.

Claude is the implementer. You are the read-only reviewer.
Your job is to decide whether Claude should be allowed to stop.
Return JSON matching the provided schema only.

Repository root:
{repo}

Task:
{task}

Configured check results:
{checkResults}

Current git status:
{gitStatus}

Full working-tree diff, truncated and redacted:
{gitDiffFull}

Claude's latest assistant message:
{lastAssistantMessage}

Decision rules:
- PASS only if the task appears implemented, configured checks passed, and
  there are no blocking or major unresolved issues.
- REVISE if Claude should continue making code, test, or doc changes.
- ERROR only if you cannot review due to missing context or tool failure.
- Focus on correctness, regressions, missing tests, broken types/builds,
  security/authorization, data migration, and incompleteness.
- Do not nitpick formatting unless it affects correctness or maintainability.
- Do not ask Claude to make broad unrelated changes.
- Prefer concrete evidence: file paths, functions, tests, commands, diffs.
- Keep nextInstructionForClaude directly actionable.
```

If no latest assistant message is available, write:

```text
No assistant message captured.
```

## Stop Hook Behavior

`codex-sidecar loop hook stop` reads `StopHookInput` JSON on stdin.

Invalid hook input JSON:

- append a short entry to `.codex-sidecar/loop/hook-errors.log`
- write nothing to stdout
- exit 0

Hook algorithm:

```ts
function handleStopHook(input: StopHookInput): void {
  const repo = repoRoot(input.cwd ?? process.cwd())
  const loop = loadLoop(repo)

  if (!loop || loop.status !== "active") return allow()
  if (loop.sessionId && input.session_id && loop.sessionId !== input.session_id) return allow()
  if (sessionPausedForLaterWork(input)) return allow()

  if (loop.round >= LOOP_MAX_ROUNDS) {
    updateLoop({ ...loop, status: "exhausted" })
    return allow()
  }

  const deadline = new Deadline(LOOP_TIMEOUT_SEC)
  const checkResults = runChecks(repo, loop.checks, deadline)
  const failed = checkResults.filter((r) => r.exitCode !== 0 || r.timedOut)

  if (failed.length > 0) {
    return blockWithCheckFailure(repo, loop, checkResults, failed)
  }

  const review = runCodexLoopReview(repo, loop, input, checkResults, deadline)
  return applyReview(repo, loop, review)
}
```

`allow()` writes nothing to stdout and exits 0.

`block(reason)` writes:

```json
{ "decision": "block", "reason": "..." }
```

and exits 0.

Paused sessions are allowed:

```ts
function sessionPausedForLaterWork(input: StopHookInput): boolean {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : []
  const crons = Array.isArray(input.session_crons) ? input.session_crons : []
  const taskActive = tasks.some((t) => t?.status !== "completed" && t?.status !== "failed")
  return taskActive || crons.length > 0
}
```

## Applying Results

Round semantics:

- `round` counts blocking rounds already issued.
- `LOOP_MAX_ROUNDS = 3` is the maximum number of blocks before fail-open exhaustion.
- Initial `round` is 0.
- A `REVISE` or failed check increments `round` and blocks.
- On a later Stop, if `round >= LOOP_MAX_ROUNDS`, mark `exhausted` and allow.

Review handling:

```ts
function applyReview(repo: string, loop: LoopState, review: LoopReview): HookDecision {
  saveReviewArtifacts(repo, loop, review)

  if (
    review.verdict === "PASS" &&
    review.blockers.length === 0
  ) {
    updateLoop({ ...loop, status: "passed", lastVerdict: "PASS" })
    return allow()
  }

  if (review.verdict === "ERROR") {
    updateLoop({ ...loop, status: "error", lastVerdict: "ERROR", lastError: review.summary })
    return allow()
  }

  const nextRound = loop.round + 1
  const reason = formatReviseReason(loop, review, nextRound)
  updateLoop({
    ...loop,
    status: "active",
    round: nextRound,
    lastVerdict: "REVISE",
    lastBlockReason: reason,
  })
  return block(reason)
}
```

Check failures use the same round semantics. They save a review artifact with a
local `REVISE` result and do not call Codex.

## Block Reason Format

Keep the hook block reason concise.

```text
Codex implementation gate says the work is not ready yet.

Task:
{task}

Round:
{round}/{LOOP_MAX_ROUNDS}

Summary:
{summary}

Blocking findings:
1. {title}
   Evidence: {evidence}
   Claude should: {instructionForClaude}

Next instruction for Claude:
{nextInstructionForClaude}

Full review:
{path}

Address the blockers, run relevant checks, and try to finish again. If a finding
is wrong, explain why with file evidence.
```

For check failures:

```text
Gate verification failed before Codex review.

Failed command:
{command}

Exit code:
{exitCode}

Output tail:
{tail}

Claude should fix the failing verification command, rerun it, and then try to
finish again.
```

## Hook Registration

Extend `mergeHook` so it can install a Stop hook without a matcher and with a
timeout:

```ts
mergeHook(
  hooks,
  "Stop",
  undefined,
  "codex-sidecar loop hook stop",
  3600,
)
```

Stop has no matcher support, so omit the `matcher` key for this hook entry.

The installed hook timeout is only a safety net. `LOOP_TIMEOUT_SEC` is the
actual total evaluation budget.

Keep the existing SessionStart and UserPromptSubmit capture hooks unchanged for
the advisory `ask` workflow.

## Build Order

1. Add loop state helpers for `.codex-sidecar/loop.json`.
2. Add `loop start`, `loop status`, `loop read`, and `loop stop`.
3. Refactor `codexCommand` to accept `CodexInvocation`.
4. Extract `runCodex` and rewire `runWorker` through it.
5. Add the check runner with a single hardcoded total deadline.
6. Add `runCapture`, secret path exclusions, untracked capture, and full diff
   capture with staged fallback summaries.
7. Add the simplified review schema and implementation prompt builder.
8. Add loop-local review artifact writing.
9. Add `loop review`.
10. Add `loop hook stop`.
11. Extend `mergeHook` and add `init --install-loop-hook`.
12. Add focused `node:test` coverage.
13. Run `npm run check` and `npm run build`.
14. Dogfood in this repo before adding deferred scope.

## Test Plan

Use Node's built-in `node:test` and `node:assert`. Add a `test` script when the
first tests are introduced.

Automated tests:

- `codexCommand` constructs schema-based loop invocation with no `resume`.
- `runCodex` preserves no-timeout behavior when timeout is undefined.
- `runCodex` reports timeout when timeout expires.
- check runner uses the remaining total deadline.
- `gitUntrackedText` captures small text files.
- `gitUntrackedText` skips binary, large, and secret-looking files.
- `gitDiffFull` includes unstaged, staged, and untracked content.
- `gitDiffFull` fallback includes both unstaged and staged summaries.
- Stop hook allows when no active loop exists.
- Stop hook allows session mismatch.
- Stop hook allows paused sessions with background tasks or session crons.
- failed checks block and do not call Codex.
- Codex `PASS` marks loop passed and allows.
- Codex `REVISE` increments round and blocks.
- Codex invalid JSON marks error and allows.
- `LOOP_MAX_ROUNDS` exhaustion marks the loop exhausted and allows on the next Stop.

Manual fake-Codex checks:

- fake Codex writes `PASS` JSON to `--output-last-message`.
- fake Codex writes `REVISE` JSON.
- fake Codex writes malformed JSON.
- fake check command fails.
- fake check command times out.

Before hook end-to-end testing, run:

```bash
npm run build
```

The package bin points at `dist/cli.js`, so stale compiled output can mask fixes.

## Later V2 Candidates

Add only after the MVP is stable:

- plan mode with plan-file review
- `HUMAN` verdict and user-question state
- no-progress short-circuiting
- blocker fingerprints and stuck detection
- `--fail-closed`
- `--sandbox`, `--approval`, `--profile`, arbitrary Codex config
- optional full Claude transcript context
- Claude `/codex-loop` skill
- multiple named loops
- richer criteria tracking

Each v2 addition should be justified by real dogfooding pain, not by theoretical
completeness.

# Codex Sidecar Loop Feature Spec

Verified against the installed Codex (`codex-cli 0.137.0`): `codex exec` supports
`--output-schema`, `--output-last-message`, `--json`, `--sandbox`, `--model`, `--profile`,
`--cd`, `--color`, `--skip-git-repo-check`, and `-c key=value`. It does **not** support
`--ask-for-approval`; approval is set with `-c approval_policy=<mode>` (as the existing
`codexCommand` already does, cli.ts:575).

## Executive summary

Add an opt-in `loop` feature to the existing TypeScript `codex-sidecar` CLI.

The loop lets Claude Code iterate with Codex as a read-only reviewer:

```text
Claude plans or implements
        ↓
Claude tries to stop
        ↓
Claude Code Stop hook invokes  codex-sidecar loop hook stop
        ↓
objective checks run first, when configured
        ↓
Codex reviews a stable artifact:
  - plan mode:           plan file + latest Claude message
  - implementation mode: working-tree diff + latest Claude message
        ↓
PASS   → let Claude stop
REVISE → block Stop and give Claude concise feedback
HUMAN  → block once so Claude asks the user a question, then allow stop
ERROR  → fail-open by default, fail-closed if configured
```

This is an **advanced, opt-in quality gate**, not the default background-review workflow. Keep the
existing `ask` / `read` / `watch` second-opinion flow untouched. Add `loop` for tasks where review
gating is worth the latency and control-flow complexity.

## Design stance

Prefer a small, robust first version:

- One active loop per repo (`default`); named loops can come later.
- User-facing name is `loop`.
- Loop mode is explicit: `--mode plan` or `--mode implement`.
- Plan mode is file-based by default, for a stable review artifact.
- Implementation mode reviews a full truncated diff, not only `git diff --stat`.
- Codex output uses `--output-schema` JSON (supported here), with an optional bracketed-block
  parser only as a compatibility fallback for older Codex builds.
- Codex reviews are fresh per loop round — do **not** use Codex `resume` inside the loop; carry
  cross-round memory via injected prior-review summaries instead.
- Checks run before Codex in implementation mode.
- The loop's Codex call reuses shared low-level run primitives — a `codexCommand` that takes an
  explicit `CodexInvocation` spec and a `runCodex` spawn helper — not a parallel spawn. It does
  **not** route through `ask` / `runWorker`, which carry thread / `resume` / `latest` bookkeeping
  the loop does not want. See "Shared run-path refactor" below.
- The loop's prompt builder is composition, not greenfield: it reuses `redact`, `truncate`,
  `gitContext`, `claudeContext`, plus the new `gitDiffFull`. No reinventing redaction/truncation.
- Keep everything in the single `src/cli.ts` file — no module split yet, and no third-party
  test-runner dependency. Cover the pure helpers (command construction, hook decisions, hashes,
  untracked capture, schema/fence parsing, check/time-budget behavior) with Node's built-in
  `node:test` (Node 20+, already required by `engines`); walk the stateful hook scenarios with the
  manual smoke tests in the test plan as we build.
- Stop hook install is explicit: `init --install-claude --install-loop-hook`.
- Fail-open by default; `--fail-closed` is opt-in.

## Why not just use the existing background review?

Background reviews are advisory:

```bash
codex-sidecar ask --claude "Review this plan"
codex-sidecar read
```

Loop reviews are control flow:

```text
Claude cannot finish until configured checks and Codex review pass, or until the loop
exhausts / escalates.
```

Use the loop for higher-risk work: auth, payments, migrations, CI fixes, large refactors, or
plans for non-trivial features.

## CLI additions

### Install

Normal Claude integration remains non-gating:

```bash
codex-sidecar init --install-claude
```

Loop hook install is explicit:

```bash
codex-sidecar init --install-claude --install-loop-hook
```

This installs a Stop hook that is inert unless a loop is active.

### Start a plan loop

```bash
codex-sidecar loop start \
  --mode plan \
  --max-rounds 3 \
  --plan-file .codex-sidecar/plan.md \
  --criteria "plan identifies affected modules" \
  --criteria "plan includes a test strategy" \
  --criteria "plan identifies open product questions" \
  add team-level notification settings
```

Plan mode means Claude should plan only, not implement code yet. Codex reviews the plan artifact.

### Start an implementation loop

```bash
codex-sidecar loop start \
  --mode implement \
  --max-rounds 3 \
  --check "npm run typecheck" \
  --check "npm test -- auth" \
  --criteria "no cross-tenant authorization regression" \
  fix the auth middleware bug
```

Implementation mode means Claude can edit code. Codex reviews the working-tree diff after objective
checks pass.

### Manual review

```bash
codex-sidecar loop review
```

Runs the same loop evaluation manually, without emitting Claude hook JSON. Return codes:

```text
0 = PASS / allowed
1 = REVISE or HUMAN
2 = ERROR
```

This command is important for testing the loop without relying on Stop hooks.

### Status / read / stop

```bash
codex-sidecar loop status
codex-sidecar loop read
codex-sidecar loop stop
```

`loop stop` deactivates the loop but preserves review artifacts.

## Command options

`loop start` options:

```text
--mode plan|implement      default implement
--max-rounds <n>                default 3, clamp 1..7
--criteria <text>               repeatable
--check <cmd>                   repeatable; alias --test; implementation mode by default
--plan-file <path>              plan mode artifact; default .codex-sidecar/plan.md
--require-plan-file             block if plan file does not exist
--blind                         omit the Claude transcript excerpt (still include last_assistant_message)
--max-claude-chars <n>          default 20000
--sandbox <mode>                default read-only
--approval <mode>               default never  (applied as -c approval_policy=<mode>)
--model <model>                 optional Codex model override
--profile <profile>             optional Codex profile override
--review-timeout <sec>          default 600
--check-timeout <sec>           default 300
--fail-closed                   block on Codex errors instead of fail-open
--session any|current           default current if a session is captured, otherwise any with a warning
```

The Claude transcript excerpt is included by default (the existing `ask --claude` behavior);
`--blind` turns it off. For a first implementation, support a single active loop named `default`.

## State layout

One active state file plus per-review artifacts, under the existing `.codex-sidecar/` directory:

```text
.codex-sidecar/
  loop.json
  latest.md
  claude-session.json
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
        meta.json
```

`.codex-sidecar/` is already added to `.git/info/exclude` by the existing `addLocalGitExclude`
(cli.ts:228); reuse it.

## TypeScript types

```ts
type LoopMode = "plan" | "implement"
type LoopStatus =
  | "active"
  | "awaiting_human"
  | "passed"
  | "exhausted"
  | "stuck"
  | "error"
  | "inactive"
type LoopVerdict = "PASS" | "REVISE" | "HUMAN" | "ERROR"
type CriterionStatus = "met" | "not_met" | "unclear" | "not_applicable"

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"
type ApprovalMode = "never" | "on-request" | "untrusted"

interface LoopState {
  version: 1
  status: LoopStatus
  mode: LoopMode
  task: string
  criteria: string[]

  maxRounds: number
  round: number

  checks: string[]
  planFile?: string
  requirePlanFile: boolean

  blind: boolean
  includeClaudeContext: boolean
  maxClaudeChars: number

  sandbox: SandboxMode
  approval: ApprovalMode
  model?: string
  profile?: string

  failClosed: boolean
  reviewTimeoutSec: number
  checkTimeoutSec: number

  sessionId?: string
  armedAt: string
  updatedAt: string

  lastVerdict?: LoopVerdict
  lastReviewId?: string
  lastReviewPath?: string
  lastBlockReason?: string
  lastArtifactHash?: string
  lastBlockerFingerprint?: string
  stuckRounds: number
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
  confidence: "high" | "medium" | "low"
  summary: string

  criteria: Array<{
    criterion: string
    status: CriterionStatus
    evidence: string
  }>

  blockers: Array<{
    severity: "blocking" | "major" | "minor"
    title: string
    evidence: string
    instructionForClaude: string
  }>

  checks: Array<{
    command: string
    status: "passed" | "failed" | "not_run"
    evidence: string
  }>

  nextInstructionForClaude: string
}

interface StopHookInput {
  session_id?: string
  transcript_path?: string
  cwd?: string
  permission_mode?: string
  hook_event_name?: "Stop" | string
  stop_hook_active?: boolean
  // Provided by Claude Code's current Stop hook (verified against the hooks docs), along with
  // `background_tasks` / `session_crons` (v2.1.145+). Prefer this field; fall back to deriving the
  // latest assistant message from `transcript_path` only for older Claude builds that omit it.
  // See `resolveLastAssistantMessage` in "Loop prompt builder".
  last_assistant_message?: string
  background_tasks?: Array<{
    id?: string
    type?: string
    status?: string
    description?: string
    command?: string
  }>
  session_crons?: unknown[]
}
```

## Review schema

Use Codex structured output. Write this schema to `schema.json` and call Codex with
`--output-schema schema.json` and `--output-last-message review.json`.

```ts
const LOOP_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "confidence",
    "summary",
    "criteria",
    "blockers",
    "checks",
    "nextInstructionForClaude",
  ],
  properties: {
    verdict: { type: "string", enum: ["PASS", "REVISE", "HUMAN", "ERROR"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    summary: { type: "string" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "status", "evidence"],
        properties: {
          criterion: { type: "string" },
          status: { type: "string", enum: ["met", "not_met", "unclear", "not_applicable"] },
          evidence: { type: "string" },
        },
      },
    },
    blockers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "evidence", "instructionForClaude"],
        properties: {
          severity: { type: "string", enum: ["blocking", "major", "minor"] },
          title: { type: "string" },
          evidence: { type: "string" },
          instructionForClaude: { type: "string" },
        },
      },
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "status", "evidence"],
        properties: {
          command: { type: "string" },
          status: { type: "string", enum: ["passed", "failed", "not_run"] },
          evidence: { type: "string" },
        },
      },
    },
    nextInstructionForClaude: { type: "string" },
  },
} as const
```

Compatibility fallback: for older Codex builds without `--output-schema`, add an optional parser
for a bracketed `CODEX_REVIEW_RESULT … END_CODEX_REVIEW_RESULT` block later. Do not make that the
primary path — `--output-schema` is supported on the verified build.

## Plan mode

Plan mode is for iterating on a plan before implementation.

Start:

```bash
codex-sidecar loop start --mode plan --plan-file .codex-sidecar/plan.md <feature request>
```

Claude should inspect the repo and create/update the plan file. Codex reviews that plan file plus
the latest Claude message and relevant repo context.

### Default plan criteria

If no `--criteria` is provided in plan mode, use:

```text
The plan states the user-facing goal and non-goals.
The plan identifies affected modules, files, or subsystems.
The plan accounts for existing repo conventions and similar implementations.
The plan breaks implementation into safe, reviewable steps.
The plan includes a test strategy.
The plan identifies data model, migration, rollout, or backwards-compatibility concerns if relevant.
The plan identifies security, authorization, privacy, or reliability risks if relevant.
The plan identifies open questions requiring user/product input instead of guessing.
The plan is specific enough for Claude to implement without major reinterpretation.
```

### Plan prompt template

```text
You are Codex acting as a strict but practical plan review gate for a Claude Code session.

Claude is planning a feature or fix but should not implement code yet.
Your job is to decide whether Claude's plan is good enough to begin implementation.
Return JSON matching the provided schema only.

Repository root:
{repo}

Planning goal:
{task}

Explicit success criteria:
{criteriaList}

Plan artifact path:
{planFile}

Plan artifact contents:
{planText}

Claude's latest assistant message:
{lastAssistantMessage}

Current repo context:
{gitStatus}
{relevantFiles}
{similarPatternsIfAvailable}

Optional recent Claude transcript excerpt:
{claudeContext}

Prior loop review summaries:
{priorReviewSummaries}

Decision rules:
- PASS only if the plan is specific, feasible, scoped, and safe enough to implement.
- PASS means planning is ready; it does not mean implementation is complete.
- REVISE if the plan is missing important repo context, implementation steps, tests,
  rollout/migration concerns, or risk analysis.
- HUMAN if the plan depends on a product/UX/security decision Claude should not guess.
- ERROR only if you cannot review due to missing context or tool failure.
- Do not require implementation work in plan mode.
- Do not nitpick prose style.
- Prefer concrete evidence from the repo: file paths, existing modules, similar patterns, tests,
  config, migrations.
- Keep nextInstructionForClaude directly actionable.
```

### Plan mode behavior

- If `planFile` is missing and `requirePlanFile` is true, block before Codex and tell Claude to
  create it.
- If `planFile` is missing and not required, first version may simply block with a clear local
  message asking Claude to create it.
- Do not require git diff changes.
- Artifact hash is `hash(planFileContents)` only — see "No-progress and cap behavior" for why the
  latest assistant message, criteria, and task are deliberately excluded from the hash.
- Checks are skipped by default; if provided, run them, but do not require checks for plan mode
  unless they fail.
- On `PASS`, mark `status=passed` and allow stop.
- On `REVISE`, block with planning-specific feedback.
- On `HUMAN`, set `status=awaiting_human`, block once so Claude asks the user; on the next Stop,
  allow. The `UserPromptSubmit` hook flips `awaiting_human` back to `active` when the user replies.

## Implementation mode

Implementation mode is for reviewing code changes.

Start:

```bash
codex-sidecar loop start --mode implement --check "npm test -- auth" <task>
```

### Implementation prompt template

```text
You are Codex acting as a strict but practical implementation review gate for a Claude Code session.

Claude is the implementer. You are the read-only reviewer.
Your job is to decide whether Claude should be allowed to stop.
Return JSON matching the provided schema only.

Repository root:
{repo}

Task:
{task}

Explicit success criteria:
{criteriaList}

Configured check results:
{checkResults}

Current git status:
{gitStatus}

Full working-tree diff, truncated and redacted:
{gitDiffFull}

Claude's latest assistant message:
{lastAssistantMessage}

Optional recent Claude transcript excerpt:
{claudeContext}

Prior loop review summaries:
{priorReviewSummaries}

Decision rules:
- PASS only if the task appears implemented, configured checks passed, criteria are met or not
  applicable with evidence, and there are no blocking or major unresolved issues.
- REVISE if Claude should continue making code/test/doc changes.
- HUMAN if the next step requires a user/product decision Claude should not guess.
- ERROR only if you cannot review due to missing context or tool failure.
- Focus on correctness, regressions, missing tests, broken types/builds, security/authorization,
  data migration, and incompleteness.
- Do not nitpick formatting unless it affects correctness or maintainability.
- Do not ask Claude to make broad unrelated changes.
- Prefer concrete evidence: file paths, functions, tests, commands, diffs.
- Keep nextInstructionForClaude directly actionable.
```

### Full diff helper

The existing `runQuiet` (cli.ts:196) is `runQuiet(command, args, cwd?)` — it takes no options and
no `maxBuffer`, so it inherits Node's 1 MB `spawnSync` default. A diff over 1 MB would make
`spawnSync` set `result.error` (`ENOBUFS`) and truncate stdout, so `gitDiffFull` would silently
return a partial/empty diff on exactly the large changes where review matters most. Add a small
sibling `runCapture` that raises the buffer and surfaces the error (rather than reshaping
`runQuiet`, whose 3 existing callers — `gitRoot`, `gitContext`, `doctor` — would all have to change):

```ts
function runCapture(
  command: string,
  args: string[],
  opts: { cwd: string; maxBuffer?: number },
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const r = spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error }
}
```

Plain text diff only — no `--binary` (binary patches are useless to a reviewer and would consume
the truncation budget). Secret-looking paths are excluded at the git layer *before* the content ever
reaches the prompt (path-level exclusion first, `redact` as the best-effort second line):

```ts
// First line of defence: keep secret-looking files out of every diff and untracked capture.
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

function gitDiffFull(repo: string): string {
  const unstaged = runCapture("git", ["diff", "--", ".", ...SECRET_PATHSPECS], { cwd: repo, maxBuffer: 16_000_000 })
  const staged = runCapture("git", ["diff", "--cached", "--", ".", ...SECRET_PATHSPECS], { cwd: repo, maxBuffer: 16_000_000 })
  const untracked = gitUntrackedText(repo)
  // Fall back to a summary if either capture failed (e.g. ENOBUFS on a huge diff) so the reviewer
  // never silently gets a truncated/empty diff. Untracked content is still included.
  if (unstaged.error || staged.error || unstaged.status !== 0 || staged.status !== 0) {
    // The fallback must apply the same exclusions, or secret *filenames* leak via the summary even
    // when the full-diff path correctly dropped their contents.
    const stat = runCapture("git", ["diff", "--stat", "--", ".", ...SECRET_PATHSPECS], { cwd: repo })
    const names = runCapture("git", ["diff", "--name-status", "--", ".", ...SECRET_PATHSPECS], { cwd: repo })
    return truncate(
      redact(
        [
          "# Full diff unavailable (too large or git error); summary only.",
          "# diff --stat",
          stat.stdout,
          "# diff --name-status",
          names.stdout,
          untracked,
        ].join("\n\n"),
      ),
      60_000,
    )
  }
  return truncate(
    redact(
      ["# Unstaged diff", unstaged.stdout, "# Staged diff", staged.stdout, untracked].join("\n\n"),
    ),
    60_000,
  )
}
```

Untracked files never appear in `git diff` / `git diff --cached`, yet new files are the most common
— and highest-value — artifact in an implementation loop. Capturing only `git status` would show the
filenames but not their content, so Codex could not review the new code, and the artifact hash would
not move when Claude *only* adds files (falsely tripping the no-progress short-circuit). Capture the
text with size, binary, and secret filters:

```ts
function gitUntrackedText(repo: string): string {
  const list = runCapture(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...SECRET_PATHSPECS],
    { cwd: repo },
  )
  if (list.error || list.status !== 0) return "# Untracked files: capture failed."
  const files = list.stdout.split("\0").filter(Boolean)
  if (files.length === 0) return "# Untracked files: none."
  const MAX_FILE_BYTES = 256 * 1024
  const parts: string[] = ["# Untracked (new) files"]
  for (const rel of files.slice(0, 100)) {
    try {
      const stat = fs.statSync(path.join(repo, rel))
      if (!stat.isFile()) continue
      if (stat.size > MAX_FILE_BYTES) {
        parts.push(`## ${rel}\n<skipped: ${stat.size} bytes exceeds ${MAX_FILE_BYTES}>`)
        continue
      }
      const buf = fs.readFileSync(path.join(repo, rel))
      if (buf.includes(0)) {
        parts.push(`## ${rel}\n<skipped: binary>`)
        continue
      }
      parts.push(`## ${rel}\n${buf.toString("utf8")}`)
    } catch {
      parts.push(`## ${rel}\n<skipped: unreadable>`)
    }
  }
  if (files.length > 100) parts.push(`# (${files.length - 100} more untracked files omitted)`)
  return parts.join("\n\n")
}
```

The whole assembled string still passes through `redact` in `gitDiffFull`, so untracked content is
redacted too. Reuse the existing `redact` (cli.ts:890) and `truncate` (cli.ts:883) helpers.

### Implementation behavior

- Run configured checks before Codex.
- If any check fails, increment round, save output, and block without calling Codex.
- If checks pass, call Codex with the full diff and schema.
- Artifact hash is `hash(unstagedDiff + stagedDiff + untrackedFileContents)` — optionally plus a
  *normalized* check projection (`command + exitCode + timedOut` only, never `durationMs` or output
  tails). Untracked content **must** be in the hash, or adding a new file reads as no progress. The
  latest assistant message is deliberately excluded — see "No-progress and cap behavior".
- On `PASS`, mark `status=passed` and allow stop.
- On `REVISE`, block with concise feedback.
- On `HUMAN`, same `awaiting_human` flow as plan mode.
- On `ERROR`, fail-open unless `failClosed`.

## Stop hook algorithm

The Stop hook command is `codex-sidecar loop hook stop`. It reads `StopHookInput` on stdin.

```ts
async function handleStopHook(input: StopHookInput): Promise<void> {
  const repo = repoRoot(input.cwd ?? process.cwd())
  const loop = loadLoop(repo)

  if (!loop || loop.status === "inactive" || loop.status === "passed") return allow()

  if (loop.status === "awaiting_human") return allow()

  if (loop.sessionId && input.session_id && loop.sessionId !== input.session_id) return allow()

  if (sessionPausedForLaterWork(input)) return allow()

  if (loop.round >= loop.maxRounds) {
    updateLoop({ ...loop, status: "exhausted" })
    return loop.failClosed ? block(formatExhaustedReason(loop)) : allow()
  }

  if (loop.mode === "plan" && loop.requirePlanFile && !exists(resolvePlanFile(repo, loop))) {
    return block(
      `The active Codex plan loop requires a plan file at ${loop.planFile}. ` +
        `Create or update it before finishing.`,
    )
  }

  // CLI owns the time budget (see "Hook registration"). Deadline computed once at hook entry; checks
  // and the review each get min(theirTimeout, remaining). Exhaustion → internal-timeout ERROR.
  const deadline = new Deadline(loop)

  const checkResults =
    loop.mode === "implement"
      ? await runChecks(repo, loop.checks, loop.checkTimeoutSec, deadline)
      : await runOptionalPlanChecks(repo, loop.checks, loop.checkTimeoutSec, deadline)

  const failed = checkResults.filter((r) => r.exitCode !== 0 || r.timedOut)
  if (failed.length > 0) {
    const reason = formatCheckFailureReason(loop, failed)
    updateLoopAfterBlock(loop, {
      verdict: "REVISE",
      artifactHash: await computeArtifactHash(repo, loop, input, checkResults),
      reason,
    })
    return block(reason)
  }

  const artifactHash = await computeArtifactHash(repo, loop, input, checkResults)

  // No-progress short-circuit: artifact unchanged since the last REVISE means Claude did not act.
  // Skip the Codex call, re-issue prior feedback, and feed the single stuck counter (see below).
  if (loop.lastArtifactHash === artifactHash && loop.lastVerdict === "REVISE") {
    return applyNoProgress(repo, loop)
  }

  const review = await runCodexLoopReview(repo, loop, input, checkResults, deadline)
  return applyReview(repo, loop, review, artifactHash)
}
```

`block(reason)` writes exactly this to stdout and exits 0:

```json
{ "decision": "block", "reason": "..." }
```

`allow()` writes nothing to stdout and exits 0.

`sessionPausedForLaterWork(input)` returns true when the session is not really finishing but is
paused waiting for work to wake it back up. Per the hooks docs, that signal is **both**
`background_tasks` and `session_crons` (v2.1.145+) — either a running/queued background task **or** a
scheduled cron means "paused," not "done":

```ts
function sessionPausedForLaterWork(input: StopHookInput): boolean {
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : []
  const crons = Array.isArray(input.session_crons) ? input.session_crons : []
  const taskActive = tasks.some((t) => t?.status !== "completed" && t?.status !== "failed")
  return taskActive || crons.length > 0
}
```

Gating a session that is only paused for later work would block the wrong thing, so allow the stop in
that case and let the loop evaluate on the *real* finish.

## No-progress and cap behavior — one counter

A single `stuckRounds` counter, incremented by either no-progress signal and reset only on real
progress:

```text
artifactHash:
  plan mode:           hash(plan file contents)
  implementation mode: hash(unstaged diff + staged diff + untracked file contents
                            [+ normalized check projection: command + exitCode + timedOut])

blockerFingerprint:
  hash(normalized blocker titles + evidence + instructions)
```

The artifact hash must represent **only the reviewable artifact** — what Claude actually changed —
not per-run noise:

- **Exclude `durationMs` and `stdoutTail` / `stderrTail` from the hash.** They carry timings and
  timestamps, so a raw `CheckResult` makes the hash change every run even when nothing changed,
  silently defeating the no-progress short-circuit and the same-artifact `stuckRounds` path. If
  check results are hashed at all, hash only a normalized projection (`command + exitCode +
  timedOut`).
- **Exclude `lastAssistantMessage` from the hash.** Claude emits a new assistant message every turn
  (even "I've addressed the feedback"), so including it changes the hash every round regardless of
  whether the diff/plan moved — the same silent defeat as above. It still belongs in the *prompt*
  (for review quality), just not the hash.
- **Exclude the constant `criteria` / `task`** — they do not change within a loop, so they add
  nothing to a change-detection hash.

Design decision (state it, don't bake it in silently): because `lastAssistantMessage` is out of the
hash, a pure rebuttal with no artifact change hits the no-progress short-circuit and counts toward
`stuckRounds` (→ escalates after 2 rounds) instead of re-running Codex on the new argument. This is
intended: if Claude will not change the artifact and only argues, the loop escalates to the human
via the `stuck` path — that is the disagreement escape hatch, not a bug.

Rules:

- **No action** (artifact unchanged since last REVISE) → `applyNoProgress`: re-issue the prior
  block reason and `stuckRounds += 1`. This skips the Codex call entirely.
- **Action but same problems** (artifact changed, but `blockerFingerprint` equals the previous
  round) → in `applyReview`, `stuckRounds += 1`.
- **Real progress** (artifact changed and `blockerFingerprint` differs) → `stuckRounds = 0`.
- When `stuckRounds >= 2`, set `status=stuck`; fail-open allows stop, `failClosed` blocks with
  `formatStuckReason`.
- Default `maxRounds = 3`, user-settable up to 7. Claude Code's own 8-block override is a backstop
  only; the CLI does not rely on it.

```ts
function applyNoProgress(repo: string, loop: LoopState): HookDecision {
  const stuckRounds = loop.stuckRounds + 1
  if (stuckRounds >= 2) {
    updateLoop({ ...loop, status: "stuck", stuckRounds })
    return loop.failClosed ? block(formatStuckReason(loop)) : allow()
  }
  updateLoop({ ...loop, stuckRounds })
  return block(
    loop.lastBlockReason ?? "No meaningful change since the previous Codex loop feedback.",
  )
}
```

## Applying reviews

```ts
function applyReview(
  repo: string,
  loop: LoopState,
  review: LoopReview,
  artifactHash: string,
): HookDecision {
  const nextRound = loop.round + 1
  const blockerFingerprint = hash(normalizeBlockers(review.blockers))
  saveReviewArtifacts(review)

  if (
    review.verdict === "PASS" &&
    review.blockers.filter((b) => b.severity !== "minor").length === 0
  ) {
    updateLoop({
      ...loop,
      status: "passed",
      round: nextRound,
      lastVerdict: "PASS",
      lastArtifactHash: artifactHash,
    })
    return allow()
  }

  if (review.verdict === "HUMAN") {
    const reason = formatHumanReason(loop, review)
    updateLoop({ ...loop, status: "awaiting_human", lastVerdict: "HUMAN", lastBlockReason: reason })
    return block(reason)
  }

  if (review.verdict === "ERROR") {
    updateLoop({ ...loop, status: "error", lastVerdict: "ERROR", lastError: review.summary })
    return loop.failClosed ? block(formatErrorReason(loop, review)) : allow()
  }

  if (nextRound >= loop.maxRounds) {
    const reason = formatMaxRoundsReason(loop, review)
    updateLoop({
      ...loop,
      status: "exhausted",
      round: nextRound,
      lastVerdict: review.verdict,
      lastBlockReason: reason,
    })
    return loop.failClosed ? block(reason) : allow()
  }

  // REVISE: single stuck counter — bump if the same blockers recur, reset on real progress.
  const stuckRounds = loop.lastBlockerFingerprint === blockerFingerprint ? loop.stuckRounds + 1 : 0
  if (stuckRounds >= 2) {
    const reason = formatStuckReason(loop)
    updateLoop({ ...loop, status: "stuck", round: nextRound, lastVerdict: "REVISE", stuckRounds })
    return loop.failClosed ? block(reason) : allow()
  }

  const reason =
    loop.mode === "plan"
      ? formatPlanReviseReason(loop, review, nextRound)
      : formatImplementReviseReason(loop, review, nextRound)

  updateLoop({
    ...loop,
    status: "active",
    round: nextRound,
    lastVerdict: "REVISE",
    lastArtifactHash: artifactHash,
    lastBlockerFingerprint: blockerFingerprint,
    lastBlockReason: reason,
    stuckRounds,
  })

  return block(reason)
}
```

## Block reason formatting

Keep hook block reasons concise (the Stop hook `reason` is capped at ~10,000 chars). Save full
details to `loop/reviews/<id>/review.md`.

### Plan revise

```text
Codex plan gate says the plan is not ready to implement yet.

Goal:
{task}

Round:
{round}/{maxRounds}

Summary:
{summary}

Planning blockers:
1. {title}
   Evidence: {evidence}
   Claude should: {instructionForClaude}

Next instruction for Claude:
{nextInstructionForClaude}

Full review:
{path}

Revise the plan file. Do not implement code yet unless the user explicitly asks to proceed.
```

### Implementation revise

```text
Codex implementation gate says the work is not ready yet.

Task:
{task}

Round:
{round}/{maxRounds}

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

Address the blockers, run relevant checks, and try to finish again. If a finding is wrong, explain
why with file evidence.
```

### HUMAN

```text
Codex gate says this requires a user decision before continuing.

Question/decision needed:
{nextInstructionForClaude}

Claude should ask the user this question directly and not guess. After the user answers, update the
plan or implementation accordingly.
```

### Check failure

```text
Gate verification failed before Codex review.

Failed command:
{command}

Exit code:
{exitCode}

Output tail:
{tail}

Claude should fix the failing verification command, rerun it, and then try to finish again.
```

## Shared run-path refactor

The loop's Codex call and the existing `ask` path share only their lowest level: turning a spec into
a `codex exec` argument array, and spawning Codex with the prompt on stdin. They do **not** share run
preparation — `ask()` (cli.ts:379) inlines thread-oriented setup (`buildPrompt`, `setLatestRun`,
thread turns, `resume`) the loop has no use for. So rather than routing the loop through `ask` /
`runWorker`, extract the two shared primitives below and give the loop its own artifact prep.

### `codexCommand` takes a `CodexInvocation`

`codexCommand(meta: RunMeta, sessionId?)` (cli.ts:575) currently reads loop-irrelevant fields
(`fresh`, `thread`, `includeClaude`). Refactor it to take a small spec so neither caller has to fake
a `RunMeta` or thread call-specific fields through it:

```ts
interface CodexInvocation {
  repo: string
  sandbox: string
  approval: string
  answerPath: string          // --output-last-message
  model?: string
  profile?: string
  skipGitCheck?: boolean
  extraConfig?: string[]      // -c key=value
  outputSchemaPath?: string   // --output-schema   (loop sets this; ask does not)
  resumeSessionId?: string    // resume <id>        (ask sets this; loop never does)
}

function codexCommand(inv: CodexInvocation): string[] {
  const cmd = ["codex", "exec", "--cd", inv.repo, "--color", "never", "--sandbox", inv.sandbox,
    "--output-last-message", inv.answerPath, "--json"]
  if (inv.outputSchemaPath) cmd.push("--output-schema", inv.outputSchemaPath)
  if (inv.model) cmd.push("--model", inv.model)
  if (inv.profile) cmd.push("--profile", inv.profile)
  if (inv.skipGitCheck) cmd.push("--skip-git-repo-check")
  for (const item of inv.extraConfig ?? []) cmd.push("-c", item)
  cmd.push("-c", `approval_policy=${JSON.stringify(inv.approval)}`)
  if (inv.resumeSessionId) cmd.push("resume", inv.resumeSessionId)
  cmd.push("-") // prompt on stdin
  return cmd
}
```

`runWorker` builds a `CodexInvocation` from `meta` + `sessionId`; the loop builds one with
`outputSchemaPath` set and `resumeSessionId` left undefined. Approval stays `-c approval_policy=<mode>`
— **not** `--ask-for-approval`, which `codex exec` 0.137.0 does not support.

### `runCodex` — the spawn core

Extract the `spawnSync` block currently in `runWorker` (cli.ts:540, which has no timeout today),
adding an optional timeout:

```ts
interface CodexResult { status: number | null; stdout: string; stderr: string; timedOut: boolean; error?: Error }

function runCodex(args: string[], input: string, cwd: string, timeoutMs?: number): CodexResult {
  const r = spawnSync(args[0], args.slice(1), {
    cwd, input, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "",
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    error: r.error,
  }
}
```

`timeoutMs` is optional and **must stay optional**: `runWorker` passes `undefined` to preserve
today's no-timeout behavior for background reviews (imposing a default cap could truncate long but
legitimate `ask` reviews). Only the loop passes `reviewTimeoutSec * 1000`.

### Loop-local artifact prep

The loop sets up its own per-review directory — distinct from the `runs/` layout, with no thread
pointers. A `saveReviewArtifacts` helper (referenced in "Applying reviews") creates
`loop/reviews/<id>/` and writes `prompt.md`, `schema.json`, `review.json`, `review.md`,
`codex.ndjson`, `stderr.txt`, `checks.json`, `meta.json`, then refreshes
`loop/latest-review.{md,json}`.

### Loop review execution

`runCodexLoopReview(repo, loop, input, checkResults, deadline)` therefore: builds its prompt
(composition — see below), writes `schema.json`, constructs a `CodexInvocation` with
`outputSchemaPath = schemaPath` and `answerPath = reviewJsonPath`, and calls
`runCodex(codexCommand(inv), prompt, repo, deadline.remainingMs(loop.reviewTimeoutSec * 1000))` — the
review timeout capped by the time the checks already consumed, **not** a fixed
`reviewTimeoutSec * 1000` — so the synchronous review can never push the hook past the budget. If the
deadline is already exhausted, skip the spawn and return an internal-timeout `ERROR` review. It then
persists `stdout → codex.ndjson` / `stderr → stderr.txt`, parses `review.json` against the schema,
and saves artifacts. Sandbox stays `read-only` by default; no `resume`.

### Loop prompt builder

The plan and implementation prompt builders assemble the templates above by reusing existing helpers,
not by reimplementing them:

- `redact` (cli.ts:890) on every transcript/diff/file body before it enters the prompt.
- `truncate` (cli.ts:883) for size budgets.
- `gitContext` (cli.ts:483) for `{gitStatus}`. Note it shells out to `git status`/`git diff
  --name-only`/`--stat` **without** `SECRET_PATHSPECS`, so it still surfaces secret-looking
  *filenames* (not contents). Either pass `git`-pathspec exclusions through `gitContext` for the loop
  caller, or post-filter its output against `SECRET_PATHSPECS` before it enters the prompt — keep it
  consistent with `gitDiffFull` rather than leaking via the status block.
- `claudeContext` (cli.ts:501) for the `{claudeContext}` transcript excerpt (skipped when `--blind`).
- the new `gitDiffFull` for `{gitDiffFull}` in implementation mode.
- the new `resolveLastAssistantMessage` for `{lastAssistantMessage}` (see below).

`{lastAssistantMessage}` comes from the hook input: Claude Code's current Stop hook **does** include
`last_assistant_message` (and `background_tasks` / `session_crons`, v2.1.145+). Use the field as the
primary source — redacted and length-bounded like any other prompt input — and fall back to deriving
it from `transcript_path` (the JSONL transcript) via the existing `flattenJson` (cli.ts:518)
machinery only for older Claude builds that did not send the field:

```ts
function resolveLastAssistantMessage(input: StopHookInput): string {
  // Primary: the hook field (present on current Claude Code). Redact + bound it — it can be large
  // and may carry secrets, exactly like the transcript-derived fallback below.
  if (input.last_assistant_message?.trim()) {
    return truncate(redact(input.last_assistant_message), 8_000)
  }
  // Fallback for older Claude builds that omit the field: scan the JSONL transcript tail.
  const p = input.transcript_path
  if (!p || !fs.existsSync(p)) return ""
  // Scan the JSONL transcript tail for the most recent assistant turn's text.
  const lines = tailText(p, 200_000).split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as Record<string, unknown>
      const role = (entry.role ?? (entry.message as Record<string, unknown> | undefined)?.role)
      if (role === "assistant") {
        const text = flattenJson(entry.message ?? entry.content ?? entry).trim()
        if (text) return truncate(redact(text), 8_000)
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return ""
}
```

If it returns `""`, the prompt should say so explicitly (e.g. "No assistant message captured.")
rather than leaving the field blank, so Codex does not treat the absence as meaningful. The exact
transcript entry shape should be confirmed against a real transcript during the manual hook tests —
adjust the `role` / `message` extraction if Claude's JSONL nests differently.

## Hook registration

`init --install-claude --install-loop-hook` should merge, not clobber, settings (reuse the
existing `mergeHook`, cli.ts:770):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codex-sidecar loop hook stop",
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

`mergeHook` (cli.ts:770) cannot express this entry as written: it hardcodes
`const hook = { type: "command", command }` (no `timeout`) and always writes
`{ matcher, hooks: [...] }`, deduping on `entry.matcher`. It must be extended before it can install
the Stop hook:

```ts
function mergeHook(
  hooks: Record<string, Json>,
  event: string,
  matcher: string | undefined,
  command: string,
  timeout?: number,
): void {
  const current = Array.isArray(hooks[event]) ? (hooks[event] as Json[]) : []
  const asObj = current as Array<Record<string, Json>>
  // When matcher is undefined (Stop has no matcher support), match/dedup on command instead.
  const existing =
    matcher === undefined
      ? asObj.find((e) => Array.isArray(e.hooks) && (e.hooks as Json[]).some(
          (h) => (h as Record<string, Json>).command === command))
      : asObj.find((e) => e.matcher === matcher)
  const hook: Record<string, Json> = timeout === undefined
    ? { type: "command", command }
    : { type: "command", command, timeout }
  if (existing) {
    const list = Array.isArray(existing.hooks) ? (existing.hooks as Json[]) : []
    if (!list.some((item) => JSON.stringify(item) === JSON.stringify(hook))) list.push(hook)
    existing.hooks = list
  } else {
    asObj.push(matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] })
  }
  hooks[event] = asObj as unknown as Json
}
```

The two existing capture calls keep passing a matcher (`mergeHook(hooks, "SessionStart", "...", cmd)`);
the loop call passes `mergeHook(hooks, "Stop", undefined, "codex-sidecar loop hook stop", 3600)`.
Omitting the matcher key is safer than writing a stray `"*"` — per the hooks docs `Stop` has no
matcher support.

**The hook `timeout` and the loop's own time budget must be reconciled — this is load-bearing.** The
gate runs checks *and then* Codex *synchronously* inside the Stop hook. Checks are repeatable and
default to 300s **each** (`--check-timeout`), and the review defaults to 600s (`--review-timeout`),
so the worst case is easily `n × checkTimeoutSec + reviewTimeoutSec` seconds — two checks plus a
review already exceed a fixed `900`. If Claude Code kills the hook first, the gate fail-opens on
exactly the rounds doing the most work and never actually gates.

The CLI — not the editor — must own the budget (same stance as not relying on the 8-block backstop):

- Install a *generous* hook timeout (`3600`) purely as a safety net, large enough that the editor
  effectively never wins the race against a correctly-configured loop.
- Enforce an **internal remaining-time budget** inside the hook: compute a deadline at hook entry,
  pass the remaining time into `runChecks` (per-check `min(checkTimeoutSec, remaining)`) and
  `runCodexLoopReview` (`min(reviewTimeoutSec, remaining)`), and treat budget exhaustion as an
  internal timeout → `ERROR` (fail-open unless `failClosed`). This makes the CLI authoritative on
  timing regardless of the editor's configured value.
- Validate at `loop start`: reject (or clamp with a warning) timeout settings whose worst case
  (`maxRounds`-independent: `checks.length × checkTimeoutSec + reviewTimeoutSec` plus margin) would
  exceed the installed hook timeout, so the inconsistency is caught up front, not mid-review.

Keep the existing SessionStart / UserPromptSubmit capture hooks, and extend the `UserPromptSubmit`
path to flip an `awaiting_human` loop back to `active` when the user replies.

## Claude skill

Install `.claude/skills/codex-loop/SKILL.md`:

```md
---
name: codex-loop
description: Start, inspect, or stop a Codex review gate that blocks Claude from finishing until checks and Codex review pass. Use for high-risk implementation work or for iterating on a plan before code is written.
disable-model-invocation: true
allowed-tools: Bash(codex-sidecar loop *) Read(.codex-sidecar/loop.json) Read(.codex-sidecar/loop/latest-review.md) Read(.codex-sidecar/plan.md)
---

# Codex Loop

Use `codex-sidecar loop ...`.

Plan mode:

- Use when the user wants to iterate on a plan before implementation.
- Start with `codex-sidecar loop start --mode plan ...`.
- Create or update the configured plan file.
- Do not implement code unless the user explicitly asks.
- If the Stop hook blocks, revise the plan using Codex feedback.
- PASS means the plan is ready to implement, not that the feature is complete.

Implementation mode:

- Use when the user wants code changes gated by checks and Codex review.
- Start with `codex-sidecar loop start --mode implement ...`.
- When the Stop hook blocks, fix concrete blockers, run checks, and try to finish again.
- Treat Codex feedback as advisory but important; if a finding is wrong, explain why with file evidence.

Commands:

- `/codex-loop start ...` → run `codex-sidecar loop start ...`
- `/codex-loop status` → run `codex-sidecar loop status`
- `/codex-loop read` → run `codex-sidecar loop read`
- `/codex-loop stop` → run `codex-sidecar loop stop`
```

## Security notes

- Hooks run as the user. Keep hook logic small and auditable.
- Use `spawn`/`spawnSync` with argument arrays for Codex (never a shell string).
- `--check` commands run with `shell: true` (users expect shell syntax); document that checks are
  trusted local commands.
- Reuse `redact` (cli.ts:890) before including any transcript or diff context.
- Exclude secret-looking paths at the git layer *before* prompt assembly — pass `:(exclude)`
  pathspecs (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `**/secrets/**`, …) to both the diff and
  the untracked-file capture (`SECRET_PATHSPECS`, see "Full diff helper"). Path-level exclusion is
  the first line of defence; `redact` is the best-effort second line, not a substitute. This matters
  more once untracked capture is added — new files have never been screened by anyone.
- Untracked capture must filter by size and skip binary files (NUL-byte sniff) so a stray large
  artifact or binary blob cannot blow the prompt budget.
- Do not include `.env`, private keys, auth files, large binary blobs, or unbounded logs in prompts.
- Keep the Codex sandbox `read-only` by default; mention `danger-full-access` only as a warning.

## Failure behavior

Codex not found, timeout, invalid JSON, or schema failure:

- Save raw stdout/stderr/final output.
- Write an ERROR review artifact.
- If `failClosed`, block with a concise error and tell Claude to ask the user.
- Otherwise allow stop and mark the loop `error`.

Invalid hook input JSON:

- Log to `.codex-sidecar/loop/hook-errors.log`.
- Exit 0 silently.

## Optional `/goal` prototype

Before coding, or when tuning prompts, prototype the workflow manually with Claude Code `/goal`:

```text
/goal The task is complete only when Claude has run a codex-sidecar review, addressed blocking
findings, and either Codex passes or four rounds have elapsed.
```

This is not a replacement for the loop — `/goal`'s evaluator cannot run commands or inspect files
itself, so Claude must surface each review in the transcript — but it validates the workflow wording
cheaply.

## Build order

1. Add state helpers for `.codex-sidecar/loop.json` and review artifacts.
2. Add `loop start / status / read / stop`.
3. Add plan-file support and default plan criteria.
4. Add the check runner with per-check timeout and output tails, plus the internal remaining-time
   budget (deadline computed at hook entry, threaded into checks and the review).
5. Add the `runCapture` (buffer-raising, error-surfacing), `gitUntrackedText` (size/binary/secret
   filtered), and `gitDiffFull` helpers (plain diff, `SECRET_PATHSPECS` `:(exclude)` exclusions,
   untracked capture, redaction, truncation; `--stat`/`--name-status` fallback on `ENOBUFS`/git
   error).
6. Add artifact-hash (artifact-only — implement-mode hash covers unstaged + staged + untracked file
   contents; no `lastAssistantMessage`, no `durationMs`/tails) and blocker-fingerprint helpers.
7. Add prompt builders for plan and implementation modes, plus `resolveLastAssistantMessage`
   (hook-field primary, transcript-derived fallback for older Claude builds).
8. Refactor `codexCommand` to take a `CodexInvocation` spec (decoupled from `RunMeta`); extract
   `runCodex` (the `spawnSync` core, optional timeout) from `runWorker`; rewire `runWorker` onto
   both. Then add the `LoopReview` schema, the loop-local `saveReviewArtifacts` helper, and the
   structured loop runner built on `codexCommand` + `runCodex` (not `runWorker`).
9. Add the `loop review` manual path (exit codes 0/1/2).
10. Add the `loop hook stop` Stop hook path.
11. Add `UserPromptSubmit` handling to reactivate `awaiting_human` loops.
12. Extend `mergeHook` (optional `timeout`, optional matcher), then add `init --install-loop-hook`
    (Stop hook with a generous `timeout: 3600` safety net; the loop's internal time budget is the
    real authority) and the `codex-loop` skill.
13. Add `node:test` coverage for the pure helpers (command construction, hook decisions, hashes,
    untracked capture, schema/fence parsing, check/time-budget behavior), then walk the manual
    fake-Codex verification scenarios (test plan below). Run `npm run build` — the `bin` points at
    `dist/cli.js` (package.json:6), so the Stop hook runs compiled code and stale `dist` silently
    masks fixes.
14. Dogfood in this repo.

## Test plan

No third-party test-runner dependency, but the pure logic **is** covered by automated tests using
Node's built-in `node:test` + `node:assert` (Node 20+, already required by `engines`). The stateful,
end-to-end hook behavior is verified manually with a fake `codex` binary on `PATH` (a small shell
script that echoes a canned `review.json` to `--output-last-message`).

Run `npm run build` before any hook end-to-end test: the `bin` points at `dist/cli.js`
(package.json:6), so the Stop hook executes compiled output and a stale `dist` silently masks your
changes.

### Automated checks (`node:test`, pure helpers)

- `codexCommand` argument construction from a `CodexInvocation` (schema path set, no `resume`).
- Hook-decision transitions: `applyReview` (PASS/REVISE/HUMAN/ERROR), `applyNoProgress`, exhausted
  and stuck paths.
- Artifact hash + blocker fingerprint: stable across timing noise, moves on real artifact change
  (including untracked-file content), unchanged on pure rebuttal.
- `gitUntrackedText` size/binary/secret filtering.
- Schema parsing and fence/`{...}` extraction of Codex output (valid, fenced, and malformed).
- Check runner per-check timeout and the internal remaining-time budget.

### Manual checks (logic)

- Loop state read/write.
- Plan default criteria.
- JSON schema validation / parse errors.
- `gitDiffFull` truncation/redaction, secret-path exclusion, and the `--stat` fallback.
- Untracked new-file capture appears in the diff context and in the implement-mode hash.
- Check runner timeout and output tails.
- Artifact hash changes in plan mode when the plan file changes.
- Artifact hash changes in implementation mode when the diff changes or a new file is added.
- No-progress transitions (no-action and same-blockers paths both feed one `stuckRounds`).
- HUMAN `awaiting_human` transition.
- Session-guard no-op.

### Manual checks (hook end-to-end)

- No active loop → Stop hook stdout empty.
- Session mismatch → stdout empty.
- Background tasks present → stdout empty.
- Scheduled `session_crons` present (no running tasks) → stdout empty (session paused, not done).
- Failed check → hook blocks and Codex not invoked.
- Fake Codex REVISE → hook blocks with valid JSON.
- Fake Codex PASS → hook stdout empty and state `passed`.
- Fake Codex HUMAN → hook blocks once, then next Stop allows.
- Fake Codex invalid JSON → fail-open by default, fail-closed blocks.
- Internal time budget exhausted (slow checks/review) → internal timeout `ERROR`; fail-open allows,
  fail-closed blocks; the editor never kills the hook first.
- Max rounds exhausted → state `exhausted`; fail-open allows, fail-closed blocks.

### Live smoke test

Toy plan loop:

```bash
codex-sidecar loop start --mode plan --max-rounds 2 --plan-file .codex-sidecar/plan.md add a README section
```

Toy implementation loop:

```bash
codex-sidecar loop start --mode implement --max-rounds 2 --check "grep -q LOOP_OK README.md" add LOOP_OK to README
```

## Non-goals for the first version

- Multiple active loops.
- Autonomous code editing by Codex.
- PR comments.
- Remote workers.
- Web UI.
- Automatic test selection.
- Sophisticated scoring/evals.
- Persistent Codex `resume` inside loop mode.
- Carrying an approved plan automatically into an implementation loop (plan → implement pipeline).

## First-version scope

```text
One active, opt-in loop:
  - plan mode
  - implementation mode
  - schema-based Codex review (--output-schema)
  - check/test before Codex
  - single Stop hook command (codex-sidecar loop hook stop)
  - session guard
  - fail-open default
  - reuse of codexCommand (spec-based) / runCodex / redact / truncate / gitContext /
    claudeContext / mergeHook (loop runs on the low-level primitives, not ask / runWorker)
```

Add fancier loop concepts only after this simple version is stable.

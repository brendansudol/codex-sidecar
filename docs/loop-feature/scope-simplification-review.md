# Codex Loop Scope Simplification Review

## Executive summary

Overall assessment: **significantly overbuilt for a first merge**, though much of the complexity
came from faithfully implementing the full plan and then hardening review findings.

The smallest coherent version worth merging is an **implementation-mode loop gate** with:

- `loop start --check ... <task>`
- Stop hook evaluation
- checks before Codex
- structured schema review of the working-tree diff
- `PASS` allow, `REVISE` block, `ERROR` fail-open by default
- basic `status`, `read`, and `stop`

Estimated simplification potential: **large**. The biggest opportunity is **behavior narrowing and
feature deferral**, not clever refactoring.

Top recommendation: cut the first version back to an implementation gate. Defer plan mode, broad
option surfaces, compatibility parsers, and stuck/no-progress heuristics unless they are explicit
launch requirements.

## Scope reviewed

Reviewed the current working-tree change set for the loop feature, especially:

- `src/cli.ts`
- `test/loop.test.js`
- `README.md`
- `docs/testing.md`
- `docs/loop-feature/original-plan.md`

Not reviewed: live Codex behavior, Claude Code hook runtime behavior beyond code paths, or a PR
discussion thread.

## Core value

The main value is an opt-in Claude Code Stop-hook quality gate where local checks and Codex review
can block premature completion.

The smallest valuable feature is **Codex implementation review gate**. Plan review is useful, but it
is a second product mode with separate artifact semantics, criteria, prompts, hashes, and failure
behavior.

## Behavior/value audit

| Behavior | Classification | Evidence | Complexity cost | Recommendation |
| --- | --- | --- | --- | --- |
| Implementation-mode Stop gate | core | `evaluateLoop`, `runChecks`, `runCodexLoopReview` | high | keep, but narrow |
| Structured Codex schema review | core/contractual | `LOOP_REVIEW_SCHEMA`, `--output-schema` | medium | keep |
| Plan mode | nice-to-have | default criteria, plan file handling, prompt/hash branches | medium-high | defer unless required |
| Configurable sandbox/approval/model/profile/timeouts/blind/session | nice-to-have/speculative | `parseLoopStartArgs`, `LoopState` | medium | narrow before merge |
| No-progress/stuck blocker fingerprint logic | nice-to-have/accidental | `applyNoProgress`, `lastBlockerFingerprint`, `stuckRounds` | medium | consider cutting |
| Compatibility review parsing from fences/stdout/stderr | speculative | `parseLoopReviewText`, `extractReviewJsonText` | low-medium | defer unless old Codex builds are supported |
| Secret filtering | security-required | `SECRET_PATHSPECS`, `filterSecretDiffSections`, `redact` | medium | keep |
| Review artifacts | core | `saveReviewArtifacts` | medium | keep, possibly simplify layout |
| Claude skill install | nice-to-have | `loopSkillMarkdown`, `--install-loop-hook` | low-medium | defer if CLI-only first release is acceptable |

## Top simplification opportunities

### 1. Defer plan mode

Files/functions involved: `DEFAULT_PLAN_CRITERIA`, `LoopState`, `buildLoopPrompt`, plan hash/check
tests.

Complexity today: separate mode, criteria, plan file, missing-file behavior, prompt branch, hash
branch, and tests.

Simpler approach: first merge supports implementation mode only. Add plan mode later after the
implementation gate proves useful.

Behavior change: narrows the feature by removing pre-implementation planning gate from v1.

Estimated code reduction: **medium**, roughly 150-250 source/test lines.

Risk: **medium**, because docs/spec mention plan mode.

Recommendation: **needs product/tech lead decision before merge**.

### 2. Cut stuck/no-progress heuristics

Files/functions involved: `applyNoProgress`, `applyReview`, `lastArtifactHash`,
`lastBlockerFingerprint`, `stuckRounds`.

Complexity today: extra state, hashing semantics, blocker fingerprints, terminal stuck status, and
several edge-case tests.

Simpler approach: rely on `maxRounds`. Each Stop runs checks/review until `PASS`, `HUMAN`, `ERROR`,
or rounds are exhausted.

Behavior change: unchanged artifacts may call Codex again; `maxRounds` bounds cost and behavior is
easier to explain.

Estimated code reduction: **medium**, roughly 100-180 lines plus tests.

Risk: **low-medium**.

Recommendation: **strong candidate before merge**.

### 3. Remove compatibility review parsers

Files/functions involved: `parseLoopReviewText`, `extractReviewJsonText`, fence/block parser tests.

Complexity today: fallback parsing from `review.json`, stdout, stderr, fenced JSON, and compatibility
blocks.

Simpler approach: require `--output-schema` and parse only `review.json`. If missing or invalid,
record `ERROR`.

Behavior change: older Codex builds without schema support will not work.

Estimated code reduction: **small-medium**, roughly 60-100 lines/tests.

Risk: **low** if the minimum Codex version is documented.

Recommendation: **before merge**.

### 4. Narrow loop start options

Files/functions involved: `parseLoopStartArgs`, `loopHelp`, `LoopState`.

Options to consider deferring: `--sandbox`, `--approval`, `--model`, `--profile`, `--blind`,
`--max-claude-chars`, `--session`, and possibly timeout knobs.

Simpler approach: hardcode first-version defaults: read-only, approval never, current session when
captured, default transcript budget, default timeouts.

Behavior change: less power-user configurability.

Estimated code reduction: **medium**, roughly 100-180 lines/docs/tests.

Risk: **medium** if users expect Codex CLI parity.

Recommendation: **narrow before merge unless required**.

### 5. Defer Claude `/codex-loop` skill

Files/functions involved: `installClaudeIntegration`, `loopSkillMarkdown`.

Complexity today: extra installed surface, docs, allowed tools, and user behavior expectations.

Simpler approach: install only the Stop hook; users start loops via CLI initially.

Behavior change: less polished Claude UX. CLI still works.

Estimated code reduction: **small**.

Risk: **low**.

Recommendation: **follow-up unless dogfooding needs it**.

## Candidate behavior cuts

- **Plan loops**: defer unless plan gating is a must-have.
- **`stuck` state and blocker fingerprinting**: cut; `maxRounds` is enough for first version.
- **Fence/compat parser**: cut; require structured output.
- **Model/profile/sandbox/approval overrides**: defer; use safe defaults.
- **`--session any|current`**: remove public option; internally guard by captured session if available.
- **`--blind` / `--max-claude-chars`**: defer unless transcript privacy needs this control
  immediately.

## Pure refactor opportunities

- Reuse one diff capture per evaluation so `computeArtifactHash()` and prompt building do not repeat
  the same expensive `git diff` and untracked scans.
- Centralize secret filtering into one path sanitizer/redactor helper cluster.
- Split loop code out of the single `cli.ts` eventually. This is not required by the repo style, but
  the feature has pushed the file past a comfortable CLI-script size.

## Test simplification opportunities

Current tests are useful, but many encode behavior that may be cut:

- Remove plan-mode tests if plan mode is deferred.
- Remove stuck/error terminal tests if stuck logic is cut.
- Remove fence/block parser tests if compatibility parsing is cut.
- Keep security tests around secret filtering and symlink skipping.
- Keep one end-to-end fake-Codex test for `PASS`/`REVISE` paths; avoid testing every internal branch
  if behavior is narrowed.

## Quick wins

### Behavior-preserving quick wins

- Reuse one diff capture per evaluation.
- Make secret filtering helpers more explicitly named and grouped.
- Keep generated `dist/`, but review source/test diffs separately to reduce reviewer load.

### Scope-reduction quick wins

- Remove compatibility parser fallback.
- Hide or remove `--session`.
- Remove model/profile/sandbox/approval overrides from the first release.
- Defer `/codex-loop` skill if CLI use is acceptable.

## Do not simplify

- **Secret filtering/redaction**: looks fussy, but the security risk justifies it.
- **Structured output schema**: central to reliable gating.
- **Fail-open default**: important for hook safety.
- **Check-before-Codex ordering**: core value and avoids wasting review calls.
- **Review artifacts**: essential for debugging blocked hooks.

## Recommended plan

1. Before merge: decide whether plan mode is required. If not, cut it.
2. Before merge: cut compatibility parser fallback and reduce loop start options to a minimal public
   surface.
3. Before merge: consider removing stuck/no-progress heuristics and relying on `maxRounds`.
4. Follow-up: add plan mode and advanced options after the implementation gate is dogfooded.
5. Follow-up: split loop code out of `cli.ts` only after the behavior surface stabilizes.
6. Do not touch: security filtering, schema output, check-before-review, fail-open default, artifact
   persistence.

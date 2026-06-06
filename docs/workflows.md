# Codex Sidecar Workflows

These examples show concrete ways to use `codex-sidecar` in practice.

Terminology used throughout:

- **Claude**: the main Claude Code session driving the work.
- **Codex sidecar**: this CLI wrapper.
- **Codex**: the second-opinion agent running in the same repository.

## Core Mental Model

The sidecar is most useful when Codex is treated as an independent repo-aware reviewer, not as a second primary coding agent.

Claude drives the work. Codex answers targeted questions such as:

```text
Is this plan missing anything?
Does this suspected bug make sense?
What would you test?
What files should we inspect before changing this?
Is this refactor safe?
What is the strongest counterargument to Claude's conclusion?
```

The usual pattern is:

```text
Claude forms a plan or finding
  -> You ask Codex for an independent opinion
  -> Claude keeps working or waits
  -> Codex answer gets injected or read
  -> Claude incorporates, rejects, or investigates Codex's feedback
```

The sidecar is especially valuable when Codex can inspect the same repo but is explicitly asked to be skeptical.

## Workflow 1: Plan Review Before Implementation

This is the highest-value everyday use case.

### Situation

Claude has proposed a refactor plan. Before letting Claude touch many files, ask Codex to review the plan against the actual repo.

### Example

```text
User:
Claude, I want to replace the current auth middleware with the new policy-based checks.
First inspect the repo and propose a plan.
```

```text
Claude:
I found the current auth path:

- src/middleware/auth.ts validates the session
- src/auth/roles.ts defines role helpers
- src/api/admin/* has repeated role checks
- tests/auth-middleware.test.ts covers only missing/invalid sessions

Proposed plan:

1. Add a policy map in src/auth/policies.ts
2. Replace repeated role checks in admin routes
3. Keep middleware responsible only for session extraction
4. Add tests for admin and editor access
5. Remove old helper functions after migration
```

Ask Codex in the background:

```text
/codex-opinion Review Claude's auth refactor plan against the repo. Be skeptical.
Does the plan miss hidden coupling, tests, or migration risk?
Do not modify files. Return verdict, evidence, and concrete recommendations.
```

Claude Code runs something like:

```bash
codex-sidecar ask --claude "Review Claude's auth refactor plan against the repo..."
```

Claude can continue with a smaller low-risk step while Codex reviews.

Possible Codex answer:

```text
Verdict: The plan is directionally good, but it misses two important risks.

1. Tenant scoping is mixed into role checks
   Evidence:
   - src/api/admin/users.ts checks both isAdmin(user) and user.tenantId === targetTenantId
   - Moving role checks into a simple policy map may accidentally authorize cross-tenant access.

2. Existing tests only cover auth failure, not authorization boundaries
   Add tests for:
   - admin in tenant A cannot update user in tenant B
   - editor cannot access billing endpoints
   - unauthenticated request still fails before policy evaluation

Recommendation:
Split policies into:
- authentication: who is the user?
- authorization: can this user perform action X on resource Y?
- tenant/resource guard: does this resource belong to the user's tenant?

Do not migrate billing routes until tenant-scoped tests exist.
```

Why this helps: Codex can catch hidden coupling before Claude turns a clean-looking refactor into a dangerous one.

## Workflow 2: Sanity-Checking a Suspected Bug

### Situation

Claude finds something suspicious and is about to spend time fixing it. Ask Codex whether the finding is real.

### Example

```text
User:
Claude, investigate why users sometimes get double-charged during checkout.
```

```text
Claude:
I found a possible race in submitCheckout. The frontend button can be clicked twice before
the loading state updates, causing two POST requests to /api/checkout.

I think we should debounce the button and add a backend idempotency key.
```

Ask Codex:

```text
/codex-opinion Claude thinks duplicate charges are caused by double-clicking checkout before loading state updates.
Independently inspect the repo and tell us whether that hypothesis is likely correct.
Look for existing idempotency, retry behavior, webhook handling, and payment provider logic.
Do not modify files.
```

Possible Codex answer:

```text
Verdict: Claude's hypothesis is plausible but probably incomplete.

Evidence:
- The frontend can send multiple checkout requests.
- However, src/payments/createPaymentIntent.ts already passes an idempotency key derived from cart.id.
- The more concerning path is src/payments/webhooks.ts: payment_succeeded creates an order
  without checking whether an order already exists for the payment intent.
- If the payment provider retries the webhook, the app may create duplicate orders even when
  the payment itself is not duplicated.

Recommendation:
1. Keep the frontend loading-state fix as UX hardening.
2. Do not assume it fixes duplicate orders.
3. Add a unique constraint on paymentIntentId or check-before-create in webhook processing.
4. Add a webhook retry test.
```

Good prompt shape:

```text
Claude believes X.
Independently verify X.
Find evidence for and against.
Suggest what to inspect next.
Do not modify files.
```

## Workflow 3: Reviewing the Current Diff While Claude Continues

### Situation

Claude is implementing a change. You want a background reviewer inspecting the diff while Claude continues.

### Example

```text
/codex-opinion Review the current working tree diff.
Look for behavior changes, missing tests, type issues, and places where the new abstraction
is weaker than the old inline checks.
Do not edit files. Be concise but specific.
```

This also works before commits:

```bash
codex-sidecar ask --claude "Review the current git diff as a pre-commit reviewer. Blocking issues first."
```

Possible Codex answer:

```text
Verdict: Mostly safe, but there is one behavior change.

Finding:
src/api/admin/users.ts previously returned 404 when a user existed outside the admin's tenant.
The new policy helper returns 403.

This may leak resource existence across tenants if callers can distinguish 403 from 404.

Recommendation:
Preserve the old behavior by keeping the tenant lookup scoped:
- fetch user by { id, tenantId }
- return 404 if missing
- only then apply role/action policy

Suggested test:
"admin from tenant A receives 404 when updating user from tenant B"
```

## Workflow 4: Parallel Test Failure Triage

### Situation

Claude is debugging a failing test. Codex can independently inspect the failure and, when allowed, run targeted tests.

If test execution writes cache files, coverage files, snapshots, or build artifacts, use a write-capable sandbox:

```bash
codex-sidecar ask \
  --sandbox workspace-write \
  --approval never \
  --claude \
  "CI is failing on date formatting tests. Independently inspect date/time utilities and tests.
   You may run targeted tests if needed, but do not intentionally edit source files.
   Find the likely root cause and suggest the minimal fix."
```

Possible Codex answer:

```text
Likely root cause:
The tests expect formatInvoiceDate("2026-03-08T00:30:00Z") to render as March 8,
but in America/New_York this is March 7 local time.

Evidence:
- src/utils/date.ts uses new Date(input) and toLocaleDateString() without specifying timeZone.
- tests/date.test.ts expects UTC calendar dates.

Minimal fix:
If invoice dates are supposed to be UTC calendar dates, pass timeZone: "UTC" explicitly.

Add one test around a midnight UTC boundary.
```

## Workflow 5: Long-Lived Side Thread During a Refactor

### Situation

You are doing a multi-hour or multi-day refactor and want Codex to maintain a side conversation about that topic.

Use a named thread:

```bash
codex-sidecar ask -t auth-refactor --claude "We are starting an auth refactor. Review the initial plan..."
```

Continue it:

```bash
codex-sidecar ask -t auth-refactor --claude "We migrated admin/users. Does this address your earlier tenant-boundary concern?"
```

Ask later follow-ups:

```bash
codex-sidecar ask -t auth-refactor --claude "Now review the billing route migration plan. Anything different here?"
```

When done:

```bash
codex-sidecar clear -t auth-refactor
```

Named threads are useful for:

```text
auth-refactor
ci-debugging
release-review
migration-plan
security-pass
perf-investigation
```

## Workflow 6: Blind Review Versus Transcript-Aware Review

There are two useful modes.

### Transcript-Aware Review

Use `--claude` when the question refers to Claude's plan, Claude's finding, or previous conversation:

```bash
codex-sidecar ask --claude "Does Claude's plan make sense?"
```

Good uses:

```text
What do you think of Claude's plan?
Is Claude's bug finding real?
Did Claude miss any risks?
Compare your view with Claude's conclusion.
```

### Blind Independent Review

Omit `--claude` when you do not want Codex anchored by Claude's opinion:

```bash
codex-sidecar ask "Independently inspect the checkout flow for duplicate-charge risks."
```

Good uses:

```text
Find likely cause independently.
Review the repo architecture from scratch.
Look for security risks in this area.
Suggest tests without seeing Claude's proposed tests.
```

A useful hybrid prompt:

```text
First, inspect the repo independently.
Then, after forming your view, compare it to Claude's current plan from the transcript.
```

## Workflow 7: Skeptical Staff Engineer Review

### Situation

Claude is about to choose an architecture direction. You want a critical review, not agreement.

### Example

```text
/codex-opinion Act as a skeptical staff engineer.
Review Claude's proposal to introduce BullMQ/Redis-backed background jobs.
Use the repo to check whether this fits existing deployment, config, test setup, and operational model.
Find reasons this may be overkill or risky.
Return: verdict, top 3 risks, safer alternative if any.
```

Possible Codex answer:

```text
Verdict: BullMQ is reasonable if Redis is truly available in all environments,
but the repo suggests Redis is optional today.

Top risks:
1. Local/dev environment currently falls back to in-memory cache when Redis is absent.
2. The test setup does not provision Redis.
3. The deployment config has Redis only for production web nodes, not separate worker processes.

Safer first step:
Introduce an abstract job interface and an in-process adapter for development/tests.
Add BullMQ as the production adapter only after worker deployment is defined.
```

## Workflow 8: PR Review Before Opening a Pull Request

### Situation

Claude has finished a feature. Ask Codex to review it like a PR reviewer before a human reviewer sees it.

### Example

```bash
codex-sidecar ask --claude "
Review the current working tree as if this were a pull request.
Focus on correctness, tests, backwards compatibility, security, and maintainability.
Do not nitpick formatting.
Return blocking issues first, then non-blocking suggestions.
"
```

Possible Codex answer:

```text
Blocking:
1. Missing migration rollback
   migrations/20260605_add_policy_tables.sql has an up migration but no down migration.

2. Test gap
   New policy behavior is covered for admins but not editors.

Non-blocking:
1. PolicyDecision could include a reason enum instead of string messages.
2. Consider moving route-specific policies closer to route modules if the central file grows.
```

## Workflow 9: Test Design

### Situation

Claude has implemented code, but you want an independent set of expected tests before writing or reviewing the test suite.

### Example

```bash
codex-sidecar ask --claude "
Claude just implemented the policy-based admin user update flow.
Do not write code.
Inspect the repo and propose the most important regression tests.
Prioritize tests that would catch authorization or tenant-boundary bugs.
"
```

Possible Codex answer:

```text
Recommended tests:

1. Admin can update user in same tenant.
2. Admin receives 404 for user in another tenant.
3. Editor cannot update user role.
4. Unauthenticated request receives 401.
5. Deleted/suspended user cannot be updated even by admin.
6. Audit log is written only after successful update.

Most important missing edge case:
The route updates role and profile fields together. Add a test where editor can update profile
fields but not role fields, if that distinction exists in product requirements.
```

## Workflow 10: Clearing Context and Starting Fresh

### Situation

The side thread has become polluted by an unrelated topic, or you want a fresh review.

Clear the default thread:

```bash
codex-sidecar clear
```

Then ask a fresh question:

```text
/codex-opinion Fresh topic. The Vite build started failing after dependency updates.
Inspect config, package versions, and likely breaking changes.
Do not modify files. Give likely root cause and next commands to run.
```

Possible Codex answer:

```text
Likely root cause:
The project upgraded vite-plugin-svgr from v3 to v4, but imports still use the old
ReactComponent syntax.

Evidence:
- package.json has vite-plugin-svgr ^4
- src/icons/*.tsx imports { ReactComponent as Icon } from "./icon.svg"
- v4 expects ?react imports unless configured otherwise

Suggested fix:
Update imports to import Icon from "./icon.svg?react" or configure svgr compatibility.
```

## Workflow 11: Follow-Up Questions

### Situation

Codex gives a useful critique, and Claude asks Codex a follow-up in the same side thread.

### Example

```text
/codex-opinion Review the database migration plan. Is the backfill safe?
```

Codex:

```text
The plan is risky because the backfill runs in one transaction and updates all rows.
For a large table, this could lock writes for too long.
```

Follow up:

```bash
codex-sidecar ask --claude "
Follow-up to your previous migration review:
You said the backfill may lock writes for too long.
Given this repo's migration setup, what safer migration pattern would you recommend?
"
```

Possible Codex answer:

```text
Use a three-phase migration:

1. Add nullable column.
2. Deploy app code that writes both old and new fields.
3. Backfill in batches outside the schema migration.
4. Add not-null constraint only after verification.

In this repo, migration files appear schema-only. The batch backfill should likely be a
one-off script under scripts/.
```

## Workflow 12: When Claude and Codex Disagree

### Situation

Claude believes something is safe. Ask Codex to try to prove it is unsafe.

### Example

```text
/codex-opinion Claude thinks the old compatibility layer can be removed now.
Independently verify. Search for static references, dynamic imports, config flags, tests, docs, and scripts.
Return whether removal is safe.
```

Possible Codex answer:

```text
Removal is not safe yet.

Static references are gone, but there is a dynamic reference:
- scripts/replay-events.ts builds the old adapter name from config
- docs/runbooks/replay-events.md still documents the old adapter
- test fixtures include old-format events

Recommendation:
Keep the compatibility layer until replay tooling is migrated or explicitly deprecated.
```

The disagreement is the signal. Codex does not have to always be right; it only needs to find things Claude might miss.

Good prompt shape:

```text
Claude believes removal is safe.
Codex, try to prove removal is unsafe.
```

## Automatic Hook Behavior

With the Claude hook installed, completed Codex answers can be injected as additional context on the next user prompt.

The interaction can feel like this:

```text
User:
/codex-opinion Review the current diff for tenant leaks.
```

```text
Claude:
Started Codex sidecar run 20260605-143012-default.
```

You keep working:

```text
User:
Continue with the next route.
```

The hook injects something like:

```text
Codex sidecar completed a background answer.

Thread: default
Question: Review the current diff for tenant leaks.

Answer:
Potential tenant leak in src/api/admin/users.ts.
The lookup fetches by user id before tenant check, then returns 403.
Previous behavior returned 404 because lookup was tenant-scoped.
Recommend preserving tenant-scoped lookup.
```

Claude can then pause and incorporate the review before continuing.

## Practical Prompting Patterns

The best Codex sidecar prompts are narrow and adversarial.

Good prompts:

```text
Review Claude's plan. Be skeptical. Find hidden coupling and missing tests.
```

```text
Independently verify Claude's suspected root cause. Find evidence for and against.
```

```text
Review the current diff as a PR reviewer. Blocking issues only.
```

```text
Inspect this migration plan. Focus on lock risk, rollback safety, and deploy ordering.
```

```text
Find the strongest argument against this implementation.
```

```text
Assume this code will be used by a malicious tenant. Look for authorization mistakes.
```

```text
Do not modify files. Return verdict, evidence, confidence, and recommended next step.
```

Less useful prompts:

```text
What do you think?
Review everything.
Is this good?
Help Claude.
```

Those are too broad. Codex will often produce generic feedback unless you give it a specific role and target.

## Suggested Answer Format

You can ask Codex to answer in a consistent structure:

```text
Return your answer in this format:

Verdict:
- Safe / risky / unclear

Most important finding:
- One-sentence summary

Evidence:
- File paths, functions, behavior, or tests that support the finding

Recommendations:
- Concrete next steps

Confidence:
- High / medium / low, with reason
```

Example:

```bash
codex-sidecar ask --claude "
Review Claude's current plan.

Return:
1. Verdict
2. Top 3 risks
3. Evidence from repo
4. Missing tests
5. Recommended next step

Do not modify files.
"
```

## Where This Is Most Useful

Strong use cases:

```text
Plan review
Bug-hypothesis validation
Security/authorization review
Migration/deployment risk
Current diff review
Test design
Refactor safety checks
"Try to prove this is wrong" reviews
```

Less useful use cases:

```text
Tiny mechanical edits
Simple syntax fixes
Questions where Claude already has all the evidence
Huge vague reviews with no target
Tasks where two agents editing simultaneously would conflict
```

For coding tasks, keep Claude as the editor and Codex as the reviewer by default. That avoids conflicting file modifications.

## Recommended Loop

For serious changes, use this loop:

```text
1. Claude inspects repo and proposes plan.
2. Ask Codex: "Review this plan skeptically."
3. Claude revises plan.
4. Claude implements first small slice.
5. Ask Codex: "Review current diff for regressions."
6. Claude fixes issues.
7. Ask Codex: "What tests are missing?"
8. Claude adds tests.
9. Ask Codex: "PR-style review, blocking issues only."
10. Commit.
```

In practice, the sidecar is most valuable when you use it to create productive disagreement. Claude drives; Codex challenges.

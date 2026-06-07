# Implementation Plan: Prompt Template System

Status: implemented (v1 — `src/templates.ts` + `--template`/`templates`; see git history)
Source: roadmap item #6 ("Prompt Template System")
Review: revised after a skeptical second-opinion pass from Codex (see "Revision notes" at the end).

## Goal

Make common Codex-sidecar prompt shapes reusable without retyping long instructions, while keeping the default prompt review-oriented and keeping all repo-context assembly (git, prior turns, Claude transcript, context files, the user question) owned by code.

A template customizes only the **leading role + instructions + output-format block** — the chunk currently hardcoded at `src/cli.ts:442-452`. Everything else the builder assembles is unchanged.

## Design decisions

These resolve the roadmap's open questions and fold in the second-opinion review.

1. **Prefix-only, not full prompt builder.** A template provides only the intro/instructions block. The CLI keeps assembling git context, prior turns, Claude context, context files, and always appends the user question **last**. Rationale: the final `# User question for Codex` chunk (`src/cli.ts:479`) is the most specific instruction and must stay after all context; truncation/redaction/Claude-context safety must stay in code where a template author cannot drop it.

2. **No `{{question}}` placement escape hatch.** Templates cannot relocate the question. It is always appended last whenever a question exists. (Cut from the original plan — it weakened prompt ordering for marginal flexibility.)

3. **Variables: a small fixed set.** `{{repo}}`, `{{thread}}`, `{{date}}`. (`{{question}}` is intentionally NOT a template variable in v1, since the question is code-appended last.) Simple string substitution, no template engine, zero new dependencies.

4. **Unknown placeholders are a hard error**, not a warning. `buildPrompt` runs in the foreground `ask()` before the detached worker spawns (`src/cli.ts:413`), so a thrown error surfaces directly to the user. A warning would otherwise vanish into `worker.log`.

5. **No-question templates carry a `defaultQuestion`.** Instead of making the question broadly optional (which leaves blank, ugly metadata across `latest.md` `:561`, thread turns `:567`, the `status` display `:683`, and the hook injection payload `:839`), each built-in meant to stand alone supplies a `defaultQuestion`. When the user provides no free text and a template is selected, `meta.question` is set to the template's `defaultQuestion` so all downstream metadata stays meaningful. **Validation is deferred to `ask()`, not `parseAskArgs`** — the parser cannot know a *local* template's `defaultQuestion` because reading `.codex-sidecar/templates/` requires `repoRoot()`, which is only called inside `ask()` (`src/cli.ts:382`). See the parsing change under "Code changes".

6. **Built-ins live in a new `src/templates.ts` module**, as in-code constants (still zero-dependency, no package/file-shipping changes). This keeps `cli.ts` lean rather than embedding long template strings in an already 885-line file.

7. **Local template overrides are personal, not team-shared, in v1.** `.codex-sidecar/templates/<name>.md` overrides a built-in for the local developer only, because `.codex-sidecar/` is git-excluded (`README.md:22`). A committed, team-shared template path is deferred (see "Future work"). This is an explicit v1 scope choice.

8. **Validate template names before touching the filesystem.** A raw `.codex-sidecar/templates/<name>.md` join is path-traversal prone. `resolveTemplate` must reject any `name` not matching `^[A-Za-z0-9_.-]+$` (no slashes, no `..`) before building a path, and may additionally assert the resolved path stays inside the templates dir.

## Template file format

A markdown file with optional YAML-ish frontmatter:

```markdown
---
description: PR-style review of the working-tree diff, blocking issues first
defaultQuestion: Review the current working tree as a strict pull-request reviewer.
---
You are OpenAI Codex acting as a strict pull-request reviewer for {{repo}} (thread: {{thread}}).

Report blocking issues first, then non-blocking suggestions. Cite file paths and line numbers.
Do not modify files.

Answer format: Verdict / Blocking / Non-blocking / Recommended next step.
```

- **Body** replaces the intro block at `src/cli.ts:442`. Variables interpolated; unknown `{{…}}` errors.
- **Frontmatter** is optional. `description` shows in the `templates` listing. `defaultQuestion` is used only when the user supplies no free-text question.
- Missing frontmatter → the whole file is treated as body.

**Frontmatter grammar (deliberately tiny — not real YAML).** To avoid users assuming YAML behavior that does not exist, the parser supports only: an opening `---` on the first line, a closing `---` on its own line, and `key: value` pairs in between. Single-line values only; no nesting, lists, quoting rules, or multiline. **Known keys only** (`description`, `defaultQuestion`); unknown keys are ignored. `parseTemplateFile` implements exactly this — no YAML dependency.

## Resolution & precedence

`resolveTemplate(repo, name)` first **validates the name** (`^[A-Za-z0-9_.-]+$`, no slashes, no `..`) and errors before any filesystem access, then looks up in order:

1. Repo-local file: `.codex-sidecar/templates/<name>.md` (personal override).
2. In-code `BUILTIN_TEMPLATES` (from `src/templates.ts`).
3. Not found → error listing available names.

(The existing `slug()` at `src/cli.ts:251` *transforms* names and is the wrong tool here — template resolution must *validate and reject* so `plan-review` resolves exactly and `../foo` errors rather than being silently rewritten.)

`buildPrompt` always resolves a template; the default name is `review`.

## Built-in templates (v1)

Ship four; add the rest after real use:

| name | purpose | has `defaultQuestion`? |
|---|---|---|
| `review` | Default. Byte-for-byte the current intro block. | No (default path always has a user question today) |
| `plan-review` | Skeptical review of a proposed plan against the repo. | Yes |
| `diff-review` | PR/pre-commit review of the working-tree diff, blocking issues first. | Yes |
| `bug-hypothesis` | Independently verify a suspected root cause; evidence for and against. | Yes |

Each non-default template encodes a role + focus + answer format lifted from the matching section of `docs/workflows.md`. Deferred built-ins (add later): `test-design`, `security-review`, `migration-review`, `pr-review`.

## CLI surface changes

- **`--template <name>`** on `ask`. Default resolves to `review`. (No `-T` alias in v1 — too close to `-t`/`--thread`; can add later.)
- **`codex-sidecar templates`** — new command listing built-in + local templates with descriptions; marks local files that override a built-in as `(overrides built-in)`.
- The question stays **required** on the default path. It becomes optional only when a `--template` with a `defaultQuestion` is selected, in which case the `defaultQuestion` fills `meta.question`.
- Update `help()` ask-options block and command list (`src/cli.ts:144-177`).
- Add `Bash(codex-sidecar templates *)` to the installed skill's `allowed-tools` in `skillMarkdown()` (`src/cli.ts:785`; the `allowed-tools` line to edit is `:789`) so Claude can list templates.

## Code changes by location

- `src/templates.ts` (new): `BUILTIN_TEMPLATES: Record<string, { description?: string; defaultQuestion?: string; body: string }>` plus the pure helpers `parseTemplateFile(text)`, `renderTemplate(body, vars)`.
- `AskOptions` (`src/cli.ts:74-88`): add `template?: string`.
- `parseAskArgs` (`316-371`): parse `--template` only — **do not consult template metadata here.** Keep the required-question error at `:369` ONLY when no `--template` was given; if `--template` is present but no question, skip the error and defer validation to `ask()`.
- `RunMeta` (`17-49`): add `template?: string` (records which template rendered; keeps runs reproducible and visible in `status --json`).
- `ask()` (`379-436`): after `repoRoot()` (`:382`) and `resolveTemplate()`, if there is still no question — use the template's `defaultQuestion` when present, else error (e.g. `provide a question, or use a template with a built-in default`). Then thread `opts.template` into `meta` and set the resolved `meta.question` before writing metadata/prompt.
- `resolveTemplate(repo, name)` (new): **validate `name` (`^[A-Za-z0-9_.-]+$`, reject slashes/`..`) before building any path**, then precedence lookup (local file → built-in → throw with available names).
- `buildPrompt(meta)` (`438-481`): replace the hardcoded chunk at `442` with `renderTemplate(resolved.body, { repo, thread, date })`. The question chunk at `479` is unchanged (always appended).
- `main()` switch (`90-129`): wire the `templates` subcommand.
- Rebuild `dist/` (the bin points at `dist/cli.js`, `package.json:6`) — the CLI users run is compiled output.

## Edge cases

- Unknown template name → `unknown template '<x>'. Available: review, plan-review, diff-review, bug-hypothesis`.
- Empty / whitespace-only body → error (clearer than emitting a blank intro).
- Missing frontmatter → whole file is the body.
- Local file named like a built-in → local wins; `templates` listing flags it `(overrides built-in)`.
- Unknown `{{placeholder}}` → hard error (surfaced in foreground before worker spawn).
- Template name containing `/`, `..`, or other disallowed characters → error before any filesystem access (traversal guard).
- `--template` given with no question and the template has no `defaultQuestion` → error in `ask()` after resolution.
- `--template` + `--fresh` / `--claude` / threads / `--context-file` → fully orthogonal; template only changes the intro block, all other assembly is unaffected.

## Testing

The render/resolve helpers are pure functions (this also advances roadmap #2's testability goal).

- **Golden regression gate (do this before adding any new template):** assert `renderTemplate(BUILTIN_TEMPLATES.review.body, vars)` equals the current intro string, so a default-path run produces output identical to today (no local `review.md` present). This compares the *rendered prefix*, not a full CLI run — feasible only because `src/templates.ts` is side-effect-free and importable. (`cli.ts` is **not** importable for testing as-is: it executes `main(process.argv.slice(2))` at `src/cli.ts:898` on load. Keep the template helpers in `templates.ts` precisely so they can be imported without running the CLI.) This is the gate for step 2 below.
- Unit-level: `renderTemplate` substitutes known vars and errors on unknown ones; `parseTemplateFile` splits frontmatter/body correctly and tolerates missing frontmatter; `resolveTemplate` precedence (local > built-in > error).
- Manual smoke (add to `docs/testing.md`): `ask --template diff-review --wait` with no question (uses `defaultQuestion`); `templates` listing; a local override file; an unknown-name error; an unknown-placeholder error.

There is no test runner yet; write the helpers so a future `node --test` can import them, and add the manual smoke steps now.

## Implementation order

1. Add `src/templates.ts` with `BUILTIN_TEMPLATES` (just `review` = exact current intro) + `parseTemplateFile` + `renderTemplate`.
2. Refactor `buildPrompt` to render via the helpers with default `review`; **verify byte-identical default output** (golden gate) before going further.
3. Add `resolveTemplate` (validate name → local-file > built-in > error) and wire `--template` through `AskOptions` → `parseAskArgs` (parse only; relax the no-question error when `--template` present) → `RunMeta` → `ask()` (resolve template, fill `defaultQuestion` or error, set `meta.question`).
4. Add the remaining three v1 built-ins (`plan-review`, `diff-review`, `bug-hypothesis`) with their `defaultQuestion`s.
5. Add the `templates` listing command + `help()` text + skill `allowed-tools` entry.
6. Rebuild `dist/`; run `npm run check`.
7. Docs: `docs/workflows.md` "Prompt Templates" section (map each built-in to its workflow); README `--template` mention + `templates` command; `docs/testing.md` smoke steps.

## Future work (deferred from v1)

- Remaining built-ins: `test-design`, `security-review`, `migration-review`, `pr-review`.
- `init --templates` scaffolding of `.codex-sidecar/templates/` with editable copies of the built-ins (writes into excluded local state; adds lifecycle questions the core feature does not need yet).
- A committed, team-shared template path (resolves the shareability tension in decision #7), e.g. a repo-root location outside the git-excluded `.codex-sidecar/`.
- `-T` short alias for `--template`.
- Variable expansion beyond the fixed set, if real use demands it.

## Revision notes (from the Codex second opinion)

The original draft was simplified after an adversarial review. Changes adopted: dropped the `{{question}}` placement conditional (kept question always-last); replaced "optional question when --template set" with per-template `defaultQuestion`; unknown placeholders now error instead of warn; v1 built-ins cut from 8 to 4; built-ins moved to a separate `src/templates.ts` module; dropped the `-T` alias and `init --templates` from v1; added `templates` to the skill's `allowed-tools`; documented that local overrides are personal-only because `.codex-sidecar/` is git-excluded.

A second adversarial pass (approving implementation, with must-fixes) added: question validation is **deferred from `parseAskArgs` to `ask()`** (the parser can't read a local template's `defaultQuestion` without `repoRoot()`); `resolveTemplate` must **validate the template name** against path traversal before any filesystem access; the golden gate is scoped to `renderTemplate(BUILTIN_TEMPLATES.review.body, …)` and relies on `src/templates.ts` being side-effect-free (since `cli.ts` runs `main()` on import at `:898`); frontmatter is a **tiny explicit grammar** (known keys, single-line values, no real YAML). Stale line references were corrected to the post-`parseSessionId` numbering (`skillMarkdown` `:785`/`:789`, metadata propagation `:561`/`:567`/`:683`/`:839`, `main()` `:898`).

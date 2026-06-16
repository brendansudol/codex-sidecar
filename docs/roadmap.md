# Roadmap Notes

This is a short list of improvements worth iterating on soon. Keep the CLI small, but make the common workflows easier to trust, test, and automate.

## 1. CLI Parsing

Add a real argument parser such as `commander` or `yargs`.

Goals:

- Reduce hand-rolled option parsing.
- Improve help output.
- Make subcommand behavior easier to test.
- Add consistent validation for required values, repeated flags, defaults, and unknown options.

Open question:

- Prefer `commander` for a small command tree, or `yargs` if nested command/config behavior grows.

## 2. Unit Tests for State Management

Add focused unit tests around the local state files under `.codex-sidecar/`.

Useful coverage:

- Thread slugging.
- Latest run resolution.
- Thread creation, loading, saving, and truncation.
- Metadata updates.
- Prompt construction with and without prior turns.
- Claude transcript context capture and truncation.
- Redaction behavior.

This likely requires extracting state and prompt helpers out of `src/cli.ts` into importable modules.

## 3. Cancel Command

Add a `cancel` command.

Example:

```bash
codex-sidecar cancel
codex-sidecar cancel -t auth-refactor
codex-sidecar cancel --run 20260605-auth-refactor-12345
```

Expected behavior:

- Resolve the latest run for the selected thread unless `--run` is passed.
- If a worker or Codex process is alive, terminate it.
- Mark metadata as `cancelled`.
- Preserve logs and partial output.
- Make `read` and `status` show a clear cancelled state.

Open questions:

- Whether to terminate only the worker PID or track and terminate the child Codex PID too.
- Whether cancel should support all running threads at once.

## 4. Repo-Local Install Mode

Add:

```bash
codex-sidecar init --install-local
```

Expected output:

```text
tools/codex-sidecar
```

The wrapper should let a repo use the sidecar without requiring a global `npm link` or global install.

Possible wrapper behavior:

- Prefer the package-installed `codex-sidecar` if available.
- Fall back to `node <path-to-package>/dist/cli.js`.
- Be safe to commit if the team wants a stable repo-local entry point.

Open questions:

- Whether `tools/codex-sidecar` should be generated from the current package location or use `npx codex-sidecar`.
- Whether the wrapper should be committed or treated as local-only.
- How this interacts with `.claude/settings.local.json` hooks.

## 5. Config File Support

Add config file support:

```text
.codex-sidecar/config.json
```

Potential settings:

```json
{
  "defaultThread": "default",
  "sandbox": "read-only",
  "approval": "never",
  "model": null,
  "profile": null,
  "maxClaudeChars": 20000,
  "defaultPromptTemplate": "review",
  "injectCompletedAnswers": true
}
```

Goals:

- Avoid repeating common flags.
- Let teams standardize safer defaults.
- Keep CLI flags as the highest-precedence override.

Precedence should likely be:

```text
CLI flags -> config file -> built-in defaults
```

Open questions:

- Whether config belongs in `.codex-sidecar/` even though that directory is normally local state and git-excluded.
- Whether there should also be a committed config path such as `.codex-sidecar.json`.

## 6. Prompt Template System

> Status: v1 implemented. See [docs/plans/prompt-templates.md](plans/prompt-templates.md) for the
> design and what was deferred (remaining built-ins, `init --templates`, shared template path, `-T`).

Add a better prompt template system.

Goals:

- Make common prompt shapes reusable.
- Keep the default prompt review-oriented.
- Let users define local prompt templates for recurring workflows.

Possible built-in templates:

```text
plan-review
diff-review
bug-hypothesis
test-design
security-review
migration-review
pr-review
```

Example:

```bash
codex-sidecar ask --template diff-review --claude
```

Possible local template path:

```text
.codex-sidecar/templates/diff-review.md
```

Open questions:

- How templates accept variables such as thread, repo root, user question, and Claude context.
- Whether templates are just prompt prefixes or full prompt builders.
- Whether built-in templates should be documented in `docs/workflows.md`.

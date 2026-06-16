"use strict";
// Prompt templates for the leading role/instructions block of a Codex sidecar prompt.
//
// A template owns ONLY the intro block. The CLI (buildPrompt) still assembles git context,
// prior side-thread turns, optional Claude transcript context, extra context files, and always
// appends the user question last. Keeping this module free of side effects (no top-level I/O,
// no process.argv handling) is deliberate: it must be importable for unit tests without
// executing the CLI. See docs/plans/prompt-templates.md.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TEMPLATE = exports.BUILTIN_TEMPLATES = void 0;
exports.renderTemplate = renderTemplate;
exports.parseTemplateFile = parseTemplateFile;
// Supported frontmatter keys. Deliberately tiny: this is NOT real YAML.
const KNOWN_FRONTMATTER_KEYS = new Set(["description", "defaultQuestion"]);
// Match a run of 2+ opening braces, inner text, then 2+ closing braces. Matching the extra braces
// (rather than just `{{...}}`) is deliberate: malformed placeholders like {{repo.path}}, {{ a-b }},
// or {{{repo}}} are caught as errors instead of silently leaving stray braces in the prompt.
const PLACEHOLDER_RE = /\{\{+([^{}]*)\}\}+/g;
const VARIABLE_NAME_RE = /^[A-Za-z0-9_]+$/;
/**
 * Substitute {{var}} placeholders from `vars`. Any placeholder that is not a known, well-formed
 * variable is a hard error (surfaced in the foreground before the worker spawns), never silently
 * passed through.
 */
function renderTemplate(body, vars) {
    const bad = new Set();
    const rendered = body.replace(PLACEHOLDER_RE, (match, raw) => {
        const key = raw.trim();
        // A well-formed placeholder has EXACTLY two braces on each side; extra braces are malformed.
        const exactlyTwoBraces = match.startsWith("{{") && !match.startsWith("{{{")
            && match.endsWith("}}") && !match.endsWith("}}}");
        if (exactlyTwoBraces && VARIABLE_NAME_RE.test(key) && Object.prototype.hasOwnProperty.call(vars, key)) {
            return vars[key];
        }
        bad.add(match);
        return match;
    });
    if (bad.size > 0) {
        const offending = [...bad].join(", ");
        const supported = Object.keys(vars).map((k) => `{{${k}}}`).join(", ");
        throw new Error(`unknown or malformed template placeholder(s): ${offending}. Supported variables: ${supported}`);
    }
    return rendered;
}
/**
 * Parse a template file into frontmatter + body.
 *
 * Frontmatter grammar (intentionally minimal, not YAML):
 * - opening `---` on the first line
 * - closing `---` on its own line
 * - `key: value` pairs in between, single-line values, known keys only
 * If the first line is not `---`, or there is no closing fence, the whole file is the body.
 */
function parseTemplateFile(text) {
    const normalized = text.replace(/^\uFEFF/, "");
    const lines = normalized.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") {
        return { body: normalized.trim() };
    }
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") {
            close = i;
            break;
        }
    }
    if (close === -1) {
        // Unterminated frontmatter: treat the entire file as body.
        return { body: normalized.trim() };
    }
    const frontmatter = {};
    for (let i = 1; i < close; i++) {
        const line = lines[i];
        if (!line.trim())
            continue;
        const sep = line.indexOf(":");
        if (sep === -1)
            continue;
        const key = line.slice(0, sep).trim();
        const value = line.slice(sep + 1).trim();
        if (KNOWN_FRONTMATTER_KEYS.has(key))
            frontmatter[key] = value;
    }
    const body = lines.slice(close + 1).join("\n").trim();
    return { description: frontmatter.description, defaultQuestion: frontmatter.defaultQuestion, body };
}
// `review` is the default and reproduces the original hardcoded intro byte-for-byte once
// {{repo}}/{{thread}} are substituted. The golden test in docs/plans/prompt-templates.md
// guards this. Do not reformat without updating that test.
const REVIEW_BODY = `You are OpenAI Codex acting as a background second-opinion reviewer for a developer using Claude Code.

Repository root: {{repo}}
Side thread: {{thread}}

Instructions:
- Inspect the repository as needed.
- Give a candid second opinion, not automatic agreement.
- Prefer concrete evidence from files, commands, diffs, and tests.
- Do not edit files unless the user explicitly requested write-mode work.
- Keep the final answer structured and actionable: verdict, evidence, risks, next steps.`;
const PLAN_REVIEW_BODY = `You are OpenAI Codex acting as a skeptical staff engineer reviewing a plan for a developer using Claude Code.

Repository root: {{repo}}
Side thread: {{thread}}

Review the proposed plan against the actual repository. Be adversarial, not agreeable:
- Find hidden coupling, missing tests, migration/rollout risk, and unstated assumptions.
- Prefer concrete evidence from files, commands, diffs, and tests.
- Call out where the plan is over-engineered or where a simpler approach exists.
- Do not edit files.

Keep the final answer structured and actionable: verdict, top risks ranked, concrete fixes, anything to cut.`;
const DIFF_REVIEW_BODY = `You are OpenAI Codex acting as a strict pull-request reviewer for a developer using Claude Code.

Repository root: {{repo}}
Side thread: {{thread}}

Review the current working-tree diff (see the git context below). Focus on correctness, behavior
changes, missing tests, type/safety issues, and backwards compatibility. Report blocking issues
first, then non-blocking suggestions. Cite file paths and line numbers. Do not nitpick formatting.
Do not edit files.

Keep the final answer structured and actionable: verdict, blocking issues, non-blocking suggestions, recommended next step.`;
const BUG_HYPOTHESIS_BODY = `You are OpenAI Codex acting as an independent debugging reviewer for a developer using Claude Code.

Repository root: {{repo}}
Side thread: {{thread}}

A suspected bug or root-cause hypothesis is described below. Independently verify it against the repo:
- Look for evidence both for and against the hypothesis.
- Inspect related code paths, error handling, retries, and tests.
- Identify the most likely actual root cause and what to inspect next.
- Do not edit files.

Keep the final answer structured and actionable: verdict (confirmed/refuted/unclear), evidence for, evidence against, likely root cause, next steps.`;
exports.BUILTIN_TEMPLATES = {
    review: {
        description: "Default. Candid repo-aware second opinion: verdict, evidence, risks, next steps.",
        body: REVIEW_BODY,
    },
    "plan-review": {
        description: "Skeptical staff-engineer review of a proposed plan against the repo.",
        defaultQuestion: "Review the current plan against the repository. Be skeptical and concrete.",
        body: PLAN_REVIEW_BODY,
    },
    "diff-review": {
        description: "Strict PR/pre-commit review of the working-tree diff, blocking issues first.",
        defaultQuestion: "Review the current working tree diff as a strict pre-commit reviewer. Blocking issues first.",
        body: DIFF_REVIEW_BODY,
    },
    "bug-hypothesis": {
        description: "Independently verify a suspected root cause; evidence for and against.",
        defaultQuestion: "Independently verify the current suspected root cause. Find evidence for and against.",
        body: BUG_HYPOTHESIS_BODY,
    },
};
exports.DEFAULT_TEMPLATE = "review";
//# sourceMappingURL=templates.js.map
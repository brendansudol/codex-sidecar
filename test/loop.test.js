const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = require("../dist/cli.js");

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sidecar-loop-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function writeLoopState(repo, loop) {
  const dir = path.join(repo, ".codex-sidecar");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "loop.json"), `${JSON.stringify(loop, null, 2)}\n`);
}

function installFakeCodex() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sidecar-fake-bin-"));
  const codex = path.join(bin, "codex");
  fs.writeFileSync(codex, `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    out="$1"
  fi
  shift || exit 1
done
mkdir -p "$(dirname "$out")"
cat > "$out" <<'JSON'
{"verdict":"PASS","confidence":"high","summary":"fake pass","criteria":[],"blockers":[],"checks":[],"nextInstructionForClaude":"stop"}
JSON
exit 0
`);
  fs.chmodSync(codex, 0o755);
  return bin;
}

function baseLoop(overrides = {}) {
  return {
    version: 1,
    status: "active",
    mode: "implement",
    task: "test task",
    criteria: [],
    maxRounds: 3,
    round: 0,
    checks: [],
    requirePlanFile: false,
    blind: false,
    includeClaudeContext: true,
    maxClaudeChars: 20000,
    sandbox: "read-only",
    approval: "never",
    failClosed: false,
    reviewTimeoutSec: 600,
    checkTimeoutSec: 300,
    skipGitCheck: false,
    armedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stuckRounds: 0,
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    verdict: "PASS",
    confidence: "high",
    summary: "looks good",
    criteria: [],
    blockers: [],
    checks: [],
    nextInstructionForClaude: "stop",
    ...overrides,
  };
}

test("codexCommand builds schema review invocation without resume", () => {
  const cmd = cli.codexCommand({
    repo: "/repo",
    sandbox: "read-only",
    approval: "never",
    answerPath: "/tmp/review.json",
    outputSchemaPath: "/tmp/schema.json",
    model: "gpt-test",
  });

  assert.deepEqual(cmd.slice(0, 12), [
    "codex",
    "exec",
    "--cd",
    "/repo",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--output-last-message",
    "/tmp/review.json",
    "--json",
    "--output-schema",
  ]);
  assert.equal(cmd.at(-1), "-");
  assert.ok(cmd.includes("/tmp/schema.json"));
  assert.ok(cmd.includes("-c"));
  assert.ok(cmd.includes("approval_policy=\"never\""));
  assert.equal(cmd.includes("resume"), false);
});

test("parseLoopReviewText accepts JSON fences and compatibility blocks", () => {
  const valid = review({ verdict: "REVISE", blockers: [{
    severity: "blocking",
    title: "missing test",
    evidence: "no test file changed",
    instructionForClaude: "add a focused test",
  }] });

  assert.equal(cli.parseLoopReviewText(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``).verdict, "REVISE");
  assert.equal(cli.parseLoopReviewText(`CODEX_REVIEW_RESULT\n${JSON.stringify(valid)}\nEND_CODEX_REVIEW_RESULT`).verdict, "REVISE");
  assert.equal(cli.parseLoopReviewText("not json"), undefined);
});

test("gitUntrackedText captures text and filters secret, binary, and large files", () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, ".env"), "TOKEN=should-not-appear\n");
  fs.writeFileSync(path.join(repo, "prod.env"), "TOKEN=prod-should-not-appear\n");
  fs.writeFileSync(path.join(repo, "secret.pem"), "PRIVATE\n");
  fs.writeFileSync(path.join(repo, "src", "binary.bin"), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(repo, "src", "large.txt"), "x".repeat(300 * 1024));

  const text = cli.gitUntrackedText(repo);
  assert.match(text, /src\/new\.ts/);
  assert.match(text, /export const value = 1/);
  assert.doesNotMatch(text, /should-not-appear/);
  assert.doesNotMatch(text, /prod-should-not-appear/);
  assert.doesNotMatch(text, /prod\.env/);
  assert.doesNotMatch(text, /secret\.pem/);
  assert.match(text, /src\/binary\.bin\n<skipped: binary>/);
  assert.match(text, /src\/large\.txt\n<skipped: 307200 bytes exceeds 262144>/);
});

test("gitUntrackedText skips symlinks before reading targets", () => {
  const repo = tmpRepo();
  const target = path.join(os.tmpdir(), `codex-sidecar-secret-${process.pid}.txt`);
  fs.writeFileSync(target, "outside repo secret\n");
  fs.symlinkSync(target, path.join(repo, "notes.txt"));

  const text = cli.gitUntrackedText(repo);
  assert.match(text, /notes\.txt\n<skipped: symlink>/);
  assert.doesNotMatch(text, /outside repo secret/);
});

test("implementation artifact hash moves when only untracked content changes", () => {
  const repo = tmpRepo();
  const loop = baseLoop();
  const before = cli.computeArtifactHash(repo, loop, []);
  fs.writeFileSync(path.join(repo, "new-file.js"), "module.exports = 1;\n");
  const after = cli.computeArtifactHash(repo, loop, []);
  assert.notEqual(after, before);
});

test("gitDiffFull omits secret-like tracked diff sections and redacts common credentials", () => {
  const repo = tmpRepo();
  const githubToken = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
  const stripeToken = `sk_live_${"abcdefghijklmnopqrstuvwxyz"}`;
  fs.mkdirSync(path.join(repo, "secrets"));
  fs.writeFileSync(path.join(repo, "server.PEM"), "UPPERCASE_PEM_SECRET\n");
  fs.writeFileSync(path.join(repo, "secrets", "db.txt"), "ROOT_SECRETS_SECRET\n");
  fs.writeFileSync(path.join(repo, "prod.env"), "PROD_ENV_SECRET\n");
  fs.writeFileSync(path.join(repo, "config.txt"), [
    "DATABASE_URL=postgres://user:pass@example.test/db",
    `github=${githubToken}`,
    `stripe=${stripeToken}`,
  ].join("\n"));
  execFileSync("git", ["add", "server.PEM", "secrets/db.txt", "prod.env", "config.txt"], { cwd: repo, stdio: "ignore" });

  const text = cli.gitDiffFull(repo);
  assert.doesNotMatch(text, /UPPERCASE_PEM_SECRET/);
  assert.doesNotMatch(text, /ROOT_SECRETS_SECRET/);
  assert.doesNotMatch(text, /PROD_ENV_SECRET/);
  assert.doesNotMatch(text, /postgres:\/\/user:pass/);
  assert.doesNotMatch(text, new RegExp(githubToken));
  assert.doesNotMatch(text, new RegExp(stripeToken));
  assert.match(text, /Omitted secret-like diff section|<redacted-/);
});

test("gitDiffFull fallback includes staged-only changes", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, "big-staged.txt"), `${"a".repeat(17_000_000)}\n`);
  execFileSync("git", ["add", "big-staged.txt"], { cwd: repo, stdio: "ignore" });

  const text = cli.gitDiffFull(repo);
  assert.match(text, /Full diff unavailable/);
  assert.match(text, /# Staged diff --name-status/);
  assert.match(text, /A\s+big-staged\.txt/);
});

test("plan artifact hash includes normalized check outcomes", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, "plan.md"), "do the work\n");
  const loop = baseLoop({ mode: "plan", planFile: "plan.md" });
  const failed = [{
    command: "npm test",
    exitCode: 1,
    durationMs: 123,
    stdoutTail: "timestamp one",
    stderrTail: "",
    timedOut: false,
  }];
  const failedAgain = [{ ...failed[0], durationMs: 999, stdoutTail: "timestamp two" }];
  const passed = [{ ...failed[0], exitCode: 0 }];

  assert.equal(cli.computeArtifactHash(repo, loop, failed), cli.computeArtifactHash(repo, loop, failedAgain));
  assert.notEqual(cli.computeArtifactHash(repo, loop, failed), cli.computeArtifactHash(repo, loop, passed));
});

test("sessionPausedForLaterWork allows active tasks or scheduled crons", () => {
  assert.equal(cli.sessionPausedForLaterWork({ background_tasks: [{ status: "running" }] }), true);
  assert.equal(cli.sessionPausedForLaterWork({ session_crons: [{}] }), true);
  assert.equal(cli.sessionPausedForLaterWork({ background_tasks: [{ status: "completed" }] }), false);
  assert.equal(cli.sessionPausedForLaterWork({ background_tasks: [{}] }), false);
});

test("applyReview passes clean PASS and applyNoProgress tracks stuck rounds", () => {
  const repo = tmpRepo();
  const loop = baseLoop();
  const pass = cli.applyReview(repo, loop, {
    review: review(),
    reviewId: "review-pass",
    reviewPath: path.join(repo, ".codex-sidecar", "loop", "reviews", "review-pass", "review.md"),
  }, "hash-a");
  assert.equal(pass.decision, "allow");
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".codex-sidecar", "loop.json"), "utf8")).status, "passed");

  const reviseLoop = baseLoop({ lastVerdict: "REVISE", lastBlockReason: "fix it", stuckRounds: 0 });
  const first = cli.applyNoProgress(repo, reviseLoop);
  assert.equal(first.decision, "block");
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".codex-sidecar", "loop.json"), "utf8")).stuckRounds, 1);

  const second = cli.applyNoProgress(repo, baseLoop({ lastVerdict: "REVISE", lastBlockReason: "fix it", stuckRounds: 1 }));
  assert.equal(second.decision, "allow");
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".codex-sidecar", "loop.json"), "utf8")).status, "stuck");
});

test("applyReview HUMAN does not consume a review round", () => {
  const repo = tmpRepo();
  const human = cli.applyReview(repo, baseLoop({ round: 2, maxRounds: 3 }), {
    review: review({ verdict: "HUMAN", nextInstructionForClaude: "Ask the user." }),
    reviewId: "review-human",
    reviewPath: path.join(repo, ".codex-sidecar", "loop", "reviews", "review-human", "review.md"),
  }, "hash-human");

  const state = JSON.parse(fs.readFileSync(path.join(repo, ".codex-sidecar", "loop.json"), "utf8"));
  assert.equal(human.decision, "block");
  assert.equal(state.status, "awaiting_human");
  assert.equal(state.round, 2);
});

test("parseLoopReviewText drops malformed array items without rejecting top-level review", () => {
  const parsed = cli.parseLoopReviewText(JSON.stringify(review({
    blockers: [
      { severity: "blocking", title: "good", evidence: "evidence", instructionForClaude: "fix" },
      { severity: "blocking", title: "bad missing fields" },
    ],
    criteria: [{ criterion: "ok", status: "met", evidence: "seen" }, { criterion: "bad", status: "nope", evidence: "bad" }],
    checks: [{ command: "npm test", status: "passed", evidence: "ok" }, { command: "bad", status: "maybe", evidence: "bad" }],
  })));

  assert.equal(parsed.verdict, "PASS");
  assert.equal(parsed.blockers.length, 1);
  assert.equal(parsed.criteria.length, 1);
  assert.equal(parsed.checks.length, 1);
});

test("evaluateLoop honors requirePlanFile only when requested", () => {
  const repo = tmpRepo();
  const oldPath = process.env.PATH;
  process.env.PATH = `${installFakeCodex()}${path.delimiter}${oldPath}`;
  try {
    writeLoopState(repo, baseLoop({ mode: "plan", planFile: "missing.md", requirePlanFile: true }));
    const required = cli.evaluateLoop(repo, { cwd: repo });
    assert.equal(required.decision, "block");
    assert.match(required.reason, /needs a plan file/);

    writeLoopState(repo, baseLoop({ mode: "plan", planFile: "missing.md", requirePlanFile: false }));
    const optional = cli.evaluateLoop(repo, { cwd: repo });
    assert.equal(optional.decision, "allow");
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".codex-sidecar", "loop.json"), "utf8")).status, "passed");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("stuck and error loop states are terminal in evaluateLoop", () => {
  const repo = tmpRepo();
  writeLoopState(repo, baseLoop({ status: "stuck", failClosed: false, lastBlockReason: "same blocker" }));
  assert.equal(cli.evaluateLoop(repo, { cwd: repo }).decision, "allow");

  writeLoopState(repo, baseLoop({ status: "stuck", failClosed: true, lastBlockReason: "same blocker" }));
  assert.equal(cli.evaluateLoop(repo, { cwd: repo }).decision, "block");

  writeLoopState(repo, baseLoop({ status: "error", failClosed: false, lastError: "bad json" }));
  const open = cli.evaluateLoop(repo, { cwd: repo });
  assert.equal(open.decision, "allow");
  assert.equal(open.error, true);

  writeLoopState(repo, baseLoop({ status: "error", failClosed: true, lastError: "bad json" }));
  const closed = cli.evaluateLoop(repo, { cwd: repo });
  assert.equal(closed.decision, "block");
  assert.equal(closed.error, true);
});

test("loop start persists skipGitCheck outside git repos", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sidecar-nongit-"));
  const oldPath = process.env.PATH;
  process.env.PATH = `${installFakeCodex()}${path.delimiter}${oldPath}`;
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, "..", "dist", "cli.js"),
      "loop",
      "start",
      "--skip-git-check",
      "--mode",
      "implement",
      "nongit task",
    ], { cwd: dir, env: process.env, stdio: "ignore" });
    const state = JSON.parse(fs.readFileSync(path.join(dir, ".codex-sidecar", "loop.json"), "utf8"));
    assert.equal(state.skipGitCheck, true);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("manual loop review ignores unrelated captured session id", () => {
  const repo = tmpRepo();
  const oldPath = process.env.PATH;
  process.env.PATH = `${installFakeCodex()}${path.delimiter}${oldPath}`;
  try {
    writeLoopState(repo, baseLoop({ sessionId: "session-a" }));
    fs.writeFileSync(path.join(repo, ".codex-sidecar", "claude-session.json"), JSON.stringify({
      capturedAt: new Date().toISOString(),
      sessionId: "session-b",
      cwd: repo,
    }));
    execFileSync(process.execPath, [
      path.join(__dirname, "..", "dist", "cli.js"),
      "loop",
      "review",
    ], { cwd: repo, env: process.env, encoding: "utf8" });
    const state = JSON.parse(fs.readFileSync(path.join(repo, ".codex-sidecar", "loop.json"), "utf8"));
    assert.equal(state.status, "passed");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("new loop does not read stale latest review", () => {
  const repo = tmpRepo();
  const oldPath = process.env.PATH;
  process.env.PATH = `${installFakeCodex()}${path.delimiter}${oldPath}`;
  try {
    const loopDir = path.join(repo, ".codex-sidecar", "loop");
    fs.mkdirSync(loopDir, { recursive: true });
    fs.writeFileSync(path.join(loopDir, "latest-review.md"), "stale previous review\n");
    fs.writeFileSync(path.join(loopDir, "latest-review.json"), "{}\n");

    execFileSync(process.execPath, [
      path.join(__dirname, "..", "dist", "cli.js"),
      "loop",
      "start",
      "--mode",
      "implement",
      "fresh task",
    ], { cwd: repo, env: process.env, stdio: "ignore" });
    const output = execFileSync(process.execPath, [
      path.join(__dirname, "..", "dist", "cli.js"),
      "loop",
      "read",
    ], { cwd: repo, env: process.env, encoding: "utf8" });

    assert.match(output, /No Codex loop review has been written yet/);
    assert.doesNotMatch(output, /stale previous review/);
    assert.equal(fs.existsSync(path.join(loopDir, "latest-review.md")), false);
  } finally {
    process.env.PATH = oldPath;
  }
});

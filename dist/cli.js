#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Deadline = exports.LOOP_REVIEW_SCHEMA = void 0;
exports.applyNoProgress = applyNoProgress;
exports.applyReview = applyReview;
exports.blockerFingerprintFor = blockerFingerprintFor;
exports.codexCommand = codexCommand;
exports.computeArtifactHash = computeArtifactHash;
exports.evaluateLoop = evaluateLoop;
exports.gitDiffFull = gitDiffFull;
exports.gitUntrackedText = gitUntrackedText;
exports.hashText = hashText;
exports.parseLoopReviewText = parseLoopReviewText;
exports.runChecks = runChecks;
exports.sessionPausedForLaterWork = sessionPausedForLaterWork;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const process = __importStar(require("node:process"));
const APP = "codex-sidecar";
const STATE_DIR = ".codex-sidecar";
const DEFAULT_THREAD = "default";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOOP_HOOK_TIMEOUT_SEC = 3600;
const LOOP_REVIEW_DIR = "loop";
const DEFAULT_PLAN_FILE = path.join(STATE_DIR, "plan.md");
const SECRET_PATHSPECS = [
    ":(exclude).env",
    ":(exclude).env.*",
    ":(exclude)*.env",
    ":(exclude)**/.env",
    ":(exclude)**/.env.*",
    ":(exclude)**/*.env",
    ":(exclude)*.pem",
    ":(exclude)**/*.pem",
    ":(exclude)*.key",
    ":(exclude)**/*.key",
    ":(exclude)id_rsa*",
    ":(exclude)**/id_rsa*",
    ":(exclude)*.p12",
    ":(exclude)**/*.p12",
    ":(exclude)*.pfx",
    ":(exclude)**/*.pfx",
    ":(exclude)secrets/**",
    ":(exclude)**/secrets/**",
];
const DEFAULT_PLAN_CRITERIA = [
    "The plan states the user-facing goal and non-goals.",
    "The plan identifies affected modules, files, or subsystems.",
    "The plan accounts for existing repo conventions and similar implementations.",
    "The plan breaks implementation into safe, reviewable steps.",
    "The plan includes a test strategy.",
    "The plan identifies data model, migration, rollout, or backwards-compatibility concerns if relevant.",
    "The plan identifies security, authorization, privacy, or reliability risks if relevant.",
    "The plan identifies open questions requiring user/product input instead of guessing.",
    "The plan is specific enough for Claude to implement without major reinterpretation.",
];
const LOOP_REVIEW_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "confidence", "summary", "criteria", "blockers", "checks", "nextInstructionForClaude"],
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
};
exports.LOOP_REVIEW_SCHEMA = LOOP_REVIEW_SCHEMA;
function main(argv) {
    const [cmd, ...rest] = argv;
    try {
        switch (cmd) {
            case undefined:
            case "help":
            case "--help":
            case "-h":
                help();
                return;
            case "init":
                init(rest);
                return;
            case "doctor":
                doctor(rest);
                return;
            case "ask":
                ask(rest);
                return;
            case "status":
                status(rest);
                return;
            case "read":
                read(rest);
                return;
            case "watch":
                watch(rest);
                return;
            case "clear":
                clear(rest);
                return;
            case "loop":
                loop(rest);
                return;
            case "hook":
                hook(rest);
                return;
            case "worker":
                worker(rest);
                return;
            default:
                die(`unknown command: ${cmd}\n\nRun ${APP} --help`);
        }
    }
    catch (err) {
        if (err instanceof ExitError)
            process.exit(err.code);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${APP}: ${msg}`);
        process.exit(1);
    }
}
class ExitError extends Error {
    code;
    constructor(code) {
        super(`exit ${code}`);
        this.code = code;
    }
}
function help() {
    console.log(`
${APP}: ask Codex for background second opinions from the same repo as Claude Code.

Usage:
  ${APP} init --install-claude
  ${APP} init --install-claude --install-loop-hook
  ${APP} doctor
  ${APP} ask [options] <question...>
  ${APP} status [-t thread]
  ${APP} read [-t thread] [--run run-id]
  ${APP} watch [-t thread] [--run run-id]
  ${APP} clear [-t thread] [--hard]
  ${APP} loop start [options] <task...>
  ${APP} loop review|status|read|stop

Ask options:
  -t, --thread <name>          Side conversation name. Default: default
      --claude                 Include recent Claude transcript excerpt when available
      --fresh                  Start a new Codex thread instead of resuming this side thread
      --wait                   Run synchronously and print the answer
      --sandbox <mode>         Codex sandbox. Default: read-only
      --approval <mode>        Codex approval mode. Default: never
      --model <model>          Codex model override
      --profile <profile>      Codex profile override
  -c, --config <key=value>     Codex -c override. Repeatable
      --context-file <path>    Extra prompt context file. Repeatable
      --max-claude-chars <n>   Max Claude transcript chars. Default: 20000
      --skip-git-check         Use cwd even if it is not a git repo

Examples:
  ${APP} ask --claude "Review Claude's migration plan skeptically."
  ${APP} ask --wait --fresh "Blindly inspect checkout for duplicate-charge risks."
  ${APP} loop start --mode implement --check "npm run check" fix the auth bug
  ${APP} loop start --mode plan --plan-file .codex-sidecar/plan.md plan notification settings
  ${APP} read
  ${APP} clear
`.trim());
}
function die(message, code = 1) {
    console.error(`${APP}: ${message}`);
    throw new ExitError(code);
}
function nowIso() {
    return new Date().toISOString();
}
function commandExists(name) {
    const result = (0, node_child_process_1.spawnSync)(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [name] : ["-v", name], {
        shell: process.platform !== "win32",
        stdio: "ignore",
    });
    return result.status === 0;
}
function runQuiet(command, args, cwd) {
    const result = (0, node_child_process_1.spawnSync)(command, args, { cwd, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function runCapture(command, args, opts) {
    const result = (0, node_child_process_1.spawnSync)(command, args, {
        cwd: opts.cwd,
        encoding: "utf8",
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error,
    };
}
function gitRoot(cwd = process.cwd()) {
    const result = runQuiet("git", ["rev-parse", "--show-toplevel"], cwd);
    if (result.status === 0 && result.stdout.trim())
        return path.resolve(result.stdout.trim());
    return undefined;
}
function repoRoot(skipGitCheck = false, cwd = process.cwd()) {
    const root = gitRoot(cwd);
    if (root)
        return root;
    if (skipGitCheck)
        return path.resolve(cwd);
    die("not inside a git repository; pass --skip-git-check to use the current directory anyway");
}
function stateDir(repo) {
    return path.join(repo, STATE_DIR);
}
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
function ensureState(repo) {
    ensureDir(path.join(stateDir(repo), "runs"));
    ensureDir(path.join(stateDir(repo), "threads"));
    addLocalGitExclude(repo);
}
function addLocalGitExclude(repo) {
    const exclude = path.join(repo, ".git", "info", "exclude");
    if (!fs.existsSync(exclude))
        return;
    const current = fs.readFileSync(exclude, "utf8");
    if (current.includes(`${STATE_DIR}/`))
        return;
    fs.appendFileSync(exclude, `\n# ${APP} local state\n${STATE_DIR}/\n`, "utf8");
}
function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return fallback;
    }
}
function writeJson(file, data) {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
}
function slug(value) {
    const cleaned = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    return cleaned || DEFAULT_THREAD;
}
function threadFile(repo, thread) {
    return path.join(stateDir(repo), "threads", `${slug(thread)}.json`);
}
function defaultThread(repo, thread) {
    return { name: slug(thread), repo, turns: [], updatedAt: nowIso() };
}
function loadThread(repo, thread) {
    const file = threadFile(repo, thread);
    const loaded = readJson(file, undefined);
    if (!loaded)
        return defaultThread(repo, thread);
    loaded.turns ??= [];
    return loaded;
}
function saveThread(repo, thread) {
    thread.updatedAt = nowIso();
    writeJson(threadFile(repo, thread.name), thread);
}
function runId(thread) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `${stamp}-${slug(thread)}-${process.pid}`;
}
function runDir(repo, id) {
    return path.join(stateDir(repo), "runs", id);
}
function latestRunFile(repo, thread) {
    return path.join(stateDir(repo), `latest-${slug(thread)}`);
}
function setLatestRun(repo, thread, id) {
    fs.writeFileSync(latestRunFile(repo, thread), `${id}\n`, "utf8");
    if (slug(thread) === DEFAULT_THREAD)
        fs.writeFileSync(path.join(stateDir(repo), "latest"), `${id}\n`, "utf8");
}
function getLatestRunId(repo, thread) {
    const threadFilePath = latestRunFile(repo, thread);
    if (fs.existsSync(threadFilePath))
        return fs.readFileSync(threadFilePath, "utf8").trim() || undefined;
    const fallback = path.join(stateDir(repo), "latest");
    if (slug(thread) === DEFAULT_THREAD && fs.existsSync(fallback))
        return fs.readFileSync(fallback, "utf8").trim() || undefined;
    const state = loadThread(repo, thread);
    return state.lastRunId;
}
function updateMeta(runPath, patch) {
    const file = path.join(runPath, "metadata.json");
    const existing = readJson(file, {});
    const next = { ...existing, ...patch, updatedAt: nowIso() };
    writeJson(file, next);
    return next;
}
function loadMeta(runPath) {
    return readJson(path.join(runPath, "metadata.json"), {});
}
function parseAskArgs(args) {
    const options = {
        thread: DEFAULT_THREAD,
        wait: false,
        includeClaude: false,
        fresh: false,
        sandbox: "read-only",
        approval: "never",
        codexConfig: [],
        contextFiles: [],
        maxClaudeChars: 20_000,
        skipGitCheck: false,
        question: "",
    };
    const questionParts = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") {
            questionParts.push(...args.slice(i + 1));
            break;
        }
        else if (arg === "-t" || arg === "--thread") {
            options.thread = needValue(args, ++i, arg);
        }
        else if (arg === "--wait") {
            options.wait = true;
        }
        else if (arg === "--claude") {
            options.includeClaude = true;
        }
        else if (arg === "--fresh") {
            options.fresh = true;
        }
        else if (arg === "--sandbox") {
            options.sandbox = needValue(args, ++i, arg);
        }
        else if (arg === "--approval") {
            options.approval = needValue(args, ++i, arg);
        }
        else if (arg === "--model") {
            options.model = needValue(args, ++i, arg);
        }
        else if (arg === "--profile") {
            options.profile = needValue(args, ++i, arg);
        }
        else if (arg === "-c" || arg === "--config") {
            options.codexConfig.push(needValue(args, ++i, arg));
        }
        else if (arg === "--context-file") {
            options.contextFiles.push(needValue(args, ++i, arg));
        }
        else if (arg === "--max-claude-chars") {
            options.maxClaudeChars = Number.parseInt(needValue(args, ++i, arg), 10);
            if (!Number.isFinite(options.maxClaudeChars))
                die("--max-claude-chars must be a number");
        }
        else if (arg === "--skip-git-check") {
            options.skipGitCheck = true;
        }
        else if (arg.startsWith("-")) {
            die(`unknown ask option: ${arg}`);
        }
        else {
            questionParts.push(arg);
        }
    }
    options.question = questionParts.join(" ").trim();
    if (!options.question && !process.stdin.isTTY)
        options.question = fs.readFileSync(0, "utf8").trim();
    if (!options.question)
        die("provide a question, or pipe one on stdin");
    return options;
}
function needValue(args, index, flag) {
    const value = args[index];
    if (!value || value.startsWith("-"))
        die(`${flag} requires a value`);
    return value;
}
function ask(args) {
    if (!commandExists("codex"))
        die("`codex` CLI not found on PATH. Install and log in to Codex first.");
    const opts = parseAskArgs(args);
    const repo = repoRoot(opts.skipGitCheck);
    ensureState(repo);
    const id = runId(opts.thread);
    const rdir = runDir(repo, id);
    ensureDir(rdir);
    const meta = {
        id,
        thread: slug(opts.thread),
        repo,
        cwd: process.cwd(),
        question: opts.question,
        status: "queued",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        promptPath: path.join(rdir, "prompt.md"),
        answerPath: path.join(rdir, "answer.md"),
        stdoutPath: path.join(rdir, "codex.ndjson"),
        stderrPath: path.join(rdir, "stderr.log"),
        workerLogPath: path.join(rdir, "worker.log"),
        sandbox: opts.sandbox,
        approval: opts.approval,
        includeClaude: opts.includeClaude,
        fresh: opts.fresh,
        wait: opts.wait,
        model: opts.model,
        profile: opts.profile,
        codexConfig: opts.codexConfig,
        contextFiles: opts.contextFiles,
        maxClaudeChars: opts.maxClaudeChars,
        skipGitCheck: opts.skipGitCheck,
    };
    fs.writeFileSync(meta.promptPath, buildPrompt(meta), "utf8");
    writeJson(path.join(rdir, "metadata.json"), meta);
    setLatestRun(repo, meta.thread, id);
    if (opts.wait) {
        const code = runWorker(rdir);
        if (fs.existsSync(meta.answerPath))
            console.log(fs.readFileSync(meta.answerPath, "utf8"));
        if (code !== 0)
            process.exit(code);
        return;
    }
    const cli = path.resolve(process.argv[1]);
    const log = fs.openSync(meta.workerLogPath, "a");
    const child = (0, node_child_process_1.spawn)(process.execPath, [cli, "worker", rdir], {
        cwd: repo,
        detached: true,
        stdio: ["ignore", log, log],
    });
    child.unref();
    fs.closeSync(log);
    updateMeta(rdir, { status: "running", workerPid: child.pid });
    console.log(`Started Codex sidecar run ${id} on thread '${meta.thread}'.`);
    console.log(`Read later with: ${APP} read -t ${meta.thread}`);
}
function buildPrompt(meta) {
    const repo = meta.repo;
    const thread = loadThread(repo, meta.thread);
    const chunks = [];
    chunks.push(`You are OpenAI Codex acting as a background second-opinion reviewer for a developer using Claude Code.

Repository root: ${repo}
Side thread: ${meta.thread}

Instructions:
- Inspect the repository as needed.
- Give a candid second opinion, not automatic agreement.
- Prefer concrete evidence from files, commands, diffs, and tests.
- Do not edit files unless the user explicitly requested write-mode work.
- Keep the final answer structured and actionable: verdict, evidence, risks, next steps.`);
    const git = gitContext(repo);
    if (git)
        chunks.push(`# Current git context\n${git}`);
    if (!meta.fresh && thread.turns.length > 0) {
        const recent = thread.turns.slice(-6).map((turn) => {
            const answer = fs.existsSync(turn.answerPath) ? truncate(readText(turn.answerPath), 4_000) : "<answer unavailable>";
            return `## Previous sidecar turn ${turn.runId}\nQuestion:\n${turn.question}\n\nAnswer:\n${answer}`;
        }).join("\n\n---\n\n");
        chunks.push(`# Prior Codex side conversation\n${recent}`);
    }
    if (meta.includeClaude) {
        const claude = claudeContext(repo, meta.maxClaudeChars);
        chunks.push(`# Optional Claude Code session context\n${claude || "No Claude transcript has been captured yet."}`);
    }
    for (const file of meta.contextFiles) {
        const abs = path.isAbsolute(file) ? file : path.resolve(meta.cwd, file);
        try {
            chunks.push(`# Extra context file: ${abs}\n${truncate(redact(readText(abs)), 20_000)}`);
        }
        catch (err) {
            chunks.push(`# Extra context file unavailable: ${abs}\n${String(err)}`);
        }
    }
    chunks.push(`# User question for Codex\n${meta.question}`);
    return `${chunks.join("\n\n")}\n`;
}
function gitContext(repo) {
    const commands = [
        ["branch/status", ["status", "--short", "--branch"]],
        ["recent commits", ["log", "--oneline", "-5", "--decorate"]],
        ["diff stat", ["diff", "--stat"]],
        ["staged diff stat", ["diff", "--cached", "--stat"]],
        ["changed files", ["diff", "--name-only"]],
        ["staged changed files", ["diff", "--cached", "--name-only"]],
    ];
    const parts = [];
    for (const [label, args] of commands) {
        const result = runQuiet("git", args, repo);
        const output = (result.stdout || result.stderr).trim();
        if (output)
            parts.push(`## ${label}\n${output}`);
    }
    return truncate(parts.join("\n\n"), 12_000);
}
function claudeContext(repo, maxChars) {
    const state = readJson(path.join(stateDir(repo), "claude-session.json"), undefined);
    if (!state?.transcriptPath)
        return "";
    if (!fs.existsSync(state.transcriptPath))
        return `Captured transcript path no longer exists: ${state.transcriptPath}`;
    const tail = tailText(state.transcriptPath, maxChars * 3);
    const lines = tail.split(/\r?\n/).filter(Boolean).slice(-60);
    const entries = lines.map((line) => {
        try {
            return flattenJson(JSON.parse(line));
        }
        catch {
            return line;
        }
    }).filter(Boolean).map((s) => truncate(redact(s), 2_000));
    const header = `Claude session id: ${state.sessionId ?? "unknown"}\nClaude transcript path: ${state.transcriptPath}`;
    return truncate(`${header}\n\n${entries.join("\n\n---\n\n")}`, maxChars);
}
function flattenJson(value) {
    if (value == null)
        return "";
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    if (Array.isArray(value))
        return value.map(flattenJson).filter(Boolean).join("\n");
    if (typeof value === "object") {
        const obj = value;
        const heads = ["role", "type", "subtype", "tool_name", "name"].filter((k) => typeof obj[k] === "string").map((k) => `${k}=${obj[k]}`);
        const bodies = ["message", "content", "text", "prompt", "tool_input", "result", "summary"].filter((k) => k in obj).map((k) => `${k}: ${flattenJson(obj[k])}`).filter(Boolean);
        if (bodies.length)
            return `${heads.join(" ")}${heads.length ? "\n" : ""}${bodies.join("\n")}`;
        return JSON.stringify(value).slice(0, 2_000);
    }
    return String(value);
}
function runWorker(rdir) {
    const meta = loadMeta(rdir);
    const thread = loadThread(meta.repo, meta.thread);
    const sessionId = !meta.fresh ? thread.sessionId : undefined;
    const cmd = codexCommand({
        repo: meta.repo,
        sandbox: meta.sandbox,
        approval: meta.approval,
        answerPath: meta.answerPath,
        model: meta.model,
        profile: meta.profile,
        skipGitCheck: meta.skipGitCheck,
        extraConfig: meta.codexConfig,
        resumeSessionId: !meta.fresh ? sessionId : undefined,
    });
    updateMeta(rdir, { status: "running", command: cmd });
    const result = runCodex(cmd, readText(meta.promptPath), meta.repo);
    fs.writeFileSync(meta.stdoutPath, result.stdout ?? "", "utf8");
    fs.writeFileSync(meta.stderrPath, result.stderr ?? "", "utf8");
    const code = result.status ?? 1;
    if (result.error)
        fs.appendFileSync(meta.stderrPath, `\n${result.error.message}\n`, "utf8");
    let answer = fs.existsSync(meta.answerPath) ? readText(meta.answerPath).trim() : "";
    if (!answer) {
        answer = `Codex did not write a final answer. Last output follows:\n\n${tailText(meta.stderrPath, 12_000) || tailText(meta.stdoutPath, 12_000)}`;
        fs.writeFileSync(meta.answerPath, answer, "utf8");
    }
    const parsedSession = parseSessionId(meta.stdoutPath);
    const status = code === 0 ? "done" : "failed";
    const nextSessionId = parsedSession ?? (isResumeFailure(meta) ? undefined : sessionId);
    const latestPath = path.join(stateDir(meta.repo), "latest.md");
    const latest = `# Codex Sidecar Answer\n\n- Run: \`${meta.id}\`\n- Thread: \`${meta.thread}\`\n- Status: \`${status}\`\n- Question: ${meta.question}\n\n---\n\n${answer.trim()}\n`;
    fs.writeFileSync(latestPath, latest, "utf8");
    const nextThread = loadThread(meta.repo, meta.thread);
    nextThread.sessionId = nextSessionId;
    nextThread.lastRunId = meta.id;
    nextThread.turns.push({ runId: meta.id, question: meta.question, answerPath: meta.answerPath, answeredAt: nowIso() });
    nextThread.turns = nextThread.turns.slice(-20);
    saveThread(meta.repo, nextThread);
    updateMeta(rdir, { status, returnCode: code, sessionId: nextSessionId, finishedAt: nowIso() });
    return code;
}
function codexCommand(inv) {
    const cmd = [
        "codex",
        "exec",
        "--cd", inv.repo,
        "--color", "never",
        "--sandbox", inv.sandbox,
        "--output-last-message", inv.answerPath,
        "--json",
    ];
    if (inv.outputSchemaPath)
        cmd.push("--output-schema", inv.outputSchemaPath);
    if (inv.model)
        cmd.push("--model", inv.model);
    if (inv.profile)
        cmd.push("--profile", inv.profile);
    if (inv.skipGitCheck)
        cmd.push("--skip-git-repo-check");
    for (const item of inv.extraConfig ?? [])
        cmd.push("-c", item);
    cmd.push("-c", `approval_policy=${JSON.stringify(inv.approval)}`);
    if (inv.resumeSessionId)
        cmd.push("resume", inv.resumeSessionId);
    cmd.push("-");
    return cmd;
}
function runCodex(args, input, cwd, timeoutMs) {
    const result = (0, node_child_process_1.spawnSync)(args[0], args.slice(1), {
        cwd,
        input,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
    });
    const error = result.error;
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timedOut: error?.code === "ETIMEDOUT",
        error,
    };
}
function worker(args) {
    const rdir = args[0];
    if (!rdir)
        die("worker requires a run directory");
    process.exit(runWorker(rdir));
}
function parseSessionId(ndjsonPath) {
    if (!fs.existsSync(ndjsonPath))
        return undefined;
    let id;
    for (const line of readText(ndjsonPath).split(/\r?\n/)) {
        if (!line.trim())
            continue;
        try {
            const event = JSON.parse(line);
            const found = event.thread_id ?? event.session_id ?? event.conversation_id;
            if (typeof found === "string" && UUID_RE.test(found))
                id = found.toLowerCase();
        }
        catch {
            // Ignore non-JSON lines; Codex JSON output should be JSONL, but logs can be noisy.
        }
    }
    return id;
}
function isResumeFailure(meta) {
    const stderr = fs.existsSync(meta.stderrPath) ? readText(meta.stderrPath) : "";
    const answer = fs.existsSync(meta.answerPath) ? readText(meta.answerPath) : "";
    return /thread\/resume failed|no rollout found for thread id/i.test(`${stderr}\n${answer}`);
}
function parseThreadAndRun(args) {
    let thread = DEFAULT_THREAD;
    let run;
    let skipGitCheck = false;
    let json = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-t" || arg === "--thread")
            thread = needValue(args, ++i, arg);
        else if (arg === "--run")
            run = needValue(args, ++i, arg);
        else if (arg === "--skip-git-check")
            skipGitCheck = true;
        else if (arg === "--json")
            json = true;
        else if (!run && !arg.startsWith("-"))
            run = arg;
        else
            die(`unknown option: ${arg}`);
    }
    return { thread: slug(thread), run, skipGitCheck, json };
}
function resolveRunPath(repo, thread, run) {
    const id = run ?? getLatestRunId(repo, thread);
    if (!id)
        die(`no run found for thread '${thread}'`);
    const rdir = runDir(repo, id);
    if (!fs.existsSync(rdir))
        die(`run not found: ${id}`);
    return rdir;
}
function refreshMeta(meta) {
    if (meta.status !== "running")
        return meta;
    const pid = meta.codexPid ?? meta.workerPid;
    if (pid && isPidAlive(pid))
        return meta;
    if (fs.existsSync(meta.answerPath))
        return updateMeta(path.dirname(meta.answerPath), { status: "done" });
    return updateMeta(path.dirname(meta.answerPath), { status: "unknown" });
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function status(args) {
    const opts = parseThreadAndRun(args);
    const repo = repoRoot(opts.skipGitCheck);
    ensureState(repo);
    const runsDir = path.join(stateDir(repo), "runs");
    const metas = fs.existsSync(runsDir)
        ? fs.readdirSync(runsDir).map((id) => path.join(runsDir, id, "metadata.json")).filter(fs.existsSync).map((f) => refreshMeta(readJson(f, {})))
        : [];
    const filtered = metas.filter((m) => !opts.thread || m.thread === opts.thread).sort((a, b) => b.id.localeCompare(a.id));
    if (opts.json) {
        console.log(JSON.stringify(filtered, null, 2));
        return;
    }
    if (!filtered.length) {
        console.log("No Codex sidecar runs yet.");
        return;
    }
    for (const meta of filtered.slice(0, 20)) {
        const q = meta.question.replace(/\s+/g, " ").slice(0, 90);
        console.log(`${meta.id}  ${meta.status.padEnd(8)}  thread=${meta.thread.padEnd(12)}  ${q}`);
    }
}
function read(args) {
    const opts = parseThreadAndRun(args);
    const repo = repoRoot(opts.skipGitCheck);
    const rdir = resolveRunPath(repo, opts.thread, opts.run);
    const meta = refreshMeta(loadMeta(rdir));
    if (!fs.existsSync(meta.answerPath)) {
        console.log(`Run ${meta.id} is ${meta.status}; no answer yet.`);
        return;
    }
    console.log(readText(meta.answerPath));
}
function watch(args) {
    const opts = parseThreadAndRun(args);
    const repo = repoRoot(opts.skipGitCheck);
    const rdir = resolveRunPath(repo, opts.thread, opts.run);
    for (;;) {
        const meta = refreshMeta(loadMeta(rdir));
        if (!["queued", "running"].includes(meta.status)) {
            if (fs.existsSync(meta.answerPath))
                console.log(readText(meta.answerPath));
            else
                console.log(`Run ${meta.id} ended with status ${meta.status}.`);
            return;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
}
function clear(args) {
    let thread = DEFAULT_THREAD;
    let hard = false;
    let skipGitCheck = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-t" || arg === "--thread")
            thread = needValue(args, ++i, arg);
        else if (arg === "--hard")
            hard = true;
        else if (arg === "--skip-git-check")
            skipGitCheck = true;
        else
            die(`unknown clear option: ${arg}`);
    }
    const repo = repoRoot(skipGitCheck);
    ensureState(repo);
    fs.rmSync(threadFile(repo, thread), { force: true });
    fs.rmSync(latestRunFile(repo, thread), { force: true });
    if (hard) {
        fs.rmSync(path.join(stateDir(repo), "runs"), { recursive: true, force: true });
        ensureDir(path.join(stateDir(repo), "runs"));
        fs.rmSync(path.join(stateDir(repo), "latest.md"), { force: true });
    }
    console.log(`Cleared Codex sidecar thread '${slug(thread)}'${hard ? " and run artifacts" : ""}.`);
}
function loop(args) {
    const [sub, ...rest] = args;
    switch (sub) {
        case "start":
            loopStart(rest);
            return;
        case "status":
            loopStatus(rest);
            return;
        case "read":
            loopRead(rest);
            return;
        case "stop":
            loopStop(rest);
            return;
        case "review":
            loopReview(rest);
            return;
        case "hook":
            loopHook(rest);
            return;
        case undefined:
        case "help":
        case "--help":
        case "-h":
            loopHelp();
            return;
        default:
            die(`unknown loop command: ${sub}\n\nRun ${APP} loop --help`);
    }
}
function loopHelp() {
    console.log(`
${APP} loop: opt-in Codex review gate for Claude Code.

Usage:
  ${APP} loop start [options] <task...>
  ${APP} loop review
  ${APP} loop status [--json]
  ${APP} loop read
  ${APP} loop stop

Start options:
      --mode plan|implement       Default: implement
      --max-rounds <n>            Default: 3, clamped to 1..7
      --criteria <text>           Repeatable success criterion
      --check <cmd>               Repeatable trusted local check command
      --test <cmd>                Alias for --check
      --plan-file <path>          Default: ${DEFAULT_PLAN_FILE}
      --require-plan-file         Block if the plan file is absent
      --blind                     Omit recent Claude transcript context
      --max-claude-chars <n>      Default: 20000
      --sandbox <mode>            Default: read-only
      --approval <mode>           Default: never
      --model <model>             Codex model override
      --profile <profile>         Codex profile override
      --review-timeout <sec>      Default: 600
      --check-timeout <sec>       Default: 300
      --fail-closed               Block on Codex/check infrastructure errors
      --session any|current       Default: current when captured, otherwise any
      --skip-git-check            Use cwd even outside a git repo
`.trim());
}
function parseLoopStartArgs(args) {
    const options = {
        mode: "implement",
        maxRounds: 3,
        criteria: [],
        checks: [],
        planFile: DEFAULT_PLAN_FILE,
        requirePlanFile: false,
        blind: false,
        maxClaudeChars: 20_000,
        sandbox: "read-only",
        approval: "never",
        failClosed: false,
        reviewTimeoutSec: 600,
        checkTimeoutSec: 300,
        session: "current",
        skipGitCheck: false,
        task: "",
    };
    const taskParts = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") {
            taskParts.push(...args.slice(i + 1));
            break;
        }
        else if (arg === "--mode") {
            options.mode = parseLoopMode(needValue(args, ++i, arg));
        }
        else if (arg === "--max-rounds") {
            options.maxRounds = clamp(parseInteger(needValue(args, ++i, arg), arg), 1, 7);
        }
        else if (arg === "--criteria") {
            options.criteria.push(needValue(args, ++i, arg));
        }
        else if (arg === "--check" || arg === "--test") {
            options.checks.push(needValue(args, ++i, arg));
        }
        else if (arg === "--plan-file") {
            options.planFile = needValue(args, ++i, arg);
        }
        else if (arg === "--require-plan-file") {
            options.requirePlanFile = true;
        }
        else if (arg === "--blind") {
            options.blind = true;
        }
        else if (arg === "--max-claude-chars") {
            options.maxClaudeChars = parsePositiveInt(needValue(args, ++i, arg), arg);
        }
        else if (arg === "--sandbox") {
            options.sandbox = parseSandboxMode(needValue(args, ++i, arg));
        }
        else if (arg === "--approval") {
            options.approval = parseApprovalMode(needValue(args, ++i, arg));
        }
        else if (arg === "--model") {
            options.model = needValue(args, ++i, arg);
        }
        else if (arg === "--profile") {
            options.profile = needValue(args, ++i, arg);
        }
        else if (arg === "--review-timeout") {
            options.reviewTimeoutSec = parsePositiveInt(needValue(args, ++i, arg), arg);
        }
        else if (arg === "--check-timeout") {
            options.checkTimeoutSec = parsePositiveInt(needValue(args, ++i, arg), arg);
        }
        else if (arg === "--fail-closed") {
            options.failClosed = true;
        }
        else if (arg === "--session") {
            options.session = parseSessionMode(needValue(args, ++i, arg));
        }
        else if (arg === "--skip-git-check") {
            options.skipGitCheck = true;
        }
        else if (arg.startsWith("-")) {
            die(`unknown loop start option: ${arg}`);
        }
        else {
            taskParts.push(arg);
        }
    }
    options.task = taskParts.join(" ").trim();
    if (!options.task && !process.stdin.isTTY)
        options.task = fs.readFileSync(0, "utf8").trim();
    if (!options.task)
        die("provide a loop task, or pipe one on stdin");
    if (options.mode === "plan" && options.criteria.length === 0)
        options.criteria = [...DEFAULT_PLAN_CRITERIA];
    const worstCaseSec = options.checks.length * options.checkTimeoutSec + options.reviewTimeoutSec + 10;
    if (worstCaseSec >= LOOP_HOOK_TIMEOUT_SEC) {
        die(`loop timeouts exceed the installed Stop hook safety timeout (${worstCaseSec}s >= ${LOOP_HOOK_TIMEOUT_SEC}s); reduce checks or timeouts`);
    }
    return options;
}
function parseLoopMode(value) {
    if (value === "plan" || value === "implement")
        return value;
    die("--mode must be plan or implement");
}
function parseSandboxMode(value) {
    if (value === "read-only" || value === "workspace-write" || value === "danger-full-access")
        return value;
    die("--sandbox must be read-only, workspace-write, or danger-full-access");
}
function parseApprovalMode(value) {
    if (value === "never" || value === "on-request" || value === "untrusted")
        return value;
    die("--approval must be never, on-request, or untrusted");
}
function parseSessionMode(value) {
    if (value === "any" || value === "current")
        return value;
    die("--session must be any or current");
}
function parsePositiveInt(value, flag) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0)
        die(`${flag} must be a positive number`);
    return parsed;
}
function parseInteger(value, flag) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed))
        die(`${flag} must be a number`);
    return parsed;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function loopStart(args) {
    if (!commandExists("codex"))
        die("`codex` CLI not found on PATH. Install and log in to Codex first.");
    const opts = parseLoopStartArgs(args);
    const repo = repoRoot(opts.skipGitCheck);
    ensureState(repo);
    ensureLoopDirs(repo);
    const claude = readJson(path.join(stateDir(repo), "claude-session.json"), undefined);
    const sessionId = opts.session === "current" ? claude?.sessionId : undefined;
    if (opts.session === "current" && !sessionId) {
        console.error(`${APP}: no Claude session has been captured yet; this loop will apply to any session`);
    }
    const loopState = {
        version: 1,
        status: "active",
        mode: opts.mode,
        task: opts.task,
        criteria: opts.criteria,
        maxRounds: opts.maxRounds,
        round: 0,
        checks: opts.checks,
        planFile: opts.planFile,
        requirePlanFile: opts.requirePlanFile,
        blind: opts.blind,
        includeClaudeContext: !opts.blind,
        maxClaudeChars: opts.maxClaudeChars,
        sandbox: opts.sandbox,
        approval: opts.approval,
        model: opts.model,
        profile: opts.profile,
        failClosed: opts.failClosed,
        reviewTimeoutSec: opts.reviewTimeoutSec,
        checkTimeoutSec: opts.checkTimeoutSec,
        skipGitCheck: opts.skipGitCheck,
        sessionId,
        armedAt: nowIso(),
        updatedAt: nowIso(),
        stuckRounds: 0,
    };
    fs.rmSync(path.join(loopDir(repo), "latest-review.md"), { force: true });
    fs.rmSync(path.join(loopDir(repo), "latest-review.json"), { force: true });
    saveLoop(repo, loopState);
    console.log(`Started Codex loop in ${opts.mode} mode for this repo.`);
    console.log(`Rounds: 0/${opts.maxRounds}`);
    if (opts.mode === "plan")
        console.log(`Plan file: ${opts.planFile}`);
    if (opts.checks.length)
        console.log(`Checks: ${opts.checks.length}`);
    console.log(`Manual review: ${APP} loop review`);
}
function loopStatus(args) {
    const opts = parseLoopMetaArgs(args);
    const repo = repoRoot(opts.skipGitCheck);
    const active = loadLoop(repo);
    if (opts.json) {
        console.log(JSON.stringify(active ?? null, null, 2));
        return;
    }
    if (!active) {
        console.log("No Codex loop state found.");
        return;
    }
    console.log(`Status: ${active.status}`);
    console.log(`Mode: ${active.mode}`);
    console.log(`Rounds: ${active.round}/${active.maxRounds}`);
    console.log(`Task: ${active.task}`);
    if (active.lastVerdict)
        console.log(`Last verdict: ${active.lastVerdict}`);
    if (active.lastReviewPath)
        console.log(`Last review: ${active.lastReviewPath}`);
    if (active.checks.length)
        console.log(`Checks: ${active.checks.join(" && ")}`);
}
function loopRead(args) {
    const opts = parseLoopMetaArgs(args);
    const repo = repoRoot(opts.skipGitCheck);
    const latest = path.join(loopDir(repo), "latest-review.md");
    const active = loadLoop(repo);
    const reviewPath = active ? active.lastReviewPath : (fs.existsSync(latest) ? latest : undefined);
    if (!reviewPath || !fs.existsSync(reviewPath)) {
        console.log("No Codex loop review has been written yet.");
        return;
    }
    console.log(readText(reviewPath));
}
function loopStop(args) {
    const opts = parseLoopMetaArgs(args);
    const repo = repoRoot(opts.skipGitCheck);
    const active = loadLoop(repo);
    if (!active) {
        console.log("No Codex loop state found.");
        return;
    }
    saveLoop(repo, { ...active, status: "inactive" });
    console.log("Codex loop deactivated. Review artifacts were preserved.");
}
function loopReview(args) {
    const opts = parseLoopMetaArgs(args);
    const repo = repoRoot(opts.skipGitCheck);
    ensureState(repo);
    const claude = readJson(path.join(stateDir(repo), "claude-session.json"), undefined);
    const decision = evaluateLoop(repo, {
        cwd: repo,
        transcript_path: claude?.transcriptPath,
        hook_event_name: "ManualReview",
    });
    if (decision.error || decision.verdict === "ERROR") {
        if (decision.reason)
            console.error(decision.reason);
        else {
            const after = loadLoop(repo);
            if (after?.lastError)
                console.error(after.lastError);
        }
        process.exit(2);
    }
    if (decision.decision === "block") {
        console.log(decision.reason ?? "Codex loop blocked.");
        process.exit(1);
    }
    const after = loadLoop(repo);
    if (decision.error || after?.status === "error" || after?.lastVerdict === "ERROR") {
        if (after?.lastError)
            console.error(after.lastError);
        process.exit(2);
    }
    console.log("Codex loop allows stop.");
}
function parseLoopMetaArgs(args) {
    let skipGitCheck = false;
    let json = false;
    for (const arg of args) {
        if (arg === "--skip-git-check")
            skipGitCheck = true;
        else if (arg === "--json")
            json = true;
        else
            die(`unknown loop option: ${arg}`);
    }
    return { skipGitCheck, json };
}
function loopHook(args) {
    const [kind, ...rest] = args;
    if (kind !== "stop" || rest.length)
        die("usage: codex-sidecar loop hook stop");
    const raw = !process.stdin.isTTY ? fs.readFileSync(0, "utf8") : "";
    let input;
    try {
        input = raw.trim() ? JSON.parse(raw) : {};
    }
    catch (err) {
        logLoopHookError(process.cwd(), `invalid hook JSON: ${String(err)}\n${raw}`);
        return;
    }
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    const repo = gitRoot(cwd) ?? path.resolve(cwd);
    try {
        ensureState(repo);
        const decision = evaluateLoop(repo, input);
        if (decision.decision === "block") {
            process.stdout.write(JSON.stringify({ decision: "block", reason: truncate(decision.reason ?? "Codex loop blocked.", 9_800) }));
        }
    }
    catch (err) {
        logLoopHookError(repo, err instanceof Error ? err.stack ?? err.message : String(err));
    }
}
function loopFile(repo) {
    return path.join(stateDir(repo), "loop.json");
}
function loopDir(repo) {
    return path.join(stateDir(repo), LOOP_REVIEW_DIR);
}
function ensureLoopDirs(repo) {
    ensureDir(path.join(loopDir(repo), "reviews"));
}
function loadLoop(repo) {
    const loaded = readJson(loopFile(repo), undefined);
    if (!loaded || loaded.version !== 1)
        return undefined;
    loaded.criteria ??= [];
    loaded.checks ??= [];
    loaded.stuckRounds ??= 0;
    loaded.includeClaudeContext = loaded.includeClaudeContext ?? !loaded.blind;
    loaded.skipGitCheck ??= false;
    return loaded;
}
function saveLoop(repo, loopState) {
    ensureLoopDirs(repo);
    writeJson(loopFile(repo), { ...loopState, updatedAt: nowIso() });
}
function evaluateLoop(repo, input) {
    const active = loadLoop(repo);
    if (!active || active.status === "inactive" || active.status === "passed")
        return allowDecision();
    if (active.status === "awaiting_human")
        return allowDecision();
    if (active.status === "stuck")
        return active.failClosed ? blockDecision(formatStuckReason(active), "REVISE") : allowDecision("REVISE");
    if (active.status === "error") {
        const reviewPath = active.lastReviewPath ?? path.join(loopDir(repo), "latest-review.md");
        const reason = formatErrorReason(errorReview(active.lastError ?? "Codex loop is in an error state."), reviewPath);
        return active.failClosed ? { ...blockDecision(reason, "ERROR"), error: true } : { ...allowDecision("ERROR"), error: true };
    }
    if (active.sessionId && input.session_id && active.sessionId !== input.session_id)
        return allowDecision();
    if (sessionPausedForLaterWork(input))
        return allowDecision();
    if (active.round >= active.maxRounds) {
        const next = { ...active, status: "exhausted" };
        saveLoop(repo, next);
        const reason = formatExhaustedReason(next);
        return active.failClosed ? blockDecision(reason, "REVISE") : allowDecision("REVISE");
    }
    // Missing plan files do not advance the round counter; Claude can create the artifact and retry.
    if (active.mode === "plan" && active.requirePlanFile) {
        const planPath = resolvePlanFile(repo, active);
        if (!fs.existsSync(planPath)) {
            const reason = `The active Codex plan loop needs a plan file at ${active.planFile ?? DEFAULT_PLAN_FILE}. Create or update it before finishing.`;
            saveLoop(repo, { ...active, lastVerdict: "REVISE", lastBlockReason: reason });
            return blockDecision(reason, "REVISE");
        }
    }
    const deadline = new Deadline(active);
    const checkResults = runChecks(repo, active.checks, active.checkTimeoutSec, deadline);
    const failed = checkResults.filter((result) => result.exitCode !== 0 || result.timedOut);
    if (failed.length > 0) {
        const artifactHash = computeArtifactHash(repo, active, checkResults);
        return applyCheckFailure(repo, active, checkResults, failed, artifactHash);
    }
    const artifactHash = computeArtifactHash(repo, active, checkResults);
    if (active.lastArtifactHash === artifactHash && active.lastVerdict === "REVISE") {
        return applyNoProgress(repo, active);
    }
    const review = runCodexLoopReview(repo, active, input, checkResults, deadline);
    return applyReview(repo, active, review, artifactHash);
}
function allowDecision(verdict) {
    return { decision: "allow", verdict };
}
function blockDecision(reason, verdict) {
    return { decision: "block", reason, verdict };
}
class Deadline {
    expiresAt;
    constructor(loopState) {
        const totalMs = (loopState.checks.length * loopState.checkTimeoutSec + loopState.reviewTimeoutSec + 10) * 1000;
        this.expiresAt = Date.now() + Math.min(totalMs, (LOOP_HOOK_TIMEOUT_SEC - 5) * 1000);
    }
    remainingMs(maxMs) {
        const remaining = this.expiresAt - Date.now();
        if (remaining <= 0)
            return 0;
        return Math.max(1, Math.min(maxMs, remaining));
    }
}
exports.Deadline = Deadline;
function runChecks(repo, checks, timeoutSec, deadline) {
    const results = [];
    for (const command of checks) {
        const timeoutMs = deadline.remainingMs(timeoutSec * 1000);
        const started = Date.now();
        if (timeoutMs <= 0) {
            results.push({
                command,
                exitCode: 124,
                durationMs: 0,
                stdoutTail: "",
                stderrTail: "Loop time budget exhausted before this check could run.",
                timedOut: true,
            });
            continue;
        }
        const result = (0, node_child_process_1.spawnSync)(command, {
            cwd: repo,
            shell: true,
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer: 8 * 1024 * 1024,
        });
        const error = result.error;
        const timedOut = error?.code === "ETIMEDOUT";
        results.push({
            command,
            exitCode: result.status ?? (timedOut ? 124 : 1),
            durationMs: Date.now() - started,
            stdoutTail: tailString(result.stdout ?? "", 8_000),
            stderrTail: tailString(`${result.stderr ?? ""}${error && !timedOut ? `\n${error.message}` : ""}`, 8_000),
            timedOut,
        });
    }
    return results;
}
function applyCheckFailure(repo, loopState, checkResults, failed, artifactHash) {
    const nextRound = loopState.round + 1;
    const review = {
        verdict: "REVISE",
        confidence: "high",
        summary: "One or more configured verification commands failed before Codex review.",
        criteria: loopState.criteria.map((criterion) => ({ criterion, status: "unclear", evidence: "Codex review did not run because checks failed." })),
        blockers: failed.map((result) => ({
            severity: "blocking",
            title: `Check failed: ${result.command}`,
            evidence: checkEvidence(result),
            instructionForClaude: "Fix the failing verification command, rerun it, and try to finish again.",
        })),
        checks: checkResults.map((result) => ({
            command: result.command,
            status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
            evidence: checkEvidence(result),
        })),
        nextInstructionForClaude: "Fix the failing verification command, rerun it, and then try to finish again.",
    };
    const saved = saveReviewArtifacts(repo, loopState, {
        reviewId: loopReviewId("check"),
        prompt: "",
        review,
        stdout: "",
        stderr: "",
        checks: checkResults,
        meta: { kind: "check-failure" },
    });
    const reason = formatCheckFailureReason(failed[0], saved.reviewPath);
    const common = {
        ...loopState,
        round: nextRound,
        lastVerdict: "REVISE",
        lastReviewId: saved.reviewId,
        lastReviewPath: saved.reviewPath,
        lastBlockReason: reason,
        lastArtifactHash: artifactHash,
        lastBlockerFingerprint: hashText(failed.map((result) => `${result.command}:${result.exitCode}:${result.timedOut}`).join("\n")),
    };
    if (nextRound >= loopState.maxRounds) {
        const exhausted = { ...common, status: "exhausted" };
        saveLoop(repo, exhausted);
        return loopState.failClosed ? blockDecision(formatMaxRoundsReason(loopState, review, saved.reviewPath), "REVISE") : allowDecision("REVISE");
    }
    saveLoop(repo, { ...common, status: "active" });
    return blockDecision(reason, "REVISE");
}
function applyNoProgress(repo, loopState) {
    const stuckRounds = loopState.stuckRounds + 1;
    if (stuckRounds >= 2) {
        const next = { ...loopState, status: "stuck", stuckRounds };
        saveLoop(repo, next);
        const reason = formatStuckReason(next);
        return loopState.failClosed ? blockDecision(reason, "REVISE") : allowDecision("REVISE");
    }
    saveLoop(repo, { ...loopState, stuckRounds });
    return blockDecision(loopState.lastBlockReason ?? "No meaningful change since the previous Codex loop feedback.", "REVISE");
}
function applyReview(repo, loopState, result, artifactHash) {
    const review = result.review;
    const nextRound = loopState.round + 1;
    const majorBlockers = review.blockers.filter((blocker) => blocker.severity !== "minor");
    const blockerFingerprint = blockerFingerprintFor(review.blockers);
    if (review.verdict === "PASS" && majorBlockers.length === 0) {
        saveLoop(repo, {
            ...loopState,
            status: "passed",
            round: nextRound,
            lastVerdict: "PASS",
            lastReviewId: result.reviewId,
            lastReviewPath: result.reviewPath,
            lastArtifactHash: artifactHash,
            stuckRounds: 0,
        });
        return allowDecision("PASS");
    }
    if (review.verdict === "HUMAN") {
        const reason = formatHumanReason(review);
        saveLoop(repo, {
            ...loopState,
            status: "awaiting_human",
            lastVerdict: "HUMAN",
            lastReviewId: result.reviewId,
            lastReviewPath: result.reviewPath,
            lastBlockReason: reason,
            lastArtifactHash: artifactHash,
            stuckRounds: 0,
        });
        return blockDecision(reason, "HUMAN");
    }
    if (review.verdict === "ERROR") {
        saveLoop(repo, {
            ...loopState,
            status: "error",
            round: nextRound,
            lastVerdict: "ERROR",
            lastReviewId: result.reviewId,
            lastReviewPath: result.reviewPath,
            lastError: review.summary,
            lastArtifactHash: artifactHash,
        });
        const reason = formatErrorReason(review, result.reviewPath);
        return loopState.failClosed ? blockDecision(reason, "ERROR") : { ...allowDecision("ERROR"), error: true };
    }
    if (nextRound >= loopState.maxRounds) {
        const reason = formatMaxRoundsReason(loopState, review, result.reviewPath);
        saveLoop(repo, {
            ...loopState,
            status: "exhausted",
            round: nextRound,
            lastVerdict: "REVISE",
            lastReviewId: result.reviewId,
            lastReviewPath: result.reviewPath,
            lastBlockReason: reason,
            lastArtifactHash: artifactHash,
            lastBlockerFingerprint: blockerFingerprint,
        });
        return loopState.failClosed ? blockDecision(reason, "REVISE") : allowDecision("REVISE");
    }
    const stuckRounds = loopState.lastBlockerFingerprint === blockerFingerprint ? loopState.stuckRounds + 1 : 0;
    if (stuckRounds >= 2) {
        const next = {
            ...loopState,
            status: "stuck",
            round: nextRound,
            lastVerdict: "REVISE",
            lastReviewId: result.reviewId,
            lastReviewPath: result.reviewPath,
            lastArtifactHash: artifactHash,
            lastBlockerFingerprint: blockerFingerprint,
            stuckRounds,
        };
        saveLoop(repo, next);
        const reason = formatStuckReason(next);
        return loopState.failClosed ? blockDecision(reason, "REVISE") : allowDecision("REVISE");
    }
    const reason = loopState.mode === "plan"
        ? formatPlanReviseReason(loopState, review, nextRound, result.reviewPath)
        : formatImplementReviseReason(loopState, review, nextRound, result.reviewPath);
    saveLoop(repo, {
        ...loopState,
        status: "active",
        round: nextRound,
        lastVerdict: "REVISE",
        lastReviewId: result.reviewId,
        lastReviewPath: result.reviewPath,
        lastBlockReason: reason,
        lastArtifactHash: artifactHash,
        lastBlockerFingerprint: blockerFingerprint,
        stuckRounds,
    });
    return blockDecision(reason, "REVISE");
}
function runCodexLoopReview(repo, loopState, input, checkResults, deadline) {
    const reviewId = loopReviewId("review");
    const prompt = buildLoopPrompt(repo, loopState, input, checkResults);
    const reviewDir = loopReviewDir(repo, reviewId);
    ensureDir(reviewDir);
    const schemaPath = path.join(reviewDir, "schema.json");
    const reviewJsonPath = path.join(reviewDir, "review.json");
    writeJson(schemaPath, LOOP_REVIEW_SCHEMA);
    fs.writeFileSync(path.join(reviewDir, "prompt.md"), prompt, "utf8");
    let stdout = "";
    let stderr = "";
    let review;
    let meta = { mode: loopState.mode };
    const timeoutMs = deadline.remainingMs(loopState.reviewTimeoutSec * 1000);
    if (timeoutMs <= 0) {
        review = errorReview("Loop review time budget was exhausted before Codex could run.");
        meta = { mode: loopState.mode, timedOut: true, timeoutMs: 0 };
    }
    else {
        const command = codexCommand({
            repo,
            sandbox: loopState.sandbox,
            approval: loopState.approval,
            answerPath: reviewJsonPath,
            model: loopState.model,
            profile: loopState.profile,
            skipGitCheck: loopState.skipGitCheck,
            outputSchemaPath: schemaPath,
        });
        const result = runCodex(command, prompt, repo, timeoutMs);
        stdout = result.stdout;
        stderr = `${result.stderr}${result.error ? `\n${result.error.message}` : ""}`;
        const reviewText = fs.existsSync(reviewJsonPath) ? readText(reviewJsonPath) : "";
        const parsed = parseLoopReviewText(reviewText) ?? parseLoopReviewText(stdout) ?? parseLoopReviewText(stderr);
        if (result.timedOut) {
            review = errorReview("Codex loop review timed out.");
        }
        else if (result.status !== 0 && !parsed) {
            review = errorReview(`Codex loop review failed with exit code ${result.status ?? "unknown"}.`);
        }
        else if (!parsed) {
            review = errorReview("Codex did not return valid loop review JSON.");
        }
        else if (result.status !== 0 && parsed.verdict !== "ERROR") {
            review = errorReview(`Codex loop review exited with code ${result.status ?? "unknown"} after writing a non-error review.`);
        }
        else {
            review = parsed;
        }
        meta = { mode: loopState.mode, command, timeoutMs, status: result.status, timedOut: result.timedOut };
    }
    return saveReviewArtifacts(repo, loopState, {
        reviewId,
        prompt,
        review,
        stdout,
        stderr,
        checks: checkResults,
        meta,
    });
}
function saveReviewArtifacts(repo, loopState, data) {
    const dir = loopReviewDir(repo, data.reviewId);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, "prompt.md"), data.prompt, "utf8");
    writeJson(path.join(dir, "schema.json"), LOOP_REVIEW_SCHEMA);
    writeJson(path.join(dir, "review.json"), data.review);
    fs.writeFileSync(path.join(dir, "review.md"), formatReviewMarkdown(loopState, data.review, data.checks), "utf8");
    fs.writeFileSync(path.join(dir, "codex.ndjson"), data.stdout, "utf8");
    fs.writeFileSync(path.join(dir, "stderr.txt"), data.stderr, "utf8");
    writeJson(path.join(dir, "checks.json"), data.checks);
    writeJson(path.join(dir, "meta.json"), { ...data.meta, reviewId: data.reviewId, createdAt: nowIso() });
    fs.copyFileSync(path.join(dir, "review.md"), path.join(loopDir(repo), "latest-review.md"));
    fs.copyFileSync(path.join(dir, "review.json"), path.join(loopDir(repo), "latest-review.json"));
    return { review: data.review, reviewId: data.reviewId, reviewPath: path.join(dir, "review.md") };
}
function loopReviewId(prefix) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `${stamp}-${prefix}-${process.pid}`;
}
function loopReviewDir(repo, reviewId) {
    return path.join(loopDir(repo), "reviews", reviewId);
}
function buildLoopPrompt(repo, loopState, input, checkResults) {
    const lastAssistant = resolveLastAssistantMessage(input) || "No assistant message captured.";
    const claude = loopState.includeClaudeContext
        ? claudeContext(repo, loopState.maxClaudeChars) || "No Claude transcript has been captured yet."
        : "Omitted by --blind.";
    const prior = priorLoopReviewSummaries(repo);
    if (loopState.mode === "plan") {
        const planPath = resolvePlanFile(repo, loopState);
        const planText = fs.existsSync(planPath) ? truncate(redact(readText(planPath)), 40_000) : "<plan file missing>";
        return `You are Codex acting as a strict but practical plan review gate for a Claude Code session.

Claude is planning a feature or fix but should not implement code yet.
Your job is to decide whether Claude's plan is good enough to begin implementation.
Return JSON matching the provided schema only.

Repository root:
${repo}

Planning goal:
${loopState.task}

Explicit success criteria:
${formatCriteriaList(loopState.criteria)}

Plan artifact path:
${loopState.planFile ?? DEFAULT_PLAN_FILE}

Plan artifact contents:
${planText}

Claude's latest assistant message:
${lastAssistant}

Current repo context:
${gitContextForLoop(repo) || "No git context available."}

Optional recent Claude transcript excerpt:
${claude}

Prior loop review summaries:
${prior || "No prior loop reviews."}

Decision rules:
- PASS only if the plan is specific, feasible, scoped, and safe enough to implement.
- PASS means planning is ready; it does not mean implementation is complete.
- REVISE if the plan is missing important repo context, implementation steps, tests, rollout/migration concerns, or risk analysis.
- HUMAN if the plan depends on a product/UX/security decision Claude should not guess.
- ERROR only if you cannot review due to missing context or tool failure.
- Do not require implementation work in plan mode.
- Do not nitpick prose style.
- Prefer concrete evidence from the repo: file paths, existing modules, similar patterns, tests, config, migrations.
- Keep nextInstructionForClaude directly actionable.
`;
    }
    return `You are Codex acting as a strict but practical implementation review gate for a Claude Code session.

Claude is the implementer. You are the read-only reviewer.
Your job is to decide whether Claude should be allowed to stop.
Return JSON matching the provided schema only.

Repository root:
${repo}

Task:
${loopState.task}

Explicit success criteria:
${formatCriteriaList(loopState.criteria)}

Configured check results:
${formatCheckResults(checkResults)}

Current git status:
${gitContextForLoop(repo) || "No git context available."}

Full working-tree diff, truncated and redacted:
${gitDiffFull(repo)}

Claude's latest assistant message:
${lastAssistant}

Optional recent Claude transcript excerpt:
${claude}

Prior loop review summaries:
${prior || "No prior loop reviews."}

Decision rules:
- PASS only if the task appears implemented, configured checks passed, criteria are met or not applicable with evidence, and there are no blocking or major unresolved issues.
- REVISE if Claude should continue making code/test/doc changes.
- HUMAN if the next step requires a user/product decision Claude should not guess.
- ERROR only if you cannot review due to missing context or tool failure.
- Focus on correctness, regressions, missing tests, broken types/builds, security/authorization, data migration, and incompleteness.
- Do not nitpick formatting unless it affects correctness or maintainability.
- Do not ask Claude to make broad unrelated changes.
- Prefer concrete evidence: file paths, functions, tests, commands, diffs.
- Keep nextInstructionForClaude directly actionable.
`;
}
function resolvePlanFile(repo, loopState) {
    const configured = loopState.planFile ?? DEFAULT_PLAN_FILE;
    return path.isAbsolute(configured) ? configured : path.resolve(repo, configured);
}
function formatCriteriaList(criteria) {
    if (criteria.length === 0)
        return "No explicit criteria were configured.";
    return criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
}
function formatCheckResults(results) {
    if (results.length === 0)
        return "No checks were configured.";
    return results.map((result) => {
        const status = result.exitCode === 0 && !result.timedOut ? "passed" : "failed";
        return `## ${result.command}
Status: ${status}
Exit code: ${result.exitCode}
Timed out: ${result.timedOut ? "yes" : "no"}
Duration ms: ${result.durationMs}
Output tail:
${checkEvidence(result)}`;
    }).join("\n\n");
}
function priorLoopReviewSummaries(repo) {
    const reviewsDir = path.join(loopDir(repo), "reviews");
    if (!fs.existsSync(reviewsDir))
        return "";
    const summaries = fs.readdirSync(reviewsDir)
        .sort()
        .slice(-3)
        .map((id) => {
        const review = readJson(path.join(reviewsDir, id, "review.json"), undefined);
        if (!review)
            return "";
        return `## ${id}
Verdict: ${review.verdict}
Summary: ${review.summary}
Next: ${review.nextInstructionForClaude}`;
    })
        .filter(Boolean);
    return truncate(summaries.join("\n\n"), 8_000);
}
function gitContextForLoop(repo) {
    const commands = [
        ["branch/status", ["status", "--short", "--branch", "--", ".", ...SECRET_PATHSPECS]],
        ["recent commits", ["log", "--oneline", "-5", "--decorate"]],
        ["diff stat", ["diff", "--stat", "--", ".", ...SECRET_PATHSPECS]],
        ["staged diff stat", ["diff", "--cached", "--stat", "--", ".", ...SECRET_PATHSPECS]],
        ["changed files", ["diff", "--name-only", "--", ".", ...SECRET_PATHSPECS]],
        ["staged changed files", ["diff", "--cached", "--name-only", "--", ".", ...SECRET_PATHSPECS]],
    ];
    const parts = [];
    for (const [label, args] of commands) {
        const result = runCapture("git", args, { cwd: repo });
        const output = filterSecretPathLines((result.stdout || result.stderr).trim());
        if (output)
            parts.push(`## ${label}\n${output}`);
    }
    return truncate(redact(parts.join("\n\n")), 12_000);
}
function gitDiffFull(repo) {
    return truncate(redact(captureDiffText(repo)), 60_000);
}
function captureDiffText(repo) {
    const unstaged = runCapture("git", ["diff", "--", ".", ...SECRET_PATHSPECS], { cwd: repo, maxBuffer: 16_000_000 });
    const staged = runCapture("git", ["diff", "--cached", "--", ".", ...SECRET_PATHSPECS], { cwd: repo, maxBuffer: 16_000_000 });
    const untracked = gitUntrackedText(repo);
    if (unstaged.error || staged.error || unstaged.status !== 0 || staged.status !== 0) {
        const unstagedStat = runCapture("git", ["diff", "--stat", "--", ".", ...SECRET_PATHSPECS], { cwd: repo });
        const unstagedNames = runCapture("git", ["diff", "--name-status", "--", ".", ...SECRET_PATHSPECS], { cwd: repo });
        const stagedStat = runCapture("git", ["diff", "--cached", "--stat", "--", ".", ...SECRET_PATHSPECS], { cwd: repo });
        const stagedNames = runCapture("git", ["diff", "--cached", "--name-status", "--", ".", ...SECRET_PATHSPECS], { cwd: repo });
        return [
            "# Full diff unavailable (too large or git error); summary only.",
            "# Unstaged diff --stat",
            filterSecretPathLines(unstagedStat.stdout),
            "# Unstaged diff --name-status",
            filterSecretPathLines(unstagedNames.stdout),
            "# Staged diff --stat",
            filterSecretPathLines(stagedStat.stdout),
            "# Staged diff --name-status",
            filterSecretPathLines(stagedNames.stdout),
            untracked,
        ].join("\n\n");
    }
    return [
        "# Unstaged diff",
        filterSecretDiffSections(unstaged.stdout),
        "# Staged diff",
        filterSecretDiffSections(staged.stdout),
        untracked,
    ].join("\n\n");
}
function gitUntrackedText(repo) {
    const list = runCapture("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...SECRET_PATHSPECS], { cwd: repo });
    if (list.error || list.status !== 0)
        return "# Untracked files: capture failed.";
    const files = list.stdout.split("\0").filter(Boolean).filter((rel) => !isSecretLikePath(rel));
    if (files.length === 0)
        return "# Untracked files: none.";
    const maxFileBytes = 256 * 1024;
    const parts = ["# Untracked (new) files"];
    for (const rel of files.slice(0, 100)) {
        try {
            const abs = path.join(repo, rel);
            const stat = fs.lstatSync(abs);
            if (stat.isSymbolicLink()) {
                parts.push(`## ${rel}\n<skipped: symlink>`);
                continue;
            }
            if (!stat.isFile())
                continue;
            if (stat.size > maxFileBytes) {
                parts.push(`## ${rel}\n<skipped: ${stat.size} bytes exceeds ${maxFileBytes}>`);
                continue;
            }
            const buf = fs.readFileSync(abs);
            if (buf.includes(0)) {
                parts.push(`## ${rel}\n<skipped: binary>`);
                continue;
            }
            parts.push(`## ${rel}\n${buf.toString("utf8")}`);
        }
        catch {
            parts.push(`## ${rel}\n<skipped: unreadable>`);
        }
    }
    if (files.length > 100)
        parts.push(`# (${files.length - 100} more untracked files omitted)`);
    return parts.join("\n\n");
}
function isSecretLikePath(rel) {
    const normalized = normalizePathForSecretCheck(rel);
    const segments = normalized.split("/").filter(Boolean);
    const basename = segments.at(-1) ?? normalized;
    return segments.includes("secrets")
        || basename === ".env"
        || basename.startsWith(".env.")
        || basename.endsWith(".env")
        || /\.(pem|key|p12|pfx)$/i.test(basename)
        || basename.startsWith("id_rsa");
}
function normalizePathForSecretCheck(value) {
    let normalized = value.trim().replace(/^["']|["']$/g, "");
    if (normalized.startsWith("a/") || normalized.startsWith("b/"))
        normalized = normalized.slice(2);
    return normalized.replace(/\\/g, "/").toLowerCase();
}
function filterSecretDiffSections(diff) {
    if (!diff.trim())
        return diff;
    const lines = diff.split(/\r?\n/);
    const output = [];
    let block = [];
    const flush = () => {
        if (block.length === 0)
            return;
        if (diffBlockHasSecretPath(block))
            output.push("# Omitted secret-like diff section.");
        else
            output.push(block.join("\n"));
        block = [];
    };
    for (const line of lines) {
        if (line.startsWith("diff --git ")) {
            flush();
            block = [line];
        }
        else if (block.length > 0) {
            block.push(line);
        }
        else {
            output.push(line);
        }
    }
    flush();
    return output.join("\n");
}
function diffBlockHasSecretPath(block) {
    const candidates = [];
    const header = block[0] ?? "";
    const match = header.match(/^diff --git\s+(.+?)\s+(.+)$/);
    if (match)
        candidates.push(match[1], match[2]);
    for (const line of block) {
        const fileMatch = line.match(/^(?:---|\+\+\+|rename from|rename to|copy from|copy to)\s+(.+)$/);
        if (fileMatch)
            candidates.push(fileMatch[1]);
    }
    return candidates.some((candidate) => candidate !== "/dev/null" && isSecretLikePath(candidate));
}
function filterSecretPathLines(text) {
    return text.split(/\r?\n/).filter((line) => {
        const tokens = line.trim().split(/\s+/).filter(Boolean);
        return !tokens.some((token) => isSecretLikePath(token));
    }).join("\n");
}
function computeArtifactHash(repo, loopState, checkResults) {
    const checkProjection = normalizedCheckProjection(checkResults);
    if (loopState.mode === "plan") {
        const planPath = resolvePlanFile(repo, loopState);
        return hashText(`${fs.existsSync(planPath) ? readText(planPath) : ""}\n\n# Normalized checks\n${JSON.stringify(checkProjection)}`);
    }
    return hashText(`${captureDiffText(repo)}\n\n# Normalized checks\n${JSON.stringify(checkProjection)}`);
}
function normalizedCheckProjection(checkResults) {
    return checkResults.map((result) => ({
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
    }));
}
function blockerFingerprintFor(blockers) {
    const normalized = blockers
        .filter((blocker) => blocker.severity !== "minor")
        .map((blocker) => ({
        severity: blocker.severity,
        title: normalizeWhitespace(blocker.title),
        evidence: normalizeWhitespace(blocker.evidence),
        instructionForClaude: normalizeWhitespace(blocker.instructionForClaude),
    }))
        .sort((a, b) => `${a.severity}:${a.title}`.localeCompare(`${b.severity}:${b.title}`));
    return hashText(JSON.stringify(normalized));
}
function hashText(text) {
    return (0, node_crypto_1.createHash)("sha256").update(text).digest("hex");
}
function normalizeWhitespace(text) {
    return text.trim().replace(/\s+/g, " ");
}
function resolveLastAssistantMessage(input) {
    if (input.last_assistant_message?.trim())
        return truncate(redact(input.last_assistant_message), 8_000);
    const transcriptPath = input.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath))
        return "";
    const lines = tailText(transcriptPath, 200_000).split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const entry = JSON.parse(lines[i]);
            const message = entry.message;
            const role = entry.role ?? message?.role;
            if (role === "assistant") {
                const text = flattenJson(message ?? entry.content ?? entry).trim();
                if (text)
                    return truncate(redact(text), 8_000);
            }
        }
        catch {
            // Ignore non-JSON transcript lines.
        }
    }
    return "";
}
function sessionPausedForLaterWork(input) {
    const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
    const crons = Array.isArray(input.session_crons) ? input.session_crons : [];
    const activeStatuses = new Set(["active", "pending", "queued", "running", "starting", "in_progress"]);
    const taskActive = tasks.some((task) => typeof task?.status === "string" && activeStatuses.has(task.status.toLowerCase()));
    return taskActive || crons.length > 0;
}
function parseLoopReviewText(text) {
    const jsonText = extractReviewJsonText(text);
    if (!jsonText)
        return undefined;
    try {
        return validateLoopReview(JSON.parse(jsonText));
    }
    catch {
        return undefined;
    }
}
function extractReviewJsonText(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return undefined;
    if (trimmed.startsWith("{"))
        return trimmed;
    const block = trimmed.match(/CODEX_REVIEW_RESULT\s*([\s\S]*?)\s*END_CODEX_REVIEW_RESULT/i);
    if (block?.[1])
        return block[1].trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence?.[1])
        return fence[1].trim();
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first)
        return trimmed.slice(first, last + 1);
    return undefined;
}
function validateLoopReview(value) {
    if (!isRecord(value))
        return undefined;
    if (!isLoopVerdict(value.verdict))
        return undefined;
    if (value.confidence !== "high" && value.confidence !== "medium" && value.confidence !== "low")
        return undefined;
    if (typeof value.summary !== "string" || typeof value.nextInstructionForClaude !== "string")
        return undefined;
    if (!Array.isArray(value.criteria) || !Array.isArray(value.blockers) || !Array.isArray(value.checks))
        return undefined;
    const criteria = value.criteria.map(validateCriterion).filter((item) => !!item);
    const blockers = value.blockers.map(validateBlocker).filter((item) => !!item);
    const checks = value.checks.map(validateReviewCheck).filter((item) => !!item);
    return {
        verdict: value.verdict,
        confidence: value.confidence,
        summary: value.summary,
        criteria,
        blockers,
        checks,
        nextInstructionForClaude: value.nextInstructionForClaude,
    };
}
function validateCriterion(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.criterion !== "string" || typeof value.evidence !== "string")
        return undefined;
    if (!isCriterionStatus(value.status))
        return undefined;
    return { criterion: value.criterion, status: value.status, evidence: value.evidence };
}
function validateBlocker(value) {
    if (!isRecord(value))
        return undefined;
    if (value.severity !== "blocking" && value.severity !== "major" && value.severity !== "minor")
        return undefined;
    if (typeof value.title !== "string" || typeof value.evidence !== "string" || typeof value.instructionForClaude !== "string")
        return undefined;
    return {
        severity: value.severity,
        title: value.title,
        evidence: value.evidence,
        instructionForClaude: value.instructionForClaude,
    };
}
function validateReviewCheck(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.command !== "string" || typeof value.evidence !== "string")
        return undefined;
    if (value.status !== "passed" && value.status !== "failed" && value.status !== "not_run")
        return undefined;
    return { command: value.command, status: value.status, evidence: value.evidence };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isLoopVerdict(value) {
    return value === "PASS" || value === "REVISE" || value === "HUMAN" || value === "ERROR";
}
function isCriterionStatus(value) {
    return value === "met" || value === "not_met" || value === "unclear" || value === "not_applicable";
}
function errorReview(summary) {
    return {
        verdict: "ERROR",
        confidence: "low",
        summary,
        criteria: [],
        blockers: [],
        checks: [],
        nextInstructionForClaude: "Ask the user whether to continue, retry the loop review, or stop the loop.",
    };
}
function formatReviewMarkdown(loopState, review, checks) {
    const blockers = review.blockers.length
        ? review.blockers.map((blocker, index) => `${index + 1}. ${blocker.title}
   Severity: ${blocker.severity}
   Evidence: ${blocker.evidence}
   Claude should: ${blocker.instructionForClaude}`).join("\n")
        : "None.";
    const criteria = review.criteria.length
        ? review.criteria.map((criterion) => `- ${criterion.status}: ${criterion.criterion}\n  Evidence: ${criterion.evidence}`).join("\n")
        : "No criteria reported.";
    return `# Codex Loop Review

- Mode: ${loopState.mode}
- Task: ${loopState.task}
- Verdict: ${review.verdict}
- Confidence: ${review.confidence}

## Summary
${review.summary}

## Criteria
${criteria}

## Blockers
${blockers}

## Configured Checks
${formatCheckResults(checks)}

## Next Instruction For Claude
${review.nextInstructionForClaude}
`;
}
function formatPlanReviseReason(loopState, review, round, reviewPath) {
    return truncate(`Codex plan gate says the plan is not ready to implement yet.

Goal:
${loopState.task}

Round:
${round}/${loopState.maxRounds}

Summary:
${review.summary}

Planning blockers:
${formatBlockers(review)}

Next instruction for Claude:
${review.nextInstructionForClaude}

Full review:
${reviewPath}

Revise the plan file. Do not implement code yet unless the user explicitly asks to proceed.`, 9_800);
}
function formatImplementReviseReason(loopState, review, round, reviewPath) {
    return truncate(`Codex implementation gate says the work is not ready yet.

Task:
${loopState.task}

Round:
${round}/${loopState.maxRounds}

Summary:
${review.summary}

Blocking findings:
${formatBlockers(review)}

Next instruction for Claude:
${review.nextInstructionForClaude}

Full review:
${reviewPath}

Address the blockers, run relevant checks, and try to finish again. If a finding is wrong, explain why with file evidence.`, 9_800);
}
function formatBlockers(review) {
    const blockers = review.blockers.filter((blocker) => blocker.severity !== "minor");
    if (blockers.length === 0)
        return "No blocking or major blockers were listed, but Codex returned a revise verdict.";
    return blockers.map((blocker, index) => `${index + 1}. ${blocker.title}
   Evidence: ${blocker.evidence}
   Claude should: ${blocker.instructionForClaude}`).join("\n");
}
function formatHumanReason(review) {
    return truncate(`Codex gate says this requires a user decision before continuing.

Question/decision needed:
${review.nextInstructionForClaude}

Claude should ask the user this question directly and not guess. After the user answers, update the plan or implementation accordingly.`, 9_800);
}
function formatCheckFailureReason(result, reviewPath) {
    return truncate(`Gate verification failed before Codex review.

Failed command:
${result.command}

Exit code:
${result.exitCode}

Output tail:
${checkEvidence(result)}

Full review:
${reviewPath}

Claude should fix the failing verification command, rerun it, and then try to finish again.`, 9_800);
}
function formatErrorReason(review, reviewPath) {
    return truncate(`Codex loop review hit an internal error.

Summary:
${review.summary}

Full review:
${reviewPath}

Claude should ask the user whether to retry, continue without the gate, or stop the loop.`, 9_800);
}
function formatMaxRoundsReason(loopState, review, reviewPath) {
    return truncate(`Codex loop reached its maximum review rounds.

Task:
${loopState.task}

Rounds:
${loopState.maxRounds}/${loopState.maxRounds}

Last summary:
${review.summary}

Last blockers:
${formatBlockers(review)}

Full review:
${reviewPath}

Claude should ask the user whether to continue, stop the loop, or proceed despite the remaining findings.`, 9_800);
}
function formatExhaustedReason(loopState) {
    return truncate(`Codex loop is exhausted.

Task:
${loopState.task}

Rounds:
${loopState.round}/${loopState.maxRounds}

Last feedback:
${loopState.lastBlockReason ?? "No prior block reason was recorded."}

Claude should ask the user whether to continue, stop the loop, or proceed despite the remaining findings.`, 9_800);
}
function formatStuckReason(loopState) {
    return truncate(`Codex loop appears stuck on the same unresolved feedback.

Task:
${loopState.task}

Last feedback:
${loopState.lastBlockReason ?? "No prior block reason was recorded."}

Claude should ask the user whether the finding is wrong, whether to continue iterating, or whether to stop the loop.`, 9_800);
}
function checkEvidence(result) {
    const tail = [result.stdoutTail, result.stderrTail].filter(Boolean).join("\n");
    return tail || (result.timedOut ? "Command timed out without captured output." : "No output captured.");
}
function tailString(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return text.slice(-maxChars);
}
function reactivateAwaitingHumanLoop(repo) {
    const active = loadLoop(repo);
    if (!active || active.status !== "awaiting_human")
        return;
    saveLoop(repo, { ...active, status: "active" });
}
function logLoopHookError(cwd, message) {
    const repo = gitRoot(cwd) ?? path.resolve(cwd);
    try {
        ensureLoopDirs(repo);
        fs.appendFileSync(path.join(loopDir(repo), "hook-errors.log"), `[${nowIso()}] ${message}\n`, "utf8");
    }
    catch {
        // Hooks must fail open.
    }
}
function init(args) {
    let installClaude = false;
    let installLoopHook = false;
    let skipGitCheck = false;
    for (const arg of args) {
        if (arg === "--install-claude")
            installClaude = true;
        else if (arg === "--install-loop-hook")
            installLoopHook = true;
        else if (arg === "--skip-git-check")
            skipGitCheck = true;
        else
            die(`unknown init option: ${arg}`);
    }
    const repo = repoRoot(skipGitCheck);
    ensureState(repo);
    console.log(`Initialized ${APP} state at ${stateDir(repo)}`);
    if (installClaude || installLoopHook)
        installClaudeIntegration(repo, { opinion: installClaude, loop: installLoopHook });
}
function installClaudeIntegration(repo, opts) {
    const settingsFile = path.join(repo, ".claude", "settings.local.json");
    const settings = readJson(settingsFile, {});
    const hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {});
    settings.hooks = hooks;
    mergeHook(hooks, "SessionStart", "startup|resume|clear|compact", `${APP} hook`);
    mergeHook(hooks, "UserPromptSubmit", "*", `${APP} hook`);
    if (opts.loop)
        mergeHook(hooks, "Stop", undefined, `${APP} loop hook stop`, LOOP_HOOK_TIMEOUT_SEC);
    writeJson(settingsFile, settings);
    if (opts.opinion) {
        const skillDir = path.join(repo, ".claude", "skills", "codex-opinion");
        ensureDir(skillDir);
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMarkdown(), "utf8");
        console.log(`Installed Claude skill: ${path.join(skillDir, "SKILL.md")}`);
    }
    if (opts.loop) {
        const loopSkillDir = path.join(repo, ".claude", "skills", "codex-loop");
        ensureDir(loopSkillDir);
        fs.writeFileSync(path.join(loopSkillDir, "SKILL.md"), loopSkillMarkdown(), "utf8");
        console.log(`Installed Claude skill: ${path.join(loopSkillDir, "SKILL.md")}`);
    }
    console.log(`Installed Claude hooks: ${settingsFile}`);
    if (opts.opinion)
        console.log(`Try in Claude Code: /codex-opinion review the current plan skeptically`);
    if (opts.loop)
        console.log(`Try in Claude Code: /codex-loop status`);
}
function mergeHook(hooks, event, matcher, command, timeout) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    const asObj = current;
    const existing = matcher === undefined
        ? asObj.find((entry) => Array.isArray(entry.hooks) && entry.hooks.some((item) => isRecord(item) && item.command === command))
        : asObj.find((entry) => entry.matcher === matcher);
    const hook = timeout === undefined ? { type: "command", command } : { type: "command", command, timeout };
    if (existing) {
        const list = Array.isArray(existing.hooks) ? existing.hooks : [];
        const sameCommand = list.find((item) => isRecord(item) && item.command === command);
        if (sameCommand) {
            sameCommand.type = "command";
            if (timeout === undefined)
                delete sameCommand.timeout;
            else
                sameCommand.timeout = timeout;
        }
        else if (!list.some((item) => JSON.stringify(item) === JSON.stringify(hook))) {
            list.push(hook);
        }
        existing.hooks = list;
    }
    else {
        asObj.push(matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] });
    }
    hooks[event] = asObj;
}
function skillMarkdown() {
    return `---
name: codex-opinion
description: Ask OpenAI Codex for a repo-aware second opinion in the background. Use for plan review, bug-hypothesis checks, PR-style diff review, migration risk, security/authorization skepticism, and follow-up questions to the same side thread.
allowed-tools: Bash(codex-sidecar ask *), Bash(codex-sidecar read *), Bash(codex-sidecar status *), Bash(codex-sidecar watch *), Bash(codex-sidecar clear *), Read(.codex-sidecar/latest.md), Read(.codex-sidecar/runs/*/answer.md)
---

# Codex Opinion

Use \`codex-sidecar\` to ask OpenAI Codex for a second opinion from the same Git repository.

Default behavior:
- Treat plain arguments as a new background question: \`codex-sidecar ask --claude <question>\`.
- For \`read\`, run \`codex-sidecar read\` and incorporate the answer as advisory input.
- For \`status\`, run \`codex-sidecar status\`.
- For \`watch\`, run \`codex-sidecar watch\`.
- For \`clear\`, run \`codex-sidecar clear\`.
- Prefer targeted skeptical prompts. Do not blindly defer to Codex; compare its evidence with your own.
`;
}
function loopSkillMarkdown() {
    return `---
name: codex-loop
description: Start, inspect, or stop a Codex review gate that blocks Claude from finishing until checks and Codex review pass. Use for high-risk implementation work or for iterating on a plan before code is written.
disable-model-invocation: true
allowed-tools: Bash(codex-sidecar loop *), Read(.codex-sidecar/loop.json), Read(.codex-sidecar/loop/latest-review.md), Read(.codex-sidecar/plan.md)
---

# Codex Loop

Use \`codex-sidecar loop ...\`.

Plan mode:

- Use when the user wants to iterate on a plan before implementation.
- Start with \`codex-sidecar loop start --mode plan ...\`.
- Create or update the configured plan file.
- Do not implement code unless the user explicitly asks.
- If the Stop hook blocks, revise the plan using Codex feedback.
- PASS means the plan is ready to implement, not that the feature is complete.

Implementation mode:

- Use when the user wants code changes gated by checks and Codex review.
- Start with \`codex-sidecar loop start --mode implement ...\`.
- When the Stop hook blocks, fix concrete blockers, run checks, and try to finish again.
- Treat Codex feedback as advisory but important; if a finding is wrong, explain why with file evidence.

Commands:

- \`/codex-loop start ...\` runs \`codex-sidecar loop start ...\`
- \`/codex-loop status\` runs \`codex-sidecar loop status\`
- \`/codex-loop read\` runs \`codex-sidecar loop read\`
- \`/codex-loop stop\` runs \`codex-sidecar loop stop\`
`;
}
function hook(_args) {
    const input = !process.stdin.isTTY ? fs.readFileSync(0, "utf8") : "";
    let payload = {};
    try {
        payload = input.trim() ? JSON.parse(input) : {};
    }
    catch {
        payload = { raw: input };
    }
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const repo = gitRoot(cwd) ?? path.resolve(cwd);
    ensureState(repo);
    const hookEventName = String(payload.hook_event_name ?? payload.hookEventName ?? "");
    const state = {
        capturedAt: nowIso(),
        sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
        transcriptPath: typeof payload.transcript_path === "string" ? payload.transcript_path : undefined,
        cwd,
        hookEventName,
    };
    writeJson(path.join(stateDir(repo), "claude-session.json"), state);
    if (hookEventName === "UserPromptSubmit") {
        reactivateAwaitingHumanLoop(repo);
        injectIfReady(repo);
    }
}
function injectIfReady(repo) {
    const threadsDir = path.join(stateDir(repo), "threads");
    if (!fs.existsSync(threadsDir))
        return;
    const threads = fs.readdirSync(threadsDir).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(threadsDir, f), defaultThread(repo, f.replace(/\.json$/, ""))));
    const candidates = threads
        .filter((t) => t.lastRunId && t.lastRunId !== t.lastInjectedRunId)
        .map((t) => ({ thread: t, meta: readJson(path.join(runDir(repo, t.lastRunId), "metadata.json"), undefined) }))
        .filter((x) => !!x.meta && x.meta.status === "done" && fs.existsSync(x.meta.answerPath))
        .sort((a, b) => b.meta.id.localeCompare(a.meta.id));
    const latest = candidates[0];
    if (!latest)
        return;
    const answer = truncate(readText(latest.meta.answerPath), 12_000);
    latest.thread.lastInjectedRunId = latest.meta.id;
    saveThread(repo, latest.thread);
    const additionalContext = `Codex sidecar completed a background answer.\n\nThread: ${latest.thread.name}\nRun: ${latest.meta.id}\nQuestion: ${latest.meta.question}\n\nAnswer:\n${answer}`;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext,
        },
    }));
}
function doctor(_args) {
    const root = gitRoot() ?? process.cwd();
    console.log(`cwd: ${process.cwd()}`);
    console.log(`repo: ${root}`);
    console.log(`git repo: ${gitRoot() ? "yes" : "no"}`);
    console.log(`state: ${stateDir(root)}`);
    console.log(`node: ${process.version}`);
    console.log(`platform: ${os.platform()} ${os.release()}`);
    console.log(`codex: ${commandExists("codex") ? "found" : "not found"}`);
    if (commandExists("codex")) {
        const version = runQuiet("codex", ["--version"]).stdout.trim();
        if (version)
            console.log(`codex version: ${version}`);
    }
    const claude = readJson(path.join(stateDir(root), "claude-session.json"), undefined);
    console.log(`claude transcript captured: ${claude?.transcriptPath ? "yes" : "no"}`);
    if (claude?.transcriptPath)
        console.log(`claude transcript: ${claude.transcriptPath}`);
}
function readText(file) {
    return fs.readFileSync(file, "utf8");
}
function tailText(file, maxBytes) {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
        const size = Math.min(maxBytes, stat.size);
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, stat.size - size);
        return buf.toString("utf8");
    }
    finally {
        fs.closeSync(fd);
    }
}
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const head = Math.floor(maxChars / 2);
    const tail = maxChars - head;
    return `${text.slice(0, head)}\n\n... <truncated ${text.length - maxChars} chars> ...\n\n${text.slice(-tail)}`;
}
function redact(text) {
    return text
        .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "<redacted-openai-key>")
        .replace(/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, "<redacted-stripe-key>")
        .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-github-token>")
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws-access-key>")
        .replace(/(aws_secret_access_key|database_url|db_url|connection_string)\s*[:=]\s*['\"]?[^\s'\"]{8,}/gi, "$1=<redacted>")
        .replace(/(["']?apiKey["']?\s*:\s*["'])[^"']{8,}(["'])/g, "$1<redacted>$2")
        .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['\"]?[^\s'\"]{8,}/gi, "$1=<redacted>")
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>")
        .replace(/bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer <redacted>");
}
if (require.main === module) {
    main(process.argv.slice(2));
}
//# sourceMappingURL=cli.js.map
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
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const process = __importStar(require("node:process"));
const APP = "codex-sidecar";
const STATE_DIR = ".codex-sidecar";
const DEFAULT_THREAD = "default";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
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
  ${APP} doctor
  ${APP} ask [options] <question...>
  ${APP} status [-t thread]
  ${APP} read [-t thread] [--run run-id]
  ${APP} watch [-t thread] [--run run-id]
  ${APP} clear [-t thread] [--hard]

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
    const cmd = codexCommand(meta, sessionId);
    updateMeta(rdir, { status: "running", command: cmd });
    const result = (0, node_child_process_1.spawnSync)(cmd[0], cmd.slice(1), {
        cwd: meta.repo,
        input: readText(meta.promptPath),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
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
function codexCommand(meta, sessionId) {
    const cmd = [
        "codex",
        "exec",
        "--cd", meta.repo,
        "--color", "never",
        "--sandbox", meta.sandbox,
        "--output-last-message", meta.answerPath,
        "--json",
    ];
    if (meta.model)
        cmd.push("--model", meta.model);
    if (meta.profile)
        cmd.push("--profile", meta.profile);
    if (meta.skipGitCheck)
        cmd.push("--skip-git-repo-check");
    for (const item of meta.codexConfig)
        cmd.push("-c", item);
    cmd.push("-c", `approval_policy=${JSON.stringify(meta.approval)}`);
    if (!meta.fresh && sessionId)
        cmd.push("resume", sessionId);
    cmd.push("-");
    return cmd;
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
function init(args) {
    let installClaude = false;
    let skipGitCheck = false;
    for (const arg of args) {
        if (arg === "--install-claude")
            installClaude = true;
        else if (arg === "--skip-git-check")
            skipGitCheck = true;
        else
            die(`unknown init option: ${arg}`);
    }
    const repo = repoRoot(skipGitCheck);
    ensureState(repo);
    console.log(`Initialized ${APP} state at ${stateDir(repo)}`);
    if (installClaude)
        installClaudeIntegration(repo);
}
function installClaudeIntegration(repo) {
    const skillDir = path.join(repo, ".claude", "skills", "codex-opinion");
    ensureDir(skillDir);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMarkdown(), "utf8");
    const settingsFile = path.join(repo, ".claude", "settings.local.json");
    const settings = readJson(settingsFile, {});
    const hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {});
    settings.hooks = hooks;
    mergeHook(hooks, "SessionStart", "startup|resume|clear|compact", `${APP} hook`);
    mergeHook(hooks, "UserPromptSubmit", "*", `${APP} hook`);
    writeJson(settingsFile, settings);
    console.log(`Installed Claude skill: ${path.join(skillDir, "SKILL.md")}`);
    console.log(`Installed Claude hooks: ${settingsFile}`);
    console.log(`Try in Claude Code: /codex-opinion review the current plan skeptically`);
}
function mergeHook(hooks, event, matcher, command) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    const asObj = current;
    const existing = asObj.find((entry) => entry.matcher === matcher);
    const hook = { type: "command", command };
    if (existing) {
        const list = Array.isArray(existing.hooks) ? existing.hooks : [];
        if (!list.some((item) => JSON.stringify(item) === JSON.stringify(hook)))
            list.push(hook);
        existing.hooks = list;
    }
    else {
        asObj.push({ matcher, hooks: [hook] });
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
    if (hookEventName === "UserPromptSubmit")
        injectIfReady(repo);
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
        .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['\"]?[^\s'\"]{8,}/gi, "$1=<redacted>")
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>")
        .replace(/bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer <redacted>");
}
main(process.argv.slice(2));
//# sourceMappingURL=cli.js.map
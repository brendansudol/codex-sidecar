#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";

const APP = "codex-sidecar";
const STATE_DIR = ".codex-sidecar";
const DEFAULT_THREAD = "default";
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "unknown";

interface RunMeta {
  id: string;
  thread: string;
  repo: string;
  cwd: string;
  question: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  promptPath: string;
  answerPath: string;
  stdoutPath: string;
  stderrPath: string;
  workerLogPath: string;
  sandbox: string;
  approval: string;
  includeClaude: boolean;
  fresh: boolean;
  wait: boolean;
  model?: string;
  profile?: string;
  codexConfig: string[];
  contextFiles: string[];
  maxClaudeChars: number;
  skipGitCheck: boolean;
  workerPid?: number;
  codexPid?: number;
  command?: string[];
  returnCode?: number;
  sessionId?: string;
  error?: string;
  finishedAt?: string;
}

interface ThreadState {
  name: string;
  repo: string;
  sessionId?: string;
  lastRunId?: string;
  lastInjectedRunId?: string;
  turns: Array<{
    runId: string;
    question: string;
    answerPath: string;
    answeredAt: string;
  }>;
  updatedAt: string;
}

interface ClaudeSessionState {
  capturedAt: string;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  hookEventName?: string;
}

interface AskOptions {
  thread: string;
  wait: boolean;
  includeClaude: boolean;
  fresh: boolean;
  sandbox: string;
  approval: string;
  model?: string;
  profile?: string;
  codexConfig: string[];
  contextFiles: string[];
  maxClaudeChars: number;
  skipGitCheck: boolean;
  question: string;
}

function main(argv: string[]): void {
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
  } catch (err) {
    if (err instanceof ExitError) process.exit(err.code);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${APP}: ${msg}`);
    process.exit(1);
  }
}

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

function help(): void {
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

function die(message: string, code = 1): never {
  console.error(`${APP}: ${message}`);
  throw new ExitError(code);
}

function nowIso(): string {
  return new Date().toISOString();
}

function commandExists(name: string): boolean {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [name] : ["-v", name], {
    shell: process.platform !== "win32",
    stdio: "ignore",
  });
  return result.status === 0;
}

function runQuiet(command: string, args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitRoot(cwd = process.cwd()): string | undefined {
  const result = runQuiet("git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.status === 0 && result.stdout.trim()) return path.resolve(result.stdout.trim());
  return undefined;
}

function repoRoot(skipGitCheck = false, cwd = process.cwd()): string {
  const root = gitRoot(cwd);
  if (root) return root;
  if (skipGitCheck) return path.resolve(cwd);
  die("not inside a git repository; pass --skip-git-check to use the current directory anyway");
}

function stateDir(repo: string): string {
  return path.join(repo, STATE_DIR);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureState(repo: string): void {
  ensureDir(path.join(stateDir(repo), "runs"));
  ensureDir(path.join(stateDir(repo), "threads"));
  addLocalGitExclude(repo);
}

function addLocalGitExclude(repo: string): void {
  const exclude = path.join(repo, ".git", "info", "exclude");
  if (!fs.existsSync(exclude)) return;
  const current = fs.readFileSync(exclude, "utf8");
  if (current.includes(`${STATE_DIR}/`)) return;
  fs.appendFileSync(exclude, `\n# ${APP} local state\n${STATE_DIR}/\n`, "utf8");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function slug(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || DEFAULT_THREAD;
}

function threadFile(repo: string, thread: string): string {
  return path.join(stateDir(repo), "threads", `${slug(thread)}.json`);
}

function defaultThread(repo: string, thread: string): ThreadState {
  return { name: slug(thread), repo, turns: [], updatedAt: nowIso() };
}

function loadThread(repo: string, thread: string): ThreadState {
  const file = threadFile(repo, thread);
  const loaded = readJson<ThreadState | undefined>(file, undefined);
  if (!loaded) return defaultThread(repo, thread);
  loaded.turns ??= [];
  return loaded;
}

function saveThread(repo: string, thread: ThreadState): void {
  thread.updatedAt = nowIso();
  writeJson(threadFile(repo, thread.name), thread);
}

function runId(thread: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${stamp}-${slug(thread)}-${process.pid}`;
}

function runDir(repo: string, id: string): string {
  return path.join(stateDir(repo), "runs", id);
}

function latestRunFile(repo: string, thread: string): string {
  return path.join(stateDir(repo), `latest-${slug(thread)}`);
}

function setLatestRun(repo: string, thread: string, id: string): void {
  fs.writeFileSync(latestRunFile(repo, thread), `${id}\n`, "utf8");
  if (slug(thread) === DEFAULT_THREAD) fs.writeFileSync(path.join(stateDir(repo), "latest"), `${id}\n`, "utf8");
}

function getLatestRunId(repo: string, thread: string): string | undefined {
  const threadFilePath = latestRunFile(repo, thread);
  if (fs.existsSync(threadFilePath)) return fs.readFileSync(threadFilePath, "utf8").trim() || undefined;
  const fallback = path.join(stateDir(repo), "latest");
  if (slug(thread) === DEFAULT_THREAD && fs.existsSync(fallback)) return fs.readFileSync(fallback, "utf8").trim() || undefined;
  const state = loadThread(repo, thread);
  return state.lastRunId;
}

function updateMeta(runPath: string, patch: Partial<RunMeta>): RunMeta {
  const file = path.join(runPath, "metadata.json");
  const existing = readJson<RunMeta>(file, {} as RunMeta);
  const next = { ...existing, ...patch, updatedAt: nowIso() };
  writeJson(file, next);
  return next;
}

function loadMeta(runPath: string): RunMeta {
  return readJson<RunMeta>(path.join(runPath, "metadata.json"), {} as RunMeta);
}

function parseAskArgs(args: string[]): AskOptions {
  const options: AskOptions = {
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
  const questionParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      questionParts.push(...args.slice(i + 1));
      break;
    } else if (arg === "-t" || arg === "--thread") {
      options.thread = needValue(args, ++i, arg);
    } else if (arg === "--wait") {
      options.wait = true;
    } else if (arg === "--claude") {
      options.includeClaude = true;
    } else if (arg === "--fresh") {
      options.fresh = true;
    } else if (arg === "--sandbox") {
      options.sandbox = needValue(args, ++i, arg);
    } else if (arg === "--approval") {
      options.approval = needValue(args, ++i, arg);
    } else if (arg === "--model") {
      options.model = needValue(args, ++i, arg);
    } else if (arg === "--profile") {
      options.profile = needValue(args, ++i, arg);
    } else if (arg === "-c" || arg === "--config") {
      options.codexConfig.push(needValue(args, ++i, arg));
    } else if (arg === "--context-file") {
      options.contextFiles.push(needValue(args, ++i, arg));
    } else if (arg === "--max-claude-chars") {
      options.maxClaudeChars = Number.parseInt(needValue(args, ++i, arg), 10);
      if (!Number.isFinite(options.maxClaudeChars)) die("--max-claude-chars must be a number");
    } else if (arg === "--skip-git-check") {
      options.skipGitCheck = true;
    } else if (arg.startsWith("-")) {
      die(`unknown ask option: ${arg}`);
    } else {
      questionParts.push(arg);
    }
  }
  options.question = questionParts.join(" ").trim();
  if (!options.question && !process.stdin.isTTY) options.question = fs.readFileSync(0, "utf8").trim();
  if (!options.question) die("provide a question, or pipe one on stdin");
  return options;
}

function needValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) die(`${flag} requires a value`);
  return value;
}

function ask(args: string[]): void {
  if (!commandExists("codex")) die("`codex` CLI not found on PATH. Install and log in to Codex first.");
  const opts = parseAskArgs(args);
  const repo = repoRoot(opts.skipGitCheck);
  ensureState(repo);
  const id = runId(opts.thread);
  const rdir = runDir(repo, id);
  ensureDir(rdir);
  const meta: RunMeta = {
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
    if (fs.existsSync(meta.answerPath)) console.log(fs.readFileSync(meta.answerPath, "utf8"));
    if (code !== 0) process.exit(code);
    return;
  }

  const cli = path.resolve(process.argv[1]);
  const log = fs.openSync(meta.workerLogPath, "a");
  const child = spawn(process.execPath, [cli, "worker", rdir], {
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

function buildPrompt(meta: RunMeta): string {
  const repo = meta.repo;
  const thread = loadThread(repo, meta.thread);
  const chunks: string[] = [];
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
  if (git) chunks.push(`# Current git context\n${git}`);

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
    } catch (err) {
      chunks.push(`# Extra context file unavailable: ${abs}\n${String(err)}`);
    }
  }

  chunks.push(`# User question for Codex\n${meta.question}`);
  return `${chunks.join("\n\n")}\n`;
}

function gitContext(repo: string): string {
  const commands: Array<[string, string[]]> = [
    ["branch/status", ["status", "--short", "--branch"]],
    ["recent commits", ["log", "--oneline", "-5", "--decorate"]],
    ["diff stat", ["diff", "--stat"]],
    ["staged diff stat", ["diff", "--cached", "--stat"]],
    ["changed files", ["diff", "--name-only"]],
    ["staged changed files", ["diff", "--cached", "--name-only"]],
  ];
  const parts: string[] = [];
  for (const [label, args] of commands) {
    const result = runQuiet("git", args, repo);
    const output = (result.stdout || result.stderr).trim();
    if (output) parts.push(`## ${label}\n${output}`);
  }
  return truncate(parts.join("\n\n"), 12_000);
}

function claudeContext(repo: string, maxChars: number): string {
  const state = readJson<ClaudeSessionState | undefined>(path.join(stateDir(repo), "claude-session.json"), undefined);
  if (!state?.transcriptPath) return "";
  if (!fs.existsSync(state.transcriptPath)) return `Captured transcript path no longer exists: ${state.transcriptPath}`;
  const tail = tailText(state.transcriptPath, maxChars * 3);
  const lines = tail.split(/\r?\n/).filter(Boolean).slice(-60);
  const entries = lines.map((line) => {
    try {
      return flattenJson(JSON.parse(line));
    } catch {
      return line;
    }
  }).filter(Boolean).map((s) => truncate(redact(s), 2_000));
  const header = `Claude session id: ${state.sessionId ?? "unknown"}\nClaude transcript path: ${state.transcriptPath}`;
  return truncate(`${header}\n\n${entries.join("\n\n---\n\n")}`, maxChars);
}

function flattenJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenJson).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const heads = ["role", "type", "subtype", "tool_name", "name"].filter((k) => typeof obj[k] === "string").map((k) => `${k}=${obj[k]}`);
    const bodies = ["message", "content", "text", "prompt", "tool_input", "result", "summary"].filter((k) => k in obj).map((k) => `${k}: ${flattenJson(obj[k])}`).filter(Boolean);
    if (bodies.length) return `${heads.join(" ")}${heads.length ? "\n" : ""}${bodies.join("\n")}`;
    return JSON.stringify(value).slice(0, 2_000);
  }
  return String(value);
}

function runWorker(rdir: string): number {
  const meta = loadMeta(rdir);
  const thread = loadThread(meta.repo, meta.thread);
  const sessionId = !meta.fresh ? thread.sessionId : undefined;
  const cmd = codexCommand(meta, sessionId);
  updateMeta(rdir, { status: "running", command: cmd });

  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: meta.repo,
    input: readText(meta.promptPath),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(meta.stdoutPath, result.stdout ?? "", "utf8");
  fs.writeFileSync(meta.stderrPath, result.stderr ?? "", "utf8");
  const code = result.status ?? 1;
  if (result.error) fs.appendFileSync(meta.stderrPath, `\n${result.error.message}\n`, "utf8");

  let answer = fs.existsSync(meta.answerPath) ? readText(meta.answerPath).trim() : "";
  if (!answer) {
    answer = `Codex did not write a final answer. Last output follows:\n\n${tailText(meta.stderrPath, 12_000) || tailText(meta.stdoutPath, 12_000)}`;
    fs.writeFileSync(meta.answerPath, answer, "utf8");
  }

  const parsedSession = parseSessionId([meta.stdoutPath, meta.stderrPath, meta.answerPath]) ?? sessionId;
  const status: RunStatus = code === 0 ? "done" : "failed";
  const latestPath = path.join(stateDir(meta.repo), "latest.md");
  const latest = `# Codex Sidecar Answer\n\n- Run: \`${meta.id}\`\n- Thread: \`${meta.thread}\`\n- Status: \`${status}\`\n- Question: ${meta.question}\n\n---\n\n${answer.trim()}\n`;
  fs.writeFileSync(latestPath, latest, "utf8");

  const nextThread = loadThread(meta.repo, meta.thread);
  nextThread.sessionId = parsedSession;
  nextThread.lastRunId = meta.id;
  nextThread.turns.push({ runId: meta.id, question: meta.question, answerPath: meta.answerPath, answeredAt: nowIso() });
  nextThread.turns = nextThread.turns.slice(-20);
  saveThread(meta.repo, nextThread);

  updateMeta(rdir, { status, returnCode: code, sessionId: parsedSession, finishedAt: nowIso() });
  return code;
}

function codexCommand(meta: RunMeta, sessionId?: string): string[] {
  const cmd = [
    "codex",
    "exec",
    "--cd", meta.repo,
    "--color", "never",
    "--sandbox", meta.sandbox,
    "--output-last-message", meta.answerPath,
    "--json",
  ];
  if (meta.model) cmd.push("--model", meta.model);
  if (meta.profile) cmd.push("--profile", meta.profile);
  if (meta.skipGitCheck) cmd.push("--skip-git-repo-check");
  for (const item of meta.codexConfig) cmd.push("-c", item);
  cmd.push("-c", `approval_policy=${JSON.stringify(meta.approval)}`);
  if (!meta.fresh && sessionId) cmd.push("resume", sessionId);
  cmd.push("-");
  return cmd;
}

function worker(args: string[]): void {
  const rdir = args[0];
  if (!rdir) die("worker requires a run directory");
  process.exit(runWorker(rdir));
}

function parseSessionId(files: string[]): string | undefined {
  const found: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = readText(file);
    for (const match of text.matchAll(UUID_RE)) found.push(match[0].toLowerCase());
  }
  return found.at(-1);
}

function parseThreadAndRun(args: string[]): { thread: string; run?: string; skipGitCheck: boolean; json: boolean } {
  let thread = DEFAULT_THREAD;
  let run: string | undefined;
  let skipGitCheck = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-t" || arg === "--thread") thread = needValue(args, ++i, arg);
    else if (arg === "--run") run = needValue(args, ++i, arg);
    else if (arg === "--skip-git-check") skipGitCheck = true;
    else if (arg === "--json") json = true;
    else if (!run && !arg.startsWith("-")) run = arg;
    else die(`unknown option: ${arg}`);
  }
  return { thread: slug(thread), run, skipGitCheck, json };
}

function resolveRunPath(repo: string, thread: string, run?: string): string {
  const id = run ?? getLatestRunId(repo, thread);
  if (!id) die(`no run found for thread '${thread}'`);
  const rdir = runDir(repo, id);
  if (!fs.existsSync(rdir)) die(`run not found: ${id}`);
  return rdir;
}

function refreshMeta(meta: RunMeta): RunMeta {
  if (meta.status !== "running") return meta;
  const pid = meta.codexPid ?? meta.workerPid;
  if (pid && isPidAlive(pid)) return meta;
  if (fs.existsSync(meta.answerPath)) return updateMeta(path.dirname(meta.answerPath), { status: "done" });
  return updateMeta(path.dirname(meta.answerPath), { status: "unknown" });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function status(args: string[]): void {
  const opts = parseThreadAndRun(args);
  const repo = repoRoot(opts.skipGitCheck);
  ensureState(repo);
  const runsDir = path.join(stateDir(repo), "runs");
  const metas = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).map((id) => path.join(runsDir, id, "metadata.json")).filter(fs.existsSync).map((f) => refreshMeta(readJson<RunMeta>(f, {} as RunMeta)))
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

function read(args: string[]): void {
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

function watch(args: string[]): void {
  const opts = parseThreadAndRun(args);
  const repo = repoRoot(opts.skipGitCheck);
  const rdir = resolveRunPath(repo, opts.thread, opts.run);
  for (;;) {
    const meta = refreshMeta(loadMeta(rdir));
    if (!["queued", "running"].includes(meta.status)) {
      if (fs.existsSync(meta.answerPath)) console.log(readText(meta.answerPath));
      else console.log(`Run ${meta.id} ended with status ${meta.status}.`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
}

function clear(args: string[]): void {
  let thread = DEFAULT_THREAD;
  let hard = false;
  let skipGitCheck = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-t" || arg === "--thread") thread = needValue(args, ++i, arg);
    else if (arg === "--hard") hard = true;
    else if (arg === "--skip-git-check") skipGitCheck = true;
    else die(`unknown clear option: ${arg}`);
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

function init(args: string[]): void {
  let installClaude = false;
  let skipGitCheck = false;
  for (const arg of args) {
    if (arg === "--install-claude") installClaude = true;
    else if (arg === "--skip-git-check") skipGitCheck = true;
    else die(`unknown init option: ${arg}`);
  }
  const repo = repoRoot(skipGitCheck);
  ensureState(repo);
  console.log(`Initialized ${APP} state at ${stateDir(repo)}`);
  if (installClaude) installClaudeIntegration(repo);
}

function installClaudeIntegration(repo: string): void {
  const skillDir = path.join(repo, ".claude", "skills", "codex-opinion");
  ensureDir(skillDir);
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMarkdown(), "utf8");

  const settingsFile = path.join(repo, ".claude", "settings.local.json");
  const settings = readJson<Record<string, Json>>(settingsFile, {});
  const hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {}) as Record<string, Json>;
  settings.hooks = hooks;
  mergeHook(hooks, "SessionStart", "startup|resume|clear|compact", `${APP} hook`);
  mergeHook(hooks, "UserPromptSubmit", "*", `${APP} hook`);
  writeJson(settingsFile, settings);

  console.log(`Installed Claude skill: ${path.join(skillDir, "SKILL.md")}`);
  console.log(`Installed Claude hooks: ${settingsFile}`);
  console.log(`Try in Claude Code: /codex-opinion review the current plan skeptically`);
}

function mergeHook(hooks: Record<string, Json>, event: string, matcher: string, command: string): void {
  const current = Array.isArray(hooks[event]) ? hooks[event] as Json[] : [];
  const asObj = current as Array<Record<string, Json>>;
  const existing = asObj.find((entry) => entry.matcher === matcher);
  const hook = { type: "command", command };
  if (existing) {
    const list = Array.isArray(existing.hooks) ? existing.hooks as Json[] : [];
    if (!list.some((item) => JSON.stringify(item) === JSON.stringify(hook))) list.push(hook);
    existing.hooks = list;
  } else {
    asObj.push({ matcher, hooks: [hook] });
  }
  hooks[event] = asObj as unknown as Json;
}

function skillMarkdown(): string {
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

function hook(_args: string[]): void {
  const input = !process.stdin.isTTY ? fs.readFileSync(0, "utf8") : "";
  let payload: Record<string, unknown> = {};
  try { payload = input.trim() ? JSON.parse(input) : {}; } catch { payload = { raw: input }; }
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const repo = gitRoot(cwd) ?? path.resolve(cwd);
  ensureState(repo);
  const hookEventName = String(payload.hook_event_name ?? payload.hookEventName ?? "");
  const state: ClaudeSessionState = {
    capturedAt: nowIso(),
    sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
    transcriptPath: typeof payload.transcript_path === "string" ? payload.transcript_path : undefined,
    cwd,
    hookEventName,
  };
  writeJson(path.join(stateDir(repo), "claude-session.json"), state);
  if (hookEventName === "UserPromptSubmit") injectIfReady(repo);
}

function injectIfReady(repo: string): void {
  const threadsDir = path.join(stateDir(repo), "threads");
  if (!fs.existsSync(threadsDir)) return;
  const threads = fs.readdirSync(threadsDir).filter((f) => f.endsWith(".json")).map((f) => readJson<ThreadState>(path.join(threadsDir, f), defaultThread(repo, f.replace(/\.json$/, ""))));
  const candidates = threads
    .filter((t) => t.lastRunId && t.lastRunId !== t.lastInjectedRunId)
    .map((t) => ({ thread: t, meta: readJson<RunMeta | undefined>(path.join(runDir(repo, t.lastRunId!), "metadata.json"), undefined) }))
    .filter((x): x is { thread: ThreadState; meta: RunMeta } => !!x.meta && x.meta.status === "done" && fs.existsSync(x.meta.answerPath))
    .sort((a, b) => b.meta.id.localeCompare(a.meta.id));
  const latest = candidates[0];
  if (!latest) return;
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

function doctor(_args: string[]): void {
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
    if (version) console.log(`codex version: ${version}`);
  }
  const claude = readJson<ClaudeSessionState | undefined>(path.join(stateDir(root), "claude-session.json"), undefined);
  console.log(`claude transcript captured: ${claude?.transcriptPath ? "yes" : "no"}`);
  if (claude?.transcriptPath) console.log(`claude transcript: ${claude.transcriptPath}`);
}

function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function tailText(file: string, maxBytes: number): string {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  try {
    const size = Math.min(maxBytes, stat.size);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars / 2);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n... <truncated ${text.length - maxChars} chars> ...\n\n${text.slice(-tail)}`;
}

function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "<redacted-openai-key>")
    .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['\"]?[^\s'\"]{8,}/gi, "$1=<redacted>")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>")
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer <redacted>");
}

main(process.argv.slice(2));

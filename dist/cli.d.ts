#!/usr/bin/env node
declare const LOOP_REVIEW_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["verdict", "confidence", "summary", "criteria", "blockers", "checks", "nextInstructionForClaude"];
    readonly properties: {
        readonly verdict: {
            readonly type: "string";
            readonly enum: readonly ["PASS", "REVISE", "HUMAN", "ERROR"];
        };
        readonly confidence: {
            readonly type: "string";
            readonly enum: readonly ["high", "medium", "low"];
        };
        readonly summary: {
            readonly type: "string";
        };
        readonly criteria: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["criterion", "status", "evidence"];
                readonly properties: {
                    readonly criterion: {
                        readonly type: "string";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly enum: readonly ["met", "not_met", "unclear", "not_applicable"];
                    };
                    readonly evidence: {
                        readonly type: "string";
                    };
                };
            };
        };
        readonly blockers: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["severity", "title", "evidence", "instructionForClaude"];
                readonly properties: {
                    readonly severity: {
                        readonly type: "string";
                        readonly enum: readonly ["blocking", "major", "minor"];
                    };
                    readonly title: {
                        readonly type: "string";
                    };
                    readonly evidence: {
                        readonly type: "string";
                    };
                    readonly instructionForClaude: {
                        readonly type: "string";
                    };
                };
            };
        };
        readonly checks: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["command", "status", "evidence"];
                readonly properties: {
                    readonly command: {
                        readonly type: "string";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly enum: readonly ["passed", "failed", "not_run"];
                    };
                    readonly evidence: {
                        readonly type: "string";
                    };
                };
            };
        };
        readonly nextInstructionForClaude: {
            readonly type: "string";
        };
    };
};
type LoopMode = "plan" | "implement";
type LoopStatus = "active" | "awaiting_human" | "passed" | "exhausted" | "stuck" | "error" | "inactive";
type LoopVerdict = "PASS" | "REVISE" | "HUMAN" | "ERROR";
type CriterionStatus = "met" | "not_met" | "unclear" | "not_applicable";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalMode = "never" | "on-request" | "untrusted";
interface CodexInvocation {
    repo: string;
    sandbox: string;
    approval: string;
    answerPath: string;
    model?: string;
    profile?: string;
    skipGitCheck?: boolean;
    extraConfig?: string[];
    outputSchemaPath?: string;
    resumeSessionId?: string;
}
interface LoopState {
    version: 1;
    status: LoopStatus;
    mode: LoopMode;
    task: string;
    criteria: string[];
    maxRounds: number;
    round: number;
    checks: string[];
    planFile?: string;
    requirePlanFile: boolean;
    blind: boolean;
    includeClaudeContext: boolean;
    maxClaudeChars: number;
    sandbox: SandboxMode;
    approval: ApprovalMode;
    model?: string;
    profile?: string;
    failClosed: boolean;
    reviewTimeoutSec: number;
    checkTimeoutSec: number;
    skipGitCheck: boolean;
    sessionId?: string;
    armedAt: string;
    updatedAt: string;
    lastVerdict?: LoopVerdict;
    lastReviewId?: string;
    lastReviewPath?: string;
    lastBlockReason?: string;
    lastArtifactHash?: string;
    lastBlockerFingerprint?: string;
    stuckRounds: number;
    lastError?: string;
}
interface CheckResult {
    command: string;
    exitCode: number;
    durationMs: number;
    stdoutTail: string;
    stderrTail: string;
    timedOut: boolean;
}
interface LoopReview {
    verdict: LoopVerdict;
    confidence: "high" | "medium" | "low";
    summary: string;
    criteria: Array<{
        criterion: string;
        status: CriterionStatus;
        evidence: string;
    }>;
    blockers: Array<{
        severity: "blocking" | "major" | "minor";
        title: string;
        evidence: string;
        instructionForClaude: string;
    }>;
    checks: Array<{
        command: string;
        status: "passed" | "failed" | "not_run";
        evidence: string;
    }>;
    nextInstructionForClaude: string;
}
interface StopHookInput {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    permission_mode?: string;
    hook_event_name?: "Stop" | string;
    stop_hook_active?: boolean;
    last_assistant_message?: string;
    background_tasks?: Array<{
        id?: string;
        type?: string;
        status?: string;
        description?: string;
        command?: string;
    }>;
    session_crons?: unknown[];
}
interface HookDecision {
    decision: "allow" | "block";
    reason?: string;
    verdict?: LoopVerdict;
    error?: boolean;
}
interface LoopReviewResult {
    review: LoopReview;
    reviewId: string;
    reviewPath: string;
}
declare function codexCommand(inv: CodexInvocation): string[];
declare function evaluateLoop(repo: string, input: StopHookInput): HookDecision;
declare class Deadline {
    private readonly expiresAt;
    constructor(loopState: LoopState);
    remainingMs(maxMs: number): number;
}
declare function runChecks(repo: string, checks: string[], timeoutSec: number, deadline: Deadline): CheckResult[];
declare function applyNoProgress(repo: string, loopState: LoopState): HookDecision;
declare function applyReview(repo: string, loopState: LoopState, result: LoopReviewResult, artifactHash: string): HookDecision;
declare function gitDiffFull(repo: string): string;
declare function gitUntrackedText(repo: string): string;
declare function computeArtifactHash(repo: string, loopState: LoopState, checkResults: CheckResult[]): string;
declare function blockerFingerprintFor(blockers: LoopReview["blockers"]): string;
declare function hashText(text: string): string;
declare function sessionPausedForLaterWork(input: StopHookInput): boolean;
declare function parseLoopReviewText(text: string): LoopReview | undefined;
export { LOOP_REVIEW_SCHEMA, Deadline, applyNoProgress, applyReview, blockerFingerprintFor, codexCommand, computeArtifactHash, evaluateLoop, gitDiffFull, gitUntrackedText, hashText, parseLoopReviewText, runChecks, sessionPausedForLaterWork, };

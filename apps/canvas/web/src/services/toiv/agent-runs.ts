/**
 * ToIV 智能体任务(agent-runs)客户端——融合 F2(2026-10-11)自经典 web 迁入 canvas:
 * 创建(大目标秒回 L0/L1/L2)/详情/计划编辑/确认门裁决/任务卡干预/取消/成片;
 * SSE 事件流 URL 带 token 查询参数(EventSource 无法带 Authorization 头)。
 * 类型与语义对齐经典 lib/api 的 agent-run 契约(后端零改动)。
 */
import { toivHttp } from "./client";

const TOKEN_KEY = "toiv_token";

// ---- 类型(契约对齐 apps/web lib/api §agent-runs) ----

export type AgentRunStatus =
    | "planning"
    | "awaiting_confirm"
    | "running"
    | "awaiting_assembly"
    | "done"
    | "error"
    | "canceled";

export type AgentTaskStatus =
    | "pending"
    | "queued"
    | "running"
    | "verifying"
    | "rejected"
    | "approved"
    | "done"
    | "error";

export interface AgentPlanTask {
    id: string;
    kind: string;
    title: string;
    depends_on: string[];
    status: AgentTaskStatus;
}

export interface AgentRunTask extends AgentPlanTask {
    attempt: number;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    verdict: string;
    gpu_hint: string;
}

export interface AgentRunAckL0 {
    level: "L0";
    ack: string;
    run_id: null;
}

export interface AgentRunAckPlanned {
    level: "L1" | "L2";
    ack: string;
    run_id: string;
    plan?: { tasks: AgentPlanTask[] };
}

export type AgentRunCreateResult = AgentRunAckL0 | AgentRunAckPlanned;

export interface AgentRunSummary {
    id: string;
    level: string;
    goal: string;
    status: AgentRunStatus;
    created_at: string;
    task_counts: { total: number; done: number; error: number };
}

export interface AgentRunDetail {
    id: string;
    goal: string;
    level: string;
    status: AgentRunStatus;
    error: string;
    plan: AgentRunTask[];
    created_at: string;
    updated_at: string;
}

export interface AgentPlanEditOp {
    id: string;
    action: "update" | "remove" | "add";
    title?: string;
    input?: Record<string, unknown>;
}

export interface AgentResumeBody {
    gate: "plan" | "assembly";
    action: "approve" | "modify" | "reject";
    feedback?: string;
}

export interface AgentTaskActionBody {
    action: "edit" | "regenerate" | "approve" | "upload" | "reprompt";
    payload?: Record<string, unknown>;
}

export interface AgentRunResult {
    final_url: string;
    duration_sec: number;
    tasks: AgentRunTask[];
}

// ---- API ----

export async function createAgentRun(body: { goal: string; level?: string }): Promise<AgentRunCreateResult> {
    const { data } = await toivHttp.post("/agent-runs", body, { timeout: 30_000 });
    return data;
}

export async function fetchAgentRun(runId: string): Promise<AgentRunDetail> {
    const { data } = await toivHttp.get(`/agent-runs/${encodeURIComponent(runId)}`);
    return data;
}

export async function updateAgentRunPlan(runId: string, ops: AgentPlanEditOp[]): Promise<void> {
    await toivHttp.post(`/agent-runs/${encodeURIComponent(runId)}/plan`, { ops });
}

export async function resumeAgentRun(runId: string, body: AgentResumeBody): Promise<void> {
    await toivHttp.post(`/agent-runs/${encodeURIComponent(runId)}/resume`, body);
}

export async function agentTaskAction(
    runId: string,
    taskId: string,
    body: AgentTaskActionBody,
): Promise<AgentRunTask | null> {
    const { data } = await toivHttp.post(
        `/agent-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/action`,
        body,
    );
    return (data as AgentRunTask | null) ?? null;
}

export async function uploadAgentTaskAsset(runId: string, taskId: string, file: File): Promise<AgentRunTask | null> {
    const form = new FormData();
    form.append("file", file);
    const { data } = await toivHttp.post(
        `/agent-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/upload`,
        form,
        { timeout: 120_000 },
    );
    return (data as AgentRunTask | null) ?? null;
}

export async function cancelAgentRun(runId: string): Promise<void> {
    await toivHttp.post(`/agent-runs/${encodeURIComponent(runId)}/cancel`);
}

export async function fetchAgentRunResult(runId: string): Promise<AgentRunResult> {
    const { data } = await toivHttp.get(`/agent-runs/${encodeURIComponent(runId)}/result`);
    return data;
}

/** SSE 事件流地址(EventSource 用;token 走查询参数,与媒体 URL 同机制)。 */
export function agentRunEventsUrl(runId: string, after = 0): string {
    const qs = new URLSearchParams({ after: String(after) });
    const token = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : "";
    const path = `/api/agent-runs/${encodeURIComponent(runId)}/events?${qs.toString()}`;
    return token ? `${path}&token=${encodeURIComponent(token)}` : path;
}

/** 媒体产物地址(<img>/<video> 无法带 Authorization;token 查询参数补认证)。 */
export function toivMediaUrl(path: string): string {
    if (!path) return path;
    if (!path.startsWith("/api") && !path.startsWith("/")) return path;
    const token = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : "";
    const joined = path.startsWith("/") ? path : `/${path}`;
    return token ? `${joined}${joined.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : joined;
}

// ---- 展示元数据(移植经典 agentRunMeta) ----

export type RunTone = "neutral" | "loading" | "success" | "error" | "warning";

const RUN_TONE_MAP: Record<string, RunTone> = {
    neutral: "neutral",
    accent: "loading",
    ok: "success",
    warn: "warning",
    err: "error",
};

export const RUN_STATUS_META: Record<string, { label: string; tone: RunTone }> = {
    planning: { label: "规划中", tone: "loading" },
    awaiting_confirm: { label: "待确认计划", tone: "warning" },
    running: { label: "执行中", tone: "loading" },
    awaiting_assembly: { label: "待确认合成", tone: "warning" },
    done: { label: "已完成", tone: "success" },
    error: { label: "出错", tone: "error" },
    canceled: { label: "已取消", tone: "neutral" },
};

export function runStatusMeta(status: string): { label: string; tone: RunTone } {
    return RUN_STATUS_META[status] ?? { label: status || "未知", tone: "neutral" };
}

export const RUN_TERMINAL = new Set(["done", "error", "canceled"]);

const TASK_TONE_MAP: Record<string, RunTone> = {
    pending: "neutral",
    queued: "neutral",
    running: "loading",
    verifying: "warning",
    rejected: "error",
    approved: "success",
    done: "success",
    error: "error",
};

const TASK_LABEL_MAP: Record<string, string> = {
    pending: "排队中",
    queued: "已入队",
    running: "生成中",
    verifying: "验收中",
    rejected: "被打回",
    approved: "已通过",
    done: "完成",
    error: "失败",
};

export function taskStatusMeta(status: string): { label: string; tone: RunTone } {
    return { label: TASK_LABEL_MAP[status] ?? status ?? "未知", tone: TASK_TONE_MAP[status] ?? "neutral" };
}

export const TASK_KIND_LABEL: Record<string, string> = {
    script: "剧本",
    storyboard: "分镜",
    image: "图像",
    video: "视频",
    audio: "音频",
    subtitle: "字幕",
    verify: "验收",
    assemble: "合成",
};

export function taskKindLabel(kind: string): string {
    return TASK_KIND_LABEL[kind] ?? kind;
}

/** 主文案字段(input 里第一个命中的字符串键,编辑回写用同键)。 */
export function primaryInputText(input: Record<string, unknown> | null | undefined): { key: string; value: string } {
    if (input && typeof input === "object") {
        for (const k of ["prompt", "text", "script", "description", "content"]) {
            const v = input[k];
            if (typeof v === "string") return { key: k, value: v };
        }
    }
    return { key: "prompt", value: "" };
}

export function taskDurationSec(task: AgentRunTask): number {
    const v = task.input?.duration_sec;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Markdown 噪声剥离(标题单行展示用)。 */
export function stripMarkdown(text: unknown): string {
    if (typeof text !== "string") return "";
    return text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
        .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/\s+/g, " ")
        .trim();
}

export interface TaskMedia {
    kind: "none" | "video" | "image" | "audio" | "text";
    src: string;
    text: string;
}

/** 产物媒体提取(video_url/image_url/audio_url/url/urls/text 按序命中)。 */
export function extractTaskMedia(output: Record<string, unknown> | null | undefined): TaskMedia {
    if (!output || typeof output !== "object") return { kind: "none", src: "", text: "" };
    const pick = (...keys: string[]): string => {
        for (const k of keys) {
            const v = output[k];
            if (typeof v === "string" && v) return v;
        }
        return "";
    };
    const video = pick("video_url", "video");
    if (video) return { kind: "video", src: video, text: "" };
    const image = pick("image_url", "image", "thumbnail");
    if (image) return { kind: "image", src: image, text: "" };
    const audio = pick("audio_url", "audio", "voice_url");
    if (audio) return { kind: "audio", src: audio, text: "" };
    const url = pick("url");
    if (url) {
        if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return { kind: "video", src: url, text: "" };
        if (/\.(wav|mp3|flac|ogg|m4a)(\?|$)/i.test(url)) return { kind: "audio", src: url, text: "" };
        return { kind: "image", src: url, text: "" };
    }
    const urls = output.urls;
    if (Array.isArray(urls) && urls.length > 0 && typeof urls[0] === "string") {
        return extractTaskMedia({ url: urls[0] });
    }
    const text = pick("text", "content", "script");
    if (text) return { kind: "text", src: "", text };
    return { kind: "none", src: "", text: "" };
}

/** verdict 归一(string 直返;对象取首个字符串字段;空对象归空)。 */
export function verdictText(v: unknown): string {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const k of ["summary", "reason", "text", "error", "message"]) {
            const s = (v as Record<string, unknown>)[k];
            if (typeof s === "string" && s.trim()) return s;
        }
        if (Object.keys(v as object).length === 0) return "";
        try {
            return JSON.stringify(v);
        } catch {
            return "";
        }
    }
    return "";
}

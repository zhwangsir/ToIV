import { ArrowLeft, Ban, Loader2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { Button } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppModal } from "@/components/ui/product/app-modal";
import { Callout } from "@/components/ui/product/callout";
import { EmptyState } from "@/components/ui/product/empty-state";
import { WorkspacePage } from "@/components/layout/workspace-page";
import {
    agentRunEventsUrl,
    agentTaskAction,
    cancelAgentRun,
    extractTaskMedia,
    fetchAgentRun,
    fetchAgentRunResult,
    primaryInputText,
    resumeAgentRun,
    runStatusMeta,
    RUN_TERMINAL,
    stripMarkdown,
    taskDurationSec,
    taskKindLabel,
    taskStatusMeta,
    toivMediaUrl,
    updateAgentRunPlan,
    uploadAgentTaskAsset,
    verdictText,
    type AgentPlanEditOp,
    type AgentResumeBody,
    type AgentRunDetail,
    type AgentRunResult,
    type AgentRunTask,
} from "@/services/toiv/agent-runs";

/**
 * 智能体任务详情(融合 F2,自经典 /agent-runs/[runId] 迁入):
 * SSE 实时事件流(断线退避重连 ≤5 次,超限降级 5s 轮询) + 计划确认门(增删改+approve/modify/reject)
 * + 任务卡片干预(approve/regenerate/edit/upload) + 合成确认门 + 成片播放。
 */

type SseState = "connecting" | "open" | "reconnecting" | "polling" | "closed";

interface EventItem {
    id: number;
    ts: number;
    text: string;
    tone: "start" | "blocked" | "decision" | "done" | "info" | "error";
}

const BUSINESS_EVENTS = [
    "ack",
    "plan",
    "task_status",
    "verdict",
    "confirm_required",
    "blocked",
    "decision_required",
    "done",
] as const;

const EVENT_TONE_CLASS: Record<EventItem["tone"], string> = {
    start: "bg-blue-500",
    blocked: "bg-amber-500",
    decision: "bg-violet-500",
    done: "bg-emerald-500",
    info: "bg-foreground/30",
    error: "bg-red-500",
};

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

function extractPlanTasks(data: Record<string, unknown>): AgentRunTask[] | null {
    const direct = data.tasks;
    if (Array.isArray(direct)) return direct as AgentRunTask[];
    const nested = data.plan;
    if (nested && typeof nested === "object") {
        const t = (nested as { tasks?: unknown }).tasks;
        if (Array.isArray(t)) return t as AgentRunTask[];
    }
    return null;
}

function mergeTaskStatus(d: AgentRunDetail | null, data: Record<string, unknown>): AgentRunDetail | null {
    if (!d) return d;
    const tid = str(data.task_id) || str(data.id);
    if (!tid) return d;
    const plan = d.plan.map((t) => {
        if (t.id !== tid) return t;
        const next: AgentRunTask = { ...t };
        if (typeof data.status === "string" && data.status) next.status = data.status as AgentRunTask["status"];
        if (typeof data.attempt === "number") next.attempt = data.attempt;
        if (data.output && typeof data.output === "object") next.output = data.output as Record<string, unknown>;
        if (typeof data.verdict === "string") next.verdict = data.verdict;
        if (typeof data.gpu_hint === "string") next.gpu_hint = data.gpu_hint;
        return next;
    });
    return { ...d, plan };
}

// ── 计划确认门(增删改 + 确认/打回) ──

interface PlanDraft {
    edits: Record<string, { title?: string; inputText?: string; inputKey?: string }>;
    removed: string[];
    added: { id: string; title: string; inputText: string }[];
}

function PlanGate({
    tasks,
    busy,
    onSavePlan,
    onResume,
}: {
    tasks: AgentRunTask[];
    busy: Record<string, boolean>;
    onSavePlan: (ops: AgentPlanEditOp[]) => Promise<void>;
    onResume: (gate: AgentResumeBody["gate"], action: AgentResumeBody["action"], feedback?: string) => Promise<void>;
}) {
    const [draft, setDraft] = useState<PlanDraft>({ edits: {}, removed: [], added: [] });
    const [addSeq, setAddSeq] = useState(1);
    const [rejecting, setRejecting] = useState(false);
    const [feedback, setFeedback] = useState("");
    const submitting = busy["plan"] || busy["resume:plan"] === true;
    const visibleTasks = tasks.filter((t) => !draft.removed.includes(t.id));
    const orderOf = (id: string): number => tasks.findIndex((t) => t.id === id) + 1;

    const patchEdit = (id: string, patch: Partial<{ title: string; inputText: string; inputKey: string }>) =>
        setDraft((d) => ({ ...d, edits: { ...d.edits, [id]: { ...d.edits[id], ...patch } } }));
    const editOf = (t: AgentRunTask) => {
        const e = draft.edits[t.id];
        const primary = primaryInputText(t.input);
        return { title: e?.title ?? t.title, inputText: e?.inputText ?? primary.value, inputKey: e?.inputKey ?? primary.key };
    };

    const buildOps = (): AgentPlanEditOp[] => {
        const ops: AgentPlanEditOp[] = [];
        for (const t of tasks) {
            if (draft.removed.includes(t.id)) {
                ops.push({ id: t.id, action: "remove" });
                continue;
            }
            const e = draft.edits[t.id];
            if (!e) continue;
            const op: AgentPlanEditOp = { id: t.id, action: "update" };
            if (e.title !== undefined) op.title = e.title;
            if (e.inputText !== undefined) op.input = { ...t.input, [e.inputKey ?? primaryInputText(t.input).key]: e.inputText };
            ops.push(op);
        }
        for (const a of draft.added) {
            ops.push({ id: a.id, action: "add", title: a.title.trim() || "新任务", input: { prompt: a.inputText } });
        }
        return ops;
    };

    const confirm = async () => {
        const ops = buildOps();
        try {
            if (ops.length > 0) await onSavePlan(ops);
            await onResume("plan", ops.length > 0 ? "modify" : "approve");
        } catch {
            /* hook 已透出错误 */
        }
    };

    return (
        <section className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/5 p-4" aria-label="计划确认门">
            <header className="flex flex-col gap-1">
                <h2 className="text-base font-semibold leading-6">执行计划(确认后开始生成)</h2>
                <p className="text-xs text-muted-foreground">可改标题/文案、删任务、加任务;确认后按计划执行,关键节点会再找你</p>
            </header>
            <ol className="flex flex-col gap-3">
                {visibleTasks.map((t) => {
                    const e = editOf(t);
                    const ord = orderOf(t.id);
                    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
                    return (
                        <li key={t.id} className="flex gap-3 rounded-lg border bg-background p-3">
                            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium tabular-nums" aria-hidden>{ord}</span>
                            <div className="flex min-w-0 flex-1 flex-col gap-2">
                                <div className="flex items-center gap-2">
                                    <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs">{taskKindLabel(t.kind)}</span>
                                    <input
                                        className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
                                        value={e.title}
                                        placeholder="任务标题"
                                        onChange={(ev) => patchEdit(t.id, { title: ev.target.value })}
                                    />
                                    <button type="button" className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="删除该任务" onClick={() => setDraft((d) => ({ ...d, removed: [...d.removed, t.id] }))}>
                                        <Trash2 className="size-4" />
                                    </button>
                                </div>
                                {deps.length > 0 && (
                                    <p className="text-xs text-muted-foreground">
                                        依赖 {deps.map((d) => { const n = orderOf(d); return n > 0 ? `第 ${n} 步` : d; }).join("、")}
                                    </p>
                                )}
                                <textarea
                                    className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm"
                                    rows={2}
                                    value={e.inputText}
                                    placeholder="该任务的提示词/文案"
                                    onChange={(ev) => patchEdit(t.id, { inputText: ev.target.value, inputKey: e.inputKey })}
                                />
                            </div>
                        </li>
                    );
                })}
                {draft.added.map((a) => (
                    <li key={a.id} className="flex gap-3 rounded-lg border border-dashed bg-background p-3">
                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-xs" aria-hidden>+</span>
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                            <div className="flex items-center gap-2">
                                <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs">新任务</span>
                                <input
                                    className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
                                    value={a.title}
                                    placeholder="任务标题"
                                    onChange={(ev) => setDraft((d) => ({ ...d, added: d.added.map((x) => (x.id === a.id ? { ...x, title: ev.target.value } : x)) }))}
                                />
                                <button type="button" className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="移除该行" onClick={() => setDraft((d) => ({ ...d, added: d.added.filter((x) => x.id !== a.id) }))}>
                                    <Trash2 className="size-4" />
                                </button>
                            </div>
                            <textarea
                                className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm"
                                rows={2}
                                value={a.inputText}
                                placeholder="该任务的提示词/文案"
                                onChange={(ev) => setDraft((d) => ({ ...d, added: d.added.map((x) => (x.id === a.id ? { ...x, inputText: ev.target.value } : x)) }))}
                            />
                        </div>
                    </li>
                ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
                <ToolButton variant="default" icon={<Plus className="size-4" />} label="加任务" disabled={submitting} onClick={() => { setDraft((d) => ({ ...d, added: [...d.added, { id: `new-${addSeq}`, title: "", inputText: "" }] })); setAddSeq((n) => n + 1); }} />
                <span className="flex-1" />
                {rejecting ? (
                    <>
                        <textarea
                            className="min-w-48 flex-1 resize-y rounded-md border bg-background px-2 py-1.5 text-sm"
                            rows={1}
                            value={feedback}
                            placeholder="打回原因(方向性批注,可选)"
                            onChange={(e) => setFeedback(e.target.value)}
                        />
                        <Button danger size="small" disabled={submitting} onClick={() => void onResume("plan", "reject", feedback.trim() || undefined).catch(() => {})}>
                            确认打回
                        </Button>
                        <Button size="small" onClick={() => setRejecting(false)}>返回</Button>
                    </>
                ) : (
                    <>
                        <ToolButton variant="default" label="打回" disabled={submitting} onClick={() => setRejecting(true)} />
                        <Button
                            type="primary"
                            size="small"
                            disabled={submitting || visibleTasks.length + draft.added.length === 0}
                            onClick={() => void confirm()}
                        >
                            确认执行
                        </Button>
                    </>
                )}
            </div>
        </section>
    );
}

// ── 任务卡片 ──

function TaskCard({
    task,
    ordinal,
    orderOf,
    busy,
    onAction,
    onUpload,
}: {
    task: AgentRunTask;
    ordinal: number;
    orderOf: (id: string) => number;
    busy: Record<string, boolean>;
    onAction: (tid: string, action: "edit" | "regenerate" | "approve", payload?: Record<string, unknown>) => Promise<AgentRunTask | null | void>;
    onUpload: (tid: string, file: File) => Promise<void>;
}) {
    const meta = taskStatusMeta(task.status);
    const media = extractTaskMedia(task.output);
    const verdict = verdictText(task.verdict);
    const dependsOn = Array.isArray(task.depends_on) ? task.depends_on : [];
    const inflight = task.status === "running" || task.status === "queued";
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [guiding, setGuiding] = useState(false);
    const [guidance, setGuidance] = useState("");
    const primary = primaryInputText(task.input);
    const cardBusy = (a: string) => busy[`task:${task.id}:${a}`] === true;

    return (
        <li className="flex flex-col gap-2 rounded-xl border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium tabular-nums" aria-hidden>{ordinal}</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-xs">{taskKindLabel(task.kind)}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={task.title}>{task.title || task.id}</span>
                <StatusBadge tone={meta.tone} label={meta.label} />
                {task.attempt > 1 && <span className="text-xs text-muted-foreground">第 {task.attempt} 次</span>}
            </div>
            {dependsOn.length > 0 && (
                <p className="text-xs text-muted-foreground">
                    依赖 {dependsOn.map((d) => { const n = orderOf(d); return n > 0 ? `第 ${n} 步` : d; }).join("、")}
                </p>
            )}
            {media.kind === "video" && <video src={toivMediaUrl(media.src)} controls muted playsInline className="max-h-72 w-full rounded-lg bg-black/5" />}
            {media.kind === "image" && <img src={toivMediaUrl(media.src)} alt={task.title || task.kind} className="max-h-72 w-full rounded-lg object-contain" loading="lazy" />}
            {media.kind === "audio" && <audio src={toivMediaUrl(media.src)} controls className="w-full" />}
            {media.kind === "text" && media.text && (
                <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-secondary/50 p-2 text-xs leading-5">{media.text}</p>
            )}
            {verdict && <p className="text-xs leading-5 text-muted-foreground">验收:{verdict}</p>}
            {task.gpu_hint && <p className="text-xs text-muted-foreground">{task.gpu_hint}</p>}
            {editing && (
                <div className="flex flex-col gap-2 rounded-lg border p-2">
                    <textarea className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="改该任务的提示词/文案" />
                    <div className="flex gap-2">
                        <Button
                            type="primary"
                            size="small"
                            disabled={cardBusy("edit")}
                            onClick={() => void onAction(task.id, "edit", { input: { ...task.input, [primary.key]: draft } }).then(() => setEditing(false)).catch(() => {})}
                        >
                            保存文案
                        </Button>
                        <Button size="small" onClick={() => setEditing(false)}>取消</Button>
                    </div>
                </div>
            )}
            {guiding && (
                <div className="flex flex-col gap-2 rounded-lg border p-2">
                    <textarea className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm" rows={2} value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder="重生成引导词(可选:告诉它这次要怎么改)" />
                    <div className="flex gap-2">
                        <Button
                            type="primary"
                            size="small"
                            disabled={cardBusy("regenerate")}
                            onClick={() => void onAction(task.id, "regenerate", guidance.trim() ? { guidance: guidance.trim() } : {}).then(() => { setGuiding(false); setGuidance(""); }).catch(() => {})}
                        >
                            {cardBusy("regenerate") ? "重生成中…" : "确认重生成"}
                        </Button>
                        <Button size="small" onClick={() => setGuiding(false)}>取消</Button>
                    </div>
                </div>
            )}
            {!inflight && (
                <div className="flex flex-wrap gap-2">
                    {(task.status === "rejected" || task.status === "pending" || task.status === "verifying") && (
                        <ToolButton variant="default" label="通过" disabled={cardBusy("approve")} onClick={() => void onAction(task.id, "approve").catch(() => {})} />
                    )}
                    <ToolButton variant="default" label="重生成" disabled={cardBusy("regenerate")} onClick={() => { setDraft(primary.value); setEditing(false); setGuiding(true); }} />
                    <ToolButton variant="default" label="改文案" onClick={() => { setDraft(primary.value); setGuiding(false); setEditing(true); }} />
                    {task.kind !== "assemble" && (
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-surface-hover">
                            <Upload className="size-4" />
                            <span>{cardBusy("upload") ? "上传中…" : "换产物"}</span>
                            <input
                                type="file"
                                className="hidden"
                                accept="image/*,video/*,audio/*"
                                disabled={cardBusy("upload")}
                                onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    e.target.value = "";
                                    if (f) void onUpload(task.id, f).catch(() => {});
                                }}
                            />
                        </label>
                    )}
                </div>
            )}
        </li>
    );
}

// ── 页面 ──

export function ToivAgentRunDetailPage() {
    const { runId = "" } = useParams();
    const [detail, setDetail] = useState<AgentRunDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [events, setEvents] = useState<EventItem[]>([]);
    const [sseState, setSseState] = useState<SseState>("connecting");
    const [assemblyGate, setAssemblyGate] = useState(false);
    const [result, setResult] = useState<AgentRunResult | null>(null);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [runErrorClosed, setRunErrorClosed] = useState(false);
    const [seq] = useState(() => ({ n: 0 }));

    const pushEvent = useCallback((text: string, tone: EventItem["tone"]) => {
        setEvents((prev) => [{ id: ++seq.n, ts: Date.now(), text, tone }, ...prev].slice(0, 100));
    }, [seq]);

    const refresh = useCallback(async (): Promise<AgentRunDetail | null> => {
        if (!runId) return null;
        try {
            const d = await fetchAgentRun(runId);
            setDetail(d);
            if (d.status === "awaiting_assembly") setAssemblyGate(true);
            return d;
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载任务详情失败");
            return null;
        }
    }, [runId]);

    // SSE 订阅 + 断线降级轮询(终态不订阅)
    useEffect(() => {
        if (!runId) return;
        let disposed = false;
        let stop: (() => void) | null = null;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;

        const onEvent = (type: string, data: Record<string, unknown>) => {
            switch (type) {
                case "ack":
                    pushEvent(str(data.ack) || str(data.message) || "已接单,Leader 拆解中", "start");
                    break;
                case "plan": {
                    const tasks = extractPlanTasks(data);
                    if (tasks) {
                        setDetail((d) => {
                            if (!d) return d;
                            const byId = new Map(d.plan.map((t) => [t.id, t]));
                            return { ...d, plan: tasks.map((b) => { const cur = byId.get(b.id); return cur ? { ...cur, ...b } : b; }) };
                        });
                    }
                    pushEvent(`计划已生成,共 ${tasks?.length ?? "?"} 步`, "info");
                    break;
                }
                case "task_status": {
                    setDetail((d) => mergeTaskStatus(d, data));
                    const status = str(data.status);
                    pushEvent(
                        `任务 ${str(data.task_id) || str(data.id)} ${taskStatusMeta(status).label}`,
                        status === "running" ? "start" : status === "done" || status === "approved" ? "done" : status === "error" || status === "rejected" ? "error" : "info",
                    );
                    break;
                }
                case "verdict":
                    setDetail((d) => mergeTaskStatus(d, data));
                    pushEvent(`验收意见:${str(data.verdict) || "已出具"}`, "info");
                    break;
                case "confirm_required": {
                    const gate = str(data.gate);
                    if (gate === "assembly") {
                        setAssemblyGate(true);
                        pushEvent("合成前确认门已打开,等你裁决", "decision");
                    } else {
                        setDetail((d) => (d ? { ...d, status: "awaiting_confirm" } : d));
                        pushEvent("计划确认门已打开,等你确认", "decision");
                        void refresh();
                    }
                    break;
                }
                case "blocked":
                    pushEvent(`遇到阻塞:${str(data.message) || "等待资源"}`, "blocked");
                    break;
                case "decision_required":
                    pushEvent(`需要决策:${str(data.message) || "请查看任务卡片"}`, "decision");
                    break;
                case "done":
                    setDetail((d) => (d ? { ...d, status: "done" } : d));
                    pushEvent("全部任务完成,成片已就绪", "done");
                    setSseState("closed");
                    break;
                case "error": {
                    const msg = str(data.message) || "运行出错";
                    console.error("[agent-run] 运行终态错误:", msg);
                    setDetail((d) => (d ? { ...d, status: "error", error: msg } : d));
                    pushEvent(msg, "error");
                    setSseState("closed");
                    break;
                }
            }
        };

        const startPolling = () => {
            if (pollTimer) return;
            const tick = async () => {
                if (disposed) return;
                const d = await refresh();
                if (disposed) return;
                if (d && RUN_TERMINAL.has(d.status)) {
                    pollTimer = null;
                    setSseState("closed");
                    return;
                }
                pollTimer = setTimeout(() => void tick(), 5_000);
            };
            pollTimer = setTimeout(() => void tick(), 5_000);
        };

        setLoading(true);
        void (async () => {
            const d = await refresh();
            if (disposed) return;
            setLoading(false);
            if (d && RUN_TERMINAL.has(d.status)) {
                setSseState("closed");
                return;
            }
            // SSE(EventSource 无法带 Authorization;token 走查询参数)
            let es: EventSource | null = null;
            let reconnect = 0;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const close = () => {
                disposed = true;
                es?.close();
                if (timer) clearTimeout(timer);
            };
            const connect = () => {
                if (disposed) return;
                es = new EventSource(agentRunEventsUrl(runId));
                es.addEventListener("open", () => { reconnect = 0; if (!disposed) setSseState("open"); });
                for (const t of BUSINESS_EVENTS) {
                    es.addEventListener(t, (e) => {
                        let data: Record<string, unknown> = {};
                        try { data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>; } catch { /* 畸形分片按空载荷 */ }
                        onEvent(t, data);
                        if (t === "done") close();
                    });
                }
                es.addEventListener("error", (e) => {
                    const payload = (e as MessageEvent).data;
                    if (payload) {
                        try { onEvent("error", JSON.parse(payload) as Record<string, unknown>); } catch { onEvent("error", { message: "运行出错" }); }
                        close();
                        return;
                    }
                    if (disposed) return;
                    es?.close();
                    if (reconnect >= 5) { setSseState("polling"); startPolling(); return; }
                    reconnect += 1;
                    setSseState("reconnecting");
                    timer = setTimeout(connect, Math.min(10_000, 1_000 * 2 ** (reconnect - 1)));
                });
            };
            setSseState("connecting");
            connect();
            stop = close;
        })();

        return () => {
            disposed = true;
            stop?.();
            if (pollTimer) clearTimeout(pollTimer);
        };
    }, [runId, refresh, pushEvent]);

    const withBusy = useCallback(async <T,>(key: string, label: string, fn: () => Promise<T>): Promise<T> => {
        setBusy((b) => ({ ...b, [key]: true }));
        try {
            return await fn();
        } catch (e) {
            console.error(`[agent-run] ${label}失败:`, e);
            setError(`${label}失败,请稍后重试`);
            throw e;
        } finally {
            setBusy((b) => ({ ...b, [key]: false }));
        }
    }, []);

    const savePlan = useCallback((ops: AgentPlanEditOp[]) =>
        withBusy("plan", "保存计划", async () => { await updateAgentRunPlan(runId, ops); await refresh(); }), [runId, withBusy, refresh]);

    const resume = useCallback((gate: AgentResumeBody["gate"], action: AgentResumeBody["action"], feedback?: string) =>
        withBusy(`resume:${gate}`, "提交裁决", async () => {
            await resumeAgentRun(runId, { gate, action, ...(feedback ? { feedback } : {}) });
            if (gate === "assembly") setAssemblyGate(false);
            await refresh();
        }), [runId, withBusy, refresh]);

    const taskAction = useCallback((tid: string, action: "edit" | "regenerate" | "approve", payload?: Record<string, unknown>) =>
        withBusy(`task:${tid}:${action}`, "任务操作", async () => {
            const res = await agentTaskAction(runId, tid, { action, ...(payload ? { payload } : {}) });
            if (res?.id) setDetail((d) => (d ? { ...d, plan: d.plan.map((t) => (t.id === tid ? res : t)) } : d));
            return res;
        }), [runId, withBusy]);

    const uploadTask = useCallback((tid: string, file: File) =>
        withBusy(`task:${tid}:upload`, "替换上传", async () => {
            const res = await uploadAgentTaskAsset(runId, tid, file);
            if (res?.id) setDetail((d) => (d ? { ...d, plan: d.plan.map((t) => (t.id === tid ? res : t)) } : d));
        }), [runId, withBusy]);

    const cancel = useCallback(() =>
        withBusy("cancel", "取消任务", async () => { await cancelAgentRun(runId); await refresh(); }), [runId, withBusy, refresh]);

    // 终态 done 拉成片
    const isDone = detail?.status === "done";
    useEffect(() => {
        if (!runId || !isDone) return;
        let disposed = false;
        fetchAgentRunResult(runId)
            .then((r) => { if (!disposed) setResult(r); })
            .catch((e) => { console.error("[agent-run] 加载成片失败:", e); if (!disposed) setError("加载成片失败,请稍后重试"); });
        return () => { disposed = true; };
    }, [runId, isDone]);

    const d = detail;
    const statusMeta = runStatusMeta(d?.status ?? "");
    const terminal = d ? RUN_TERMINAL.has(d.status) : false;
    const orderOf = (id: string): number => (d ? d.plan.findIndex((t) => t.id === id) + 1 : 0);

    return (
        <WorkspacePage fluid className="toiv-agent-run-page">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
                <header className="flex flex-wrap items-center gap-3">
                    <Link to="/toiv/tasks"><ToolButton variant="default" icon={<ArrowLeft className="size-4" />} label="任务列表" /></Link>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <h1 className="truncate text-xl font-semibold leading-7" title={stripMarkdown(d?.goal)}>
                            {stripMarkdown(d?.goal) || "智能体任务"}
                        </h1>
                        <div className="flex flex-wrap items-center gap-2">
                            {d && <span className="rounded bg-secondary px-1.5 py-0.5 text-xs">{d.level}</span>}
                            {d && <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />}
                        </div>
                    </div>
                    {d && !terminal && (
                        <Button danger size="small" icon={<Ban className="size-4" />} disabled={busy["cancel"]} onClick={() => setConfirmCancel(true)}>
                            {busy["cancel"] ? "取消中…" : "取消任务"}
                        </Button>
                    )}
                </header>

                {error && <Callout tone="error" title={error} onClose={() => setError(null)} />}

                {sseState === "reconnecting" && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                        <Loader2 className="size-4 animate-spin" /> 连接中断,重连中…
                    </p>
                )}
                {sseState === "polling" && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                        <RefreshCw className="size-4" /> 实时连接已断开,已切换为 5 秒轮询
                    </p>
                )}

                {loading && !d ? (
                    <EmptyState title="任务加载中…" />
                ) : !d ? (
                    <EmptyState title="任务详情加载失败" description="可返回任务列表重试" />
                ) : (
                    <>
                        {d.status === "error" && d.error && !runErrorClosed && (
                            <Callout tone="error" title="运行出错,请稍后重试" onClose={() => setRunErrorClosed(true)} />
                        )}

                        {d.status === "awaiting_confirm" && (
                            <PlanGate tasks={d.plan} busy={busy} onSavePlan={savePlan} onResume={resume} />
                        )}

                        {isDone && result?.final_url && (
                            <section className="flex flex-col gap-2 rounded-xl border p-4">
                                <h2 className="text-base font-semibold leading-6">成片</h2>
                                <video src={toivMediaUrl(result.final_url)} controls playsInline className="max-h-[480px] w-full rounded-lg bg-black/5" />
                                {result.duration_sec > 0 && <p className="text-sm text-muted-foreground">时长 {Math.round(result.duration_sec)}s</p>}
                            </section>
                        )}

                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                            <ol className="flex flex-col gap-3">
                                {d.plan.map((t, i) => (
                                    <TaskCard key={t.id} task={t} ordinal={i + 1} orderOf={orderOf} busy={busy} onAction={taskAction} onUpload={uploadTask} />
                                ))}
                                {d.plan.length === 0 && <EmptyState title="计划尚未生成" description="Leader 正在拆解目标,稍候…" />}
                            </ol>
                            <aside className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto rounded-xl border p-3" aria-label="事件汇报流">
                                <h2 className="text-sm font-semibold">事件流</h2>
                                {events.length === 0 && <p className="text-xs text-muted-foreground">暂无事件</p>}
                                <ul className="flex flex-col gap-2">
                                    {events.map((ev) => (
                                        <li key={ev.id} className="flex gap-2 text-xs leading-5">
                                            <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${EVENT_TONE_CLASS[ev.tone]}`} aria-hidden />
                                            <div className="flex min-w-0 flex-col">
                                                <span className="break-words">{ev.text}</span>
                                                <time className="text-muted-foreground/70">{new Date(ev.ts).toLocaleTimeString("zh-CN")}</time>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </aside>
                        </div>
                    </>
                )}

                {/* 合成确认门 */}
                <AppModal
                    open={assemblyGate}
                    title="合成前确认"
                    onCancel={() => setAssemblyGate(false)}
                    footer={null}
                    width={520}
                >
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">全部产物已就绪,确认后开始合成成片;打回可附原因让对应任务重做。</p>
                        <ul className="flex max-h-60 flex-col gap-1.5 overflow-y-auto rounded-lg border p-2 text-sm">
                            {(d?.plan ?? []).map((t, i) => {
                                const dur = taskDurationSec(t);
                                return (
                                    <li key={t.id} className="flex items-center gap-2">
                                        <span className="tabular-nums text-muted-foreground">{i + 1}.</span>
                                        <span className="min-w-0 flex-1 truncate" title={t.title}>{t.title || t.id}</span>
                                        <span className="text-xs text-muted-foreground">{taskKindLabel(t.kind)}</span>
                                        {dur > 0 && <span className="text-xs tabular-nums text-muted-foreground">{dur}s</span>}
                                    </li>
                                );
                            })}
                        </ul>
                        <AssemblyGateActions busy={busy} onResume={resume} />
                    </div>
                </AppModal>

                {/* 取消确认 */}
                <AppModal
                    open={confirmCancel}
                    title="取消任务"
                    onCancel={() => setConfirmCancel(false)}
                    footer={null}
                    width={420}
                >
                    <div className="flex flex-col gap-3">
                        <p className="text-sm">取消该任务?进行中的节点会按作业取消语义终止。</p>
                        <div className="flex justify-end gap-2">
                            <ToolButton variant="default" label="再想想" onClick={() => setConfirmCancel(false)} />
                            <Button danger size="small" disabled={busy["cancel"]} onClick={() => { setConfirmCancel(false); void cancel().catch(() => {}); }}>
                                {busy["cancel"] ? "取消中…" : "确认取消"}
                            </Button>
                        </div>
                    </div>
                </AppModal>
            </div>
        </WorkspacePage>
    );
}

function AssemblyGateActions({
    busy,
    onResume,
}: {
    busy: Record<string, boolean>;
    onResume: (gate: AgentResumeBody["gate"], action: AgentResumeBody["action"], feedback?: string) => Promise<void>;
}) {
    const [rejecting, setRejecting] = useState(false);
    const [feedback, setFeedback] = useState("");
    const submitting = busy["resume:assembly"] === true;
    if (rejecting) {
        return (
            <div className="flex flex-col gap-2">
                <textarea className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm" rows={2} value={feedback} placeholder="打回原因(会路由给对应任务重做)" onChange={(e) => setFeedback(e.target.value)} />
                <div className="flex justify-end gap-2">
                    <Button danger size="small" disabled={submitting} onClick={() => void onResume("assembly", "reject", feedback.trim() || undefined).catch(() => {})}>
                        确认打回
                    </Button>
                    <Button size="small" onClick={() => setRejecting(false)}>返回</Button>
                </div>
            </div>
        );
    }
    return (
        <div className="flex justify-end gap-2">
            <ToolButton variant="default" label="打回" disabled={submitting} onClick={() => setRejecting(true)} />
            <Button type="primary" size="small" disabled={submitting} onClick={() => void onResume("assembly", "approve").catch(() => {})}>
                确认合成
            </Button>
        </div>
    );
}

export default ToivAgentRunDetailPage;

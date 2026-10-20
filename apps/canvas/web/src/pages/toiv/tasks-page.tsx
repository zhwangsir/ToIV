import { ArrowLeft, Loader2, RefreshCw, Send, X } from "lucide-react";
import { Button } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { Tooltip } from "@/components/ui/base/tooltip";
import { Callout } from "@/components/ui/product/callout";
import { EmptyState } from "@/components/ui/product/empty-state";
import { formatTaskKind, generationTaskStatusLabel } from "@/lib/generation-task-display";
import { formatDateTime } from "@/lib/time-format";
import { listGenerationTasks, type GenerationTask } from "@/services/api/task-center";
import { cancelJob, fetchAgentRuns, fetchJobs, type ToivAgentRun, type ToivJob } from "@/services/toiv/client";
import { createAgentRun } from "@/services/toiv/agent-runs";
import { WorkspacePage } from "@/components/layout/workspace-page";

const STATUS_META: Record<string, { tone: "neutral" | "loading" | "success" | "error" | "warning"; text: string }> = {
    queued: { tone: "neutral", text: "排队中" },
    held: { tone: "warning", text: "等待资源" },
    running: { tone: "loading", text: "运行中" },
    done: { tone: "success", text: "已完成" },
    error: { tone: "error", text: "失败" },
    canceled: { tone: "neutral", text: "已取消" },
};

const CANCELABLE = new Set(["queued", "held", "running"]);

// 智能体任务状态原文(英文枚举)→与 STATUS_META 同口径中文,避免时间线上中英混排
const AGENT_RUN_STATUS_TEXT: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    done: "已完成",
    succeeded: "已完成",
    error: "失败",
    failed: "失败",
    canceled: "已取消",
    cancelled: "已取消",
};

type TimelineItem = {
    id: string;
    source: "toiv-job" | "canvas-task" | "agent-run";
    createdAt: string;
    title: string;
    detail: string;
    statusLabel: string;
    statusTone: "neutral" | "loading" | "success" | "error" | "warning";
    canCancel?: boolean;
    highlight?: boolean;
};

type SourceFilter = "all" | "toiv-job" | "canvas-task" | "agent-run";
type StatusFilter = "all" | "active" | "done" | "error";

const SOURCE_LABEL: Record<TimelineItem["source"], string> = {
    "toiv-job": "ToIV 作业",
    "canvas-task": "画布任务",
    "agent-run": "智能体任务",
};

const ACTIVE_TONES = new Set(["loading", "warning"]);

function promptSummary(prompt?: string): string {
    const text = (prompt || "").trim();
    if (!text) return "(无提示摘要)";
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function detailLine(job: ToivJob): string {
    const parts: string[] = [formatDateTime(job.created_at)];
    if (job.kind) parts.push(job.kind);
    const reason = (job.status === "held" ? job.hold_reason : job.error)?.trim();
    if (reason) parts.push(reason.length > 48 ? `${reason.slice(0, 48)}…` : reason);
    return parts.join(" · ");
}

function canvasStatusTone(task: GenerationTask): TimelineItem["statusTone"] {
    if (task.status === "succeeded") return "success";
    if (task.status === "failed") return "error";
    if (task.status === "running") return "loading";
    if (task.status === "cancelled") return "neutral";
    return "neutral";
}

function TaskTimelineSkeleton() {
    return (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="任务时间线加载中">
            {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                    <div className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--muted)]" />
                    <div className="h-16 flex-1 animate-pulse rounded-xl border border-border bg-card/60" />
                </div>
            ))}
        </div>
    );
}

export default function TasksPage() {
    const [searchParams] = useSearchParams();
    const focusJob = (searchParams.get("job") || "").trim();
    const fromMarket = searchParams.get("from") === "market";

    const [jobs, setJobs] = useState<ToivJob[]>([]);
    const [canvasTasks, setCanvasTasks] = useState<GenerationTask[]>([]);
    const [agentRuns, setAgentRuns] = useState<ToivAgentRun[]>([]);
    const [loading, setLoading] = useState(true);
    const [canvasLoading, setCanvasLoading] = useState(true);
    const [canvasError, setCanvasError] = useState(false);
    const [error, setError] = useState(false);
    const [cancelingId, setCancelingId] = useState<string | null>(null);
    const [cancelError, setCancelError] = useState<string | null>(null);
    // W1.5(2026-10-11):三源筛选 + 活跃任务 30s 轮询
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

    const loadJobs = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            setJobs(await fetchJobs());
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    const loadCanvas = useCallback(async () => {
        setCanvasLoading(true);
        setCanvasError(false);
        try {
            setCanvasTasks(await listGenerationTasks(40));
        } catch {
            setCanvasError(true);
            setCanvasTasks([]);
        } finally {
            setCanvasLoading(false);
        }
    }, []);

    const loadAgents = useCallback(async () => {
        try {
            setAgentRuns(await fetchAgentRuns(20));
        } catch {
            setAgentRuns([]);
        }
    }, []);

    const load = useCallback(async () => {
        await Promise.all([loadJobs(), loadCanvas(), loadAgents()]);
    }, [loadJobs, loadCanvas, loadAgents]);

    useEffect(() => {
        void load();
    }, [load]);

    const onCancel = async (jobId: string) => {
        setCancelingId(jobId);
        setCancelError(null);
        try {
            const ok = await cancelJob(jobId);
            if (ok) await loadJobs();
        } catch (e) {
            // 取消失败必须给反馈:此前异常被吞成 unhandled rejection,点了毫无动静
            setCancelError(e instanceof Error ? e.message : "取消失败，请稍后重试");
        } finally {
            setCancelingId(null);
        }
    };

    const timelineItemsRaw = useMemo((): TimelineItem[] => {
        const items: TimelineItem[] = [];
        for (const job of jobs) {
            const meta = STATUS_META[job.status] ?? { tone: "neutral" as const, text: job.status };
            items.push({
                id: job.id,
                source: "toiv-job",
                createdAt: job.created_at,
                title: promptSummary(job.prompt),
                detail: detailLine(job),
                statusLabel: meta.text,
                statusTone: meta.tone,
                canCancel: CANCELABLE.has(job.status),
                highlight: Boolean(focusJob && job.id === focusJob),
            });
        }
        for (const task of canvasTasks) {
            items.push({
                id: task.id,
                source: "canvas-task",
                createdAt: task.createdAt || "",
                title: promptSummary(task.prompt),
                detail: [formatDateTime(task.createdAt || ""), formatTaskKind(task)].filter(Boolean).join(" · "),
                statusLabel: generationTaskStatusLabel(task),
                statusTone: canvasStatusTone(task),
            });
        }
        for (const run of agentRuns) {
            const counts = run.task_counts;
            items.push({
                id: run.id,
                source: "agent-run",
                createdAt: run.created_at || "",
                title: run.goal?.trim() || `智能体任务 ${run.level || ""}`.trim(),
                detail: [
                    formatDateTime(run.created_at || ""),
                    counts ? `子任务 ${counts.done}/${counts.total}${counts.error ? ` · 失败 ${counts.error}` : ""}` : "",
                ]
                    .filter(Boolean)
                    .join(" · "),
                statusLabel: AGENT_RUN_STATUS_TEXT[run.status] ?? run.status,
                statusTone:
                    run.status === "done" || run.status === "succeeded"
                        ? "success"
                        : run.status === "error" || run.status === "failed"
                          ? "error"
                          : run.status === "running"
                            ? "loading"
                            : "neutral",
            });
        }
        items.sort((a, b) => {
            const ta = new Date(a.createdAt).getTime();
            const tb = new Date(b.createdAt).getTime();
            const na = Number.isFinite(ta) ? ta : 0;
            const nb = Number.isFinite(tb) ? tb : 0;
            return nb - na;
        });
        return items;
    }, [jobs, canvasTasks, agentRuns, focusJob]);

    const timeline = useMemo(() => {
        return timelineItemsRaw.filter((i) => {
            if (sourceFilter !== "all" && i.source !== sourceFilter) return false;
            if (statusFilter === "active") return ACTIVE_TONES.has(i.statusTone);
            if (statusFilter === "done") return i.statusTone === "success";
            if (statusFilter === "error") return i.statusTone === "error";
            return true;
        });
    }, [timelineItemsRaw, sourceFilter, statusFilter]);

    // W1.5:存在活跃任务时 30s 自动轮询(静默,不转圈)
    const hasActive = useMemo(
        () => timelineItemsRaw.some((i) => ACTIVE_TONES.has(i.statusTone)),
        [timelineItemsRaw],
    );
    const loadRef = useRef(load);
    loadRef.current = load;
    useEffect(() => {
        if (!hasActive) return;
        const t = setInterval(() => void loadRef.current(), 30_000);
        return () => clearInterval(t);
    }, [hasActive]);

    // F2:大目标直建智能体任务(L0 秒回转对话;L1/L2 进详情等计划)
    const navigate = useNavigate();
    const [goal, setGoal] = useState("");
    const [creating, setCreating] = useState(false);
    const [createNote, setCreateNote] = useState<string | null>(null);
    const submitGoal = useCallback(async () => {
        const trimmed = goal.trim();
        if (!trimmed || creating) return;
        setCreating(true);
        setCreateNote(null);
        try {
            const res = await createAgentRun({ goal: trimmed });
            setGoal("");
            if (res.level === "L0" || !res.run_id) {
                setCreateNote(res.ack || "已转交智能体对话,简单问题直接聊即可");
            } else {
                navigate(`/toiv/runs/${encodeURIComponent(res.run_id)}`);
            }
        } catch (e) {
            setCreateNote(e instanceof Error ? e.message : "创建失败,请稍后重试");
        } finally {
            setCreating(false);
        }
    }, [goal, creating, navigate]);

    const showSkeleton = loading && canvasLoading;
    const empty = !loading && !error && timeline.length === 0 && !canvasLoading;

    return (
        <WorkspacePage fluid className="toiv-tasks-page">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
            <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">任务中心</h1>
                    <p className="text-xs leading-5 text-muted-foreground">
                        统一任务时间线：ToIV 作业、画布生成任务与智能体任务；
                        有进行中任务时每 30 秒自动刷新。
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading || canvasLoading} />
                    <Link to="/">
                        <ToolButton variant="default" icon={<ArrowLeft />} label="返回首页" />
                    </Link>
                </div>
            </header>

            {fromMarket && focusJob && (
                <Callout tone="info" title="来自应用市场">
                    已定位作业 {focusJob.slice(0, 8)}…；时间线按创建时间倒序。
                </Callout>
            )}

            <section className="flex flex-col gap-2 rounded-xl border bg-card p-3" aria-label="新建智能体任务">
                <textarea
                    className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
                    rows={2}
                    value={goal}
                    placeholder="一句话描述你的需求,例如:拍一支 30 秒的咖啡店开业宣传短片,温暖治愈风,配轻爵士背景乐(⌘/Ctrl+Enter 直接创建)"
                    onChange={(e) => setGoal(e.target.value)}
                    onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submitGoal();
                    }}
                />
                <div className="flex items-center gap-2">
                    <span className="flex-1 text-xs text-muted-foreground">复杂目标会先出执行计划等你确认;简单问题直链智能体对话。</span>
                    <Button type="primary" size="small" icon={<Send className="size-3.5" />} loading={creating} disabled={!goal.trim()} onClick={() => void submitGoal()}>
                        创建并拆解
                    </Button>
                </div>
                {createNote && <Callout tone="info" title={createNote} onClose={() => setCreateNote(null)} />}
            </section>

            <div className="flex flex-wrap items-center gap-2" aria-label="任务筛选">
                {(
                    [
                        ["all", `全部 ${timelineItemsRaw.length}`],
                        ["toiv-job", `ToIV 作业 ${timelineItemsRaw.filter((i) => i.source === "toiv-job").length}`],
                        ["canvas-task", `画布任务 ${timelineItemsRaw.filter((i) => i.source === "canvas-task").length}`],
                        ["agent-run", `智能体 ${timelineItemsRaw.filter((i) => i.source === "agent-run").length}`],
                    ] as Array<[SourceFilter, string]>
                ).map(([key, label]) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setSourceFilter(key)}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                            sourceFilter === key
                                ? "border-[var(--workspace-accent)] bg-[var(--surface-active)]"
                                : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--workspace-accent)]"
                        }`}
                    >
                        {label}
                    </button>
                ))}
                <span className="ml-2 flex items-center gap-1">
                    {(
                        [
                            ["all", "全部状态"],
                            ["active", "进行中"],
                            ["done", "已完成"],
                            ["error", "失败"],
                        ] as Array<[StatusFilter, string]>
                    ).map(([key, label]) => (
                        <button
                            key={key}
                            type="button"
                            onClick={() => setStatusFilter(key)}
                            className={`rounded-md px-2 py-1 text-xs transition-colors ${
                                statusFilter === key
                                    ? "bg-[var(--surface-active)] text-foreground"
                                    : "text-[var(--muted-foreground)] hover:text-foreground"
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </span>
                {hasActive && (
                    <span className="ml-auto flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                        <Loader2 className="size-3 animate-spin" aria-hidden /> 自动刷新中
                    </span>
                )}
            </div>

            {cancelError && (
                <Callout tone="warning" title="取消失败" onClose={() => setCancelError(null)}>
                    {cancelError}
                </Callout>
            )}

            {showSkeleton ? (
                <TaskTimelineSkeleton />
            ) : error && timeline.length === 0 ? (
                <EmptyState description="读取失败，请刷新重试" />
            ) : empty ? (
                <div className="flex flex-col gap-3">
                    <EmptyState description="还没有生成作业" />
                    <p className="text-center text-xs text-muted-foreground">从应用市场运行，或在画布提交生成后，会在此时间线汇合。</p>
                </div>
            ) : (
                <section className="flex flex-col gap-1" aria-label="统一任务时间线">
                    {error && (
                        <Callout tone="warning" title="ToIV 作业读取失败">
                            仍尝试展示画布任务；可刷新重试。
                        </Callout>
                    )}
                    {canvasError && (
                        <Callout tone="info" title="画布任务暂不可用">
                            GenerationTask 列表未拉到（可能未登录画布平面）；ToIV 作业时间线仍可用。
                        </Callout>
                    )}
                    <ol className="relative flex flex-col gap-0 border-l border-[var(--border)] pl-4">
                        {timeline.map((item) => (
                            <li
                                key={`${item.source}:${item.id}`}
                                id={item.source === "toiv-job" ? `job-${item.id}` : `canvas-${item.id}`}
                                className={`relative -ml-4 mb-2 flex gap-3 rounded-xl border px-3 py-3 pl-4 ${
                                    item.highlight
                                        ? "border-[var(--workspace-accent)] bg-[var(--surface-active)]"
                                        : "border-border bg-card"
                                }`}
                            >
                                <span
                                    className="absolute -left-[5px] top-5 h-2.5 w-2.5 rounded-full border border-border bg-[var(--workspace-accent)]"
                                    aria-hidden
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="mb-1 flex flex-wrap items-center gap-2">
                                        <StatusBadge tone={item.statusTone} label={item.statusLabel} />
                                        <StatusBadge
                                            variant="filled"
                                            tone="neutral"
                                            label={SOURCE_LABEL[item.source]}
                                            size="sm"
                                        />
                                        <StatusBadge variant="filled" tone="neutral" label={item.id.slice(0, 8)} size="sm" />
                                    </div>
                                    <Tooltip title={item.title}>
                                        {item.source === "agent-run" ? (
                                            <Link to={`/toiv/runs/${encodeURIComponent(item.id)}`} className="truncate text-sm font-medium underline-offset-2 hover:underline">
                                                {item.title}
                                            </Link>
                                        ) : (
                                            <p className="truncate text-sm font-medium">{item.title}</p>
                                        )}
                                    </Tooltip>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
                                </div>
                                {item.canCancel ? (
                                    <ToolButton
                                        variant="ghost"
                                        size="sm"
                                        tone="danger"
                                        icon={<X />}
                                        label="取消"
                                        loading={cancelingId === item.id}
                                        onClick={() => void onCancel(item.id)}
                                    />
                                ) : null}
                            </li>
                        ))}
                    </ol>
                    {canvasLoading && (
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" /> 正在合并画布任务…
                        </p>
                    )}
                </section>
            )}
        </div>
        </WorkspacePage>
    );
}

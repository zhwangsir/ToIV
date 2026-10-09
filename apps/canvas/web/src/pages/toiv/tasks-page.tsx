import { ArrowLeft, ListChecks, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { Tooltip } from "@/components/ui/base/tooltip";
import { Callout } from "@/components/ui/product/callout";
import { EmptyState } from "@/components/ui/product/empty-state";
import { formatTaskKind, generationTaskStatusLabel } from "@/lib/generation-task-display";
import { listGenerationTasks, type GenerationTask } from "@/services/api/task-center";
import { cancelJob, fetchJobs, type ToivJob } from "@/services/toiv/client";
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

type TimelineItem = {
    id: string;
    source: "toiv-job" | "canvas-task";
    createdAt: string;
    title: string;
    detail: string;
    statusLabel: string;
    statusTone: "neutral" | "loading" | "success" | "error" | "warning";
    canCancel?: boolean;
    highlight?: boolean;
};

function formatTime(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(d);
}

function promptSummary(prompt?: string): string {
    const text = (prompt || "").trim();
    if (!text) return "(无提示摘要)";
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function detailLine(job: ToivJob): string {
    const parts: string[] = [formatTime(job.created_at)];
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
                    <div className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--muted,rgba(255,255,255,0.12))]" />
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
    const [loading, setLoading] = useState(true);
    const [canvasLoading, setCanvasLoading] = useState(true);
    const [canvasError, setCanvasError] = useState(false);
    const [error, setError] = useState(false);
    const [cancelingId, setCancelingId] = useState<string | null>(null);

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

    const load = useCallback(async () => {
        await Promise.all([loadJobs(), loadCanvas()]);
    }, [loadJobs, loadCanvas]);

    useEffect(() => {
        void load();
    }, [load]);

    const onCancel = async (jobId: string) => {
        setCancelingId(jobId);
        try {
            const ok = await cancelJob(jobId);
            if (ok) await loadJobs();
        } finally {
            setCancelingId(null);
        }
    };

    const timeline = useMemo((): TimelineItem[] => {
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
                detail: [formatTime(task.createdAt || ""), formatTaskKind(task)].filter(Boolean).join(" · "),
                statusLabel: generationTaskStatusLabel(task),
                statusTone: canvasStatusTone(task),
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
    }, [jobs, canvasTasks, focusJob]);

    const showSkeleton = loading && canvasLoading;
    const empty = !loading && !error && timeline.length === 0 && !canvasLoading;

    return (
        <WorkspacePage fluid className="toiv-tasks-page">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">任务中心</h1>
                    <p className="text-xs leading-5 text-muted-foreground">
                        统一任务时间线：ToIV 作业（/api/jobs）+ 画布 GenerationTask。进行中任务见顶栏 chip；完整画布历史也可进「画布任务」。
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Link to="/tasks">
                        <ToolButton variant="default" icon={<ListChecks />} label="画布任务" />
                    </Link>
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
                                        ? "border-[var(--workspace-accent,#888)] bg-[var(--surface-active,rgba(255,255,255,0.08))]"
                                        : "border-border bg-card"
                                }`}
                            >
                                <span
                                    className="absolute -left-[5px] top-5 h-2.5 w-2.5 rounded-full border border-border bg-[var(--workspace-accent,#888)]"
                                    aria-hidden
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="mb-1 flex flex-wrap items-center gap-2">
                                        <StatusBadge tone={item.statusTone} label={item.statusLabel} />
                                        <StatusBadge
                                            variant="filled"
                                            tone="neutral"
                                            label={item.source === "toiv-job" ? "ToIV 作业" : "画布任务"}
                                            size="sm"
                                        />
                                        <StatusBadge variant="filled" tone="neutral" label={item.id.slice(0, 8)} size="sm" />
                                    </div>
                                    <Tooltip title={item.title}>
                                        <p className="truncate text-sm font-medium">{item.title}</p>
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

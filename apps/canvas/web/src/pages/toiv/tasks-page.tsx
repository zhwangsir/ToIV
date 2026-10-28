import { ArrowLeft, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { Tooltip } from "@/components/ui/base/tooltip";
import { Callout } from "@/components/ui/product/callout";
import { ToivEmptyState } from "@/components/toiv/toiv-empty-state";
import { ToivSkeletonList } from "@/components/toiv/toiv-skeleton";
import {
    formatTaskKind,
    generationSourceNsfwLike,
    generationSourceProjection,
    type GenerationSourceHealth,
    type GenerationTaskNextAction,
} from "@/lib/generation-task-display";
import { formatDateTime } from "@/lib/time-format";
import { cancelGenerationTask, listGenerationTasks, retryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { cancelJob, fetchAgentRuns, fetchJobs, rerunToivWork, type ToivAgentRun, type ToivJob } from "@/services/toiv/client";
import { toivMediaUrl } from "@/services/toiv/cover-url";
import { isNsfwAssetSelectable } from "@/redline";
import { WorkspacePage } from "@/components/layout/workspace-page";
import { GenerationFailureNotice } from "@/components/generation/generation-failure-notice";
import { explainGenerationError } from "@/lib/generation-error";
import "@/styles/toiv-freezone-desk.css";
import "./tasks-page.css";

// 智能体任务状态原文(英文枚举)→统一中文,避免时间线上中英混排
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
    sortTimestamp: number;
    title: string;
    detail: string;
    statusLabel: string;
    statusTone: "neutral" | "loading" | "success" | "error" | "warning";
    isActive: boolean;
    health?: GenerationSourceHealth;
    progressPct?: number;
    previewUrl?: string;
    previewKind?: "image" | "video";
    mediaLocked?: boolean;
    canCancel?: boolean;
    highlight?: boolean;
    /** Wave P2:回跳短剧工作区 section/shot */
    jumpHref?: string;
    /** Wave0: 可读失败 + 指纹禁重试 */
    failureError?: unknown;
    requestId?: string;
    artifactLabel?: string;
    nextActionKind?: GenerationTaskNextAction;
    nextActionLabel?: string;
    nextActionReason?: string;
};

type SourceFilter = "all" | "toiv-job" | "canvas-task" | "agent-run";
type StatusFilter = "all" | "active" | "done" | "error";

const SOURCE_LABEL: Record<TimelineItem["source"], string> = {
    "toiv-job": "ToIV 作业",
    "canvas-task": "画布任务",
    "agent-run": "智能体任务",
};

function promptSummary(prompt?: string): string {
    const text = (prompt || "").trim();
    if (!text) return "(无提示摘要)";
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** Wave P2:画布任务回跳短剧工作区（有 project / shot 上下文时） */
function dramaJumpHref(task: GenerationTask): string | undefined {
    const ctx = task.clientContext;
    const pid = (ctx?.domainProjectId || task.projectId || "").trim();
    if (!pid) return undefined;
    const shot = (ctx?.shotId || "").trim();
    const q = new URLSearchParams({ section: "shots" });
    if (shot) q.set("shot", shot);
    return `/create?project=${encodeURIComponent(pid)}&${q.toString()}`;
}

/** Wave P2 残余:ToIV Job(含 studio_batch_render)透出 project_id → 回跳 ws */
function toivJobJumpHref(job: ToivJob): string | undefined {
    const pid = (job.project_id || "").trim();
    if (!pid) return undefined;
    const q = new URLSearchParams({ section: "shots" });
    if ((job.kind || "").includes("batch") || job.kind === "studio_batch_render") {
        q.set("from", "batch");
    }
    return `/create?project=${encodeURIComponent(pid)}&${q.toString()}`;
}

function detailLine(job: ToivJob, createdAtTimestamp: number): string {
    const parts: string[] = [formatDateTime(createdAtTimestamp)];
    if (job.kind) parts.push(job.kind);
    const reason = (job.status === "held" ? job.hold_reason : job.error)?.trim();
    if (reason) parts.push(reason.length > 48 ? `${reason.slice(0, 48)}…` : reason);
    return parts.join(" · ");
}

function generationStatusTone(status: GenerationTask["status"]): TimelineItem["statusTone"] {
    if (status === "succeeded") return "success";
    if (status === "failed") return "error";
    if (status === "running") return "loading";
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
        setCancelingId(`toiv-job:${jobId}`);
        setCancelError(null);
        try {
            const ok = await cancelJob(jobId);
            if (!ok) throw new Error("取消失败，请稍后重试");
            await loadJobs();
        } catch (error) {
            setCancelError(error instanceof Error ? error.message : "取消失败，请稍后重试");
        } finally {
            setCancelingId(null);
        }
    };

    const onGenerationAction = async (item: TimelineItem) => {
        if (item.nextActionKind !== "retry" && item.nextActionKind !== "cancel") return;
        if (item.nextActionLabel === "已锁定") return;
        setCancelingId(`${item.source}:${item.id}`);
        setCancelError(null);
        try {
            if (item.nextActionKind === "retry") {
                if (item.source === "toiv-job") {
                    const ok = await rerunToivWork(item.id);
                    if (!ok) throw new Error("重试失败，请稍后重试");
                } else {
                    await retryGenerationTask(item.id);
                }
            } else {
                await cancelGenerationTask(item.id);
            }
            await (item.source === "toiv-job" ? loadJobs() : loadCanvas());
        } catch (error) {
            setCancelError(error instanceof Error ? error.message : "任务操作失败，请稍后重试");
        } finally {
            setCancelingId(null);
        }
    };

    const timelineItemsRaw = useMemo((): TimelineItem[] => {
        const items: TimelineItem[] = [];
        for (const job of jobs) {
            const projection = generationSourceProjection({ source: "toiv-job", task: job });
            const actionLocked = !isNsfwAssetSelectable(generationSourceNsfwLike({ source: "toiv-job", task: job }));
            items.push({
                id: job.id,
                source: "toiv-job",
                createdAt: projection.createdAt,
                sortTimestamp: projection.sortTimestamp,
                title: promptSummary(job.prompt),
                detail: detailLine(job, projection.sortTimestamp),
                statusLabel: projection.statusLabel,
                statusTone: generationStatusTone(projection.status),
                isActive: projection.isActive,
                health: projection.health,
                progressPct: projection.progressPct,
                previewUrl: toivMediaUrl(projection.previewUrl),
                previewKind: projection.previewKind,
                mediaLocked: actionLocked,
                canCancel: projection.canCancel && !actionLocked,
                highlight: Boolean(focusJob && job.id === focusJob),
                jumpHref: toivJobJumpHref(job),
                artifactLabel: projection.artifactLabel,
                nextActionKind: projection.nextAction === "cancel" ? undefined : projection.nextAction,
                nextActionLabel: actionLocked ? "已锁定" : projection.nextLabel,
                nextActionReason: actionLocked ? "当前为普通：NSFW 任务已锁定" : projection.nextReason,
            });
        }
        for (const task of canvasTasks) {
            const projection = generationSourceProjection({ source: "canvas-task", task });
            const actionLocked = !isNsfwAssetSelectable(generationSourceNsfwLike({ source: "canvas-task", task }));
            items.push({
                id: task.id,
                source: "canvas-task",
                createdAt: projection.createdAt,
                sortTimestamp: projection.sortTimestamp,
                title: promptSummary(task.prompt),
                detail: [formatDateTime(task.createdAt || ""), formatTaskKind(task)].filter(Boolean).join(" · "),
                statusLabel: projection.statusLabel,
                statusTone: generationStatusTone(projection.status),
                isActive: projection.isActive,
                health: projection.health,
                progressPct: projection.progressPct,
                jumpHref: dramaJumpHref(task),
                failureError: task.status === "failed" ? (task.error || task.failureDiagnostics || task.errorCode || "生成失败") : undefined,
                requestId: projection.providerRequestId,
                artifactLabel: projection.artifactLabel,
                nextActionKind: projection.nextAction,
                nextActionLabel: actionLocked ? "已锁定" : projection.nextLabel,
                nextActionReason: actionLocked ? "当前为普通：NSFW 任务已锁定" : projection.nextReason,
            });
        }
        for (const run of agentRuns) {
            const counts = run.task_counts;
            items.push({
                id: run.id,
                source: "agent-run",
                createdAt: run.created_at || "",
                sortTimestamp: Date.parse(run.created_at || "") || 0,
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
                isActive: run.status === "queued" || run.status === "running",
            });
        }
        items.sort((a, b) => b.sortTimestamp - a.sortTimestamp);
        return items;
    }, [jobs, canvasTasks, agentRuns, focusJob]);

    const timeline = useMemo(() => {
        return timelineItemsRaw.filter((i) => {
            if (sourceFilter !== "all" && i.source !== sourceFilter) return false;
            if (statusFilter === "active") return i.isActive;
            if (statusFilter === "done") return i.statusTone === "success";
            if (statusFilter === "error") return i.statusTone === "error";
            return true;
        });
    }, [timelineItemsRaw, sourceFilter, statusFilter]);

    // 健康严重度不改变终态；stalled/waiting 等活跃作业继续轮询。
    const hasActive = useMemo(
        () => timelineItemsRaw.some((item) => item.isActive),
        [timelineItemsRaw],
    );
    const loadRef = useRef(load);
    loadRef.current = load;
    useEffect(() => {
        if (!hasActive) return;
        const t = setInterval(() => void loadRef.current(), 30_000);
        return () => clearInterval(t);
    }, [hasActive]);

    const showSkeleton = loading && canvasLoading;
    const empty = !loading && !error && timeline.length === 0 && !canvasLoading;

    return (
        <WorkspacePage fluid className="toiv-tasks-page fz-desk">
            <div className="fz-desk-page mx-auto flex w-full max-w-5xl flex-col gap-3">
                        <header className="fz-desk-toolbar">
                <h1>任务中心</h1>
                <p>追踪作业进度与下一步操作；进行中任务每 30 秒自动刷新。</p>
                <div className="fz-desk-actions">
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

            <div className="fz-panel flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground" aria-label="创作入口引导">
                <span>任务操作按来源与当前状态提供；失败诊断可复制。</span>
                <Link to="/create" className="text-[var(--workspace-accent)] underline-offset-2 hover:underline">去创作</Link>
                <span>·</span>
                <Link to="/toiv/drama" className="text-[var(--workspace-accent)] underline-offset-2 hover:underline">短剧项目</Link>
                <span>·</span>
                <Link to="/create" className="text-[var(--workspace-accent)] underline-offset-2 hover:underline">智能体对话</Link>
            </div>

            <div className="fz-pill-row" aria-label="任务筛选">
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
                        className={"fz-pill" + (sourceFilter === key ? " is-active" : "")}
                    >
                        {label}
                    </button>
                ))}
                <span className="fz-pill-row" style={{ marginLeft: 4 }}>
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
                            className={"fz-pill" + (statusFilter === key ? " is-active" : "")}
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
                <div className="d1a-task-action-error">
                    <Callout tone="warning" title="操作失败" onClose={() => setCancelError(null)}>
                        {cancelError}
                    </Callout>
                </div>
            )}

            {showSkeleton ? (
                <ToivSkeletonList rows={6} />
            ) : error && timeline.length === 0 ? (
                <ToivEmptyState
                    className="fz-panel fz-auth-gap"
                    icon={RefreshCw}
                    title="任务列表暂不可用"
                    description="可能是会话失效或接口未就绪（含 401）。请刷新重试；不会伪造作业行。"
                    action={<button type="button" className="toiv-empty-cta" onClick={() => void load()}>重试加载</button>}
                />
            ) : empty ? (
                <ToivEmptyState
                    className="fz-panel"
                    icon={RefreshCw}
                    title="还没有生成作业"
                    description="从工具箱运行，或在创作台/画布提交生成后，会在此时间线汇合。"
                    action={<Link to="/create" className="toiv-empty-cta">去创作</Link>}
                />
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
                                data-source-id={`${item.source}:${item.id}`}
                                data-health-label={item.health?.label}
                                data-health-reason={item.health?.reason}
                                data-active={String(item.isActive)}
                                className={`fz-panel relative -ml-4 mb-2 flex gap-3 px-3 py-3 pl-4 ${
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
                                        {item.artifactLabel ? <StatusBadge variant="filled" tone={item.artifactLabel === "产物可用" ? "success" : "neutral"} label={item.artifactLabel} size="sm" /> : null}
                                        {item.health ? <StatusBadge variant="filled" tone={item.health.state === "stalled" || item.health.state === "waiting" ? "warning" : "neutral"} label={item.health.label} size="sm" /> : null}
                                    </div>
                                    <Tooltip title={item.title}>
                                        {item.source === "agent-run" ? (
                                            <Link to={`/toiv/runs/${encodeURIComponent(item.id)}`} className="truncate text-sm font-medium underline-offset-2 hover:underline">
                                                {item.title}
                                            </Link>
                                        ) : item.jumpHref ? (
                                            <Link to={item.jumpHref} className="truncate text-sm font-medium underline-offset-2 hover:underline" title="回跳短剧镜头">
                                                {item.title}
                                            </Link>
                                        ) : (
                                            <p className="truncate text-sm font-medium">{item.title}</p>
                                        )}
                                    </Tooltip>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
                                    {item.health ? <p className="mt-1 text-xs text-muted-foreground">{item.health.label}：{item.health.reason}</p> : null}
                                    {item.progressPct !== undefined ? (
                                        <div className="toiv-job-progress mt-2 flex items-center gap-2" role="progressbar" aria-label="生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progressPct}>
                                            <div className="toiv-job-progress-track flex-1 overflow-hidden"><div className="toiv-job-progress-fill h-full" style={{ width: `${item.progressPct}%` }} /></div>
                                            <span className="text-xs text-muted-foreground">{item.progressPct}%</span>
                                        </div>
                                    ) : null}
                                    {item.previewUrl ? (
                                        <div className={`mt-2 max-w-64 overflow-hidden rounded-lg border border-border ${item.mediaLocked ? "opacity-50 grayscale" : ""}`}>
                                            {item.previewKind === "video"
                                                ? <video src={item.previewUrl} muted playsInline controls preload="metadata" className="max-h-40 w-full object-contain" />
                                                : <img src={item.previewUrl} alt={item.mediaLocked ? "NSFW 产物已锁定" : "作业产物"} loading="lazy" className="max-h-40 w-full object-contain" />}
                                        </div>
                                    ) : null}
                                    {item.nextActionReason && (item.nextActionKind === "retry" || item.nextActionKind === "cancel" || item.nextActionKind === "diagnose") ? (
                                        <p className="mt-1 text-xs text-muted-foreground" data-testid={`task-next-${item.id}`}>{item.nextActionReason}</p>
                                    ) : null}
                                    {item.failureError ? (
                                        <div className="mt-2">
                                            <GenerationFailureNotice
                                                explanation={explainGenerationError(item.failureError)}
                                                context={item.requestId ? { providerRequestId: item.requestId } : undefined}
                                                compact
                                                retryBlockedByFingerprint
                                                retryLabel="新建尝试"
                                                onRetry={item.jumpHref ? () => { window.location.assign(item.jumpHref!); } : undefined}
                                            />
                                        </div>
                                    ) : null}
                                </div>
                                {item.nextActionKind === "retry" || item.nextActionKind === "cancel" ? (
                                    <ToolButton
                                        variant="ghost"
                                        size="sm"
                                        icon={<RefreshCw />}
                                        label={item.nextActionLabel || "处理"}
                                        loading={cancelingId === `${item.source}:${item.id}`}
                                        disabled={item.nextActionLabel === "已锁定"}
                                        onClick={() => void onGenerationAction(item)}
                                    />
                                ) : null}
                                {item.canCancel ? (
                                    <ToolButton
                                        variant="ghost"
                                        size="sm"
                                        tone="danger"
                                        icon={<X />}
                                        label="取消"
                                        loading={cancelingId === `${item.source}:${item.id}`}
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

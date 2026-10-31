import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import { FileText, ListTodo, LoaderCircle, RefreshCw, RotateCcw, X } from "lucide-react";

import { NsfwLockBadge } from "@/components/toiv/nsfw-lock-badge";
import { ToivEmptyState } from "@/components/toiv/toiv-empty-state";
import { ToivSkeletonList } from "@/components/toiv/toiv-skeleton";
import { cn } from "@/lib/utils";
import {
    generationSourceNsfwLike,
    mergeGenerationSourceProjections,
    type GenerationSourceProjection,
} from "@/lib/generation-task-display";
import {
    COPY_MODE_ADULT,
    COPY_MODE_NORMAL,
    assetLooksNsfw,
    getR18ModeSnapshot,
    getServerR18ModeSnapshot,
    isNsfwAssetSelectable,
    subscribeR18Mode,
    COPY_MEDIA_LOCKED,
    COPY_QUEUE_LOCKED_HINT,
} from "@/redline";
import {
    cancelGenerationTask,
    formatTaskLog,
    listGenerationTasks,
    listTaskLogs,
    retryGenerationTask,
    type GenerationTask,
    type TaskLog,
} from "@/services/api/task-center";
import { cancelJob, fetchJobs, rerunToivWork, type ToivJob } from "@/services/toiv/client";
import { TOIV_TASKS_PATH } from "@/services/toiv/client-timeout";
import { toivMediaUrl } from "@/services/toiv/cover-url";

import "@/components/create/creation-studio-queue-dock.css";

function statusClass(status: GenerationTask["status"]) {
    if (status === "running") return "is-running";
    if (status === "queued") return "is-queued";
    if (status === "failed") return "is-failed";
    if (status === "succeeded") return "is-succeeded";
    return "is-cancelled";
}

function sourceNsfwLike(item: GenerationSourceProjection) {
    return generationSourceNsfwLike(item.source === "toiv-job"
        ? { source: "toiv-job", task: item.task as ToivJob }
        : { source: "canvas-task", task: item.task as GenerationTask });
}

/** Topbar-adjacent generation queue + optional /create bottom drawer. */
export function CreationStudioQueueDock() {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const { pathname, search } = useLocation();
    const onCreate = pathname.startsWith("/create");
    const [open, setOpen] = useState(false);
    const [bottomOpen, setBottomOpen] = useState(false);
    const [tasks, setTasks] = useState<GenerationTask[]>([]);
    const [jobs, setJobs] = useState<ToivJob[]>([]);
    const [canvasError, setCanvasError] = useState<string | null>(null);
    const [toivError, setToivError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [logTaskId, setLogTaskId] = useState<string | null>(null);
    const [logs, setLogs] = useState<TaskLog[]>([]);
    const [logError, setLogError] = useState<string | null>(null);
    const [logBusy, setLogBusy] = useState(false);
    const [canvasBooted, setCanvasBooted] = useState(false);
    const [toivBooted, setToivBooted] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const refreshRoundRef = useRef(0);

    const projectId = useMemo(() => {
        const q = new URLSearchParams(search);
        return (q.get("project") || "").trim() || undefined;
    }, [search]);

    const refresh = useCallback(async () => {
        const round = ++refreshRoundRef.current;
        const isLatestRound = () => refreshRoundRef.current === round;
        await Promise.all([
            (async () => {
                try {
                    const next = await listGenerationTasks(40, { projectId, activeOnly: false });
                    if (!isLatestRound()) return;
                    setTasks(Array.isArray(next) ? next.slice(0, 40) : []);
                    setCanvasError(null);
                } catch (error) {
                    if (!isLatestRound()) return;
                    setCanvasError(error instanceof Error ? error.message : "画布任务加载失败");
                } finally {
                    if (isLatestRound()) setCanvasBooted(true);
                }
            })(),
            (async () => {
                try {
                    const next = await fetchJobs(100);
                    if (!isLatestRound()) return;
                    setJobs(Array.isArray(next) ? next : []);
                    setToivError(null);
                } catch (error) {
                    if (!isLatestRound()) return;
                    setToivError(error instanceof Error ? error.message : "ToIV 作业加载失败");
                } finally {
                    if (isLatestRound()) setToivBooted(true);
                }
            })(),
        ]);
    }, [projectId]);

    useEffect(() => {
        void refresh();
        const t = window.setInterval(() => void refresh(), 4000);
        return () => window.clearInterval(t);
    }, [refresh]);

    useEffect(() => {
        if (!open) return;
        const onPointer = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };
        window.addEventListener("pointerdown", onPointer, true);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("pointerdown", onPointer, true);
            window.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const visibleTasks = useMemo(
        () => mergeGenerationSourceProjections(tasks, jobs, { projectId, limit: 40 }),
        [tasks, jobs, projectId, adultOn],
    );
    const activeCount = useMemo(() => visibleTasks.filter((item) => item.isActive).length, [visibleTasks]);
    const booted = canvasBooted && toivBooted;
    const hasSourceError = Boolean(canvasError || toivError);

    const openLogs = async (item: GenerationSourceProjection) => {
        if (logTaskId === item.sourceId) {
            setLogTaskId(null);
            setLogs([]);
            setLogError(null);
            return;
        }
        setLogTaskId(item.sourceId);
        setLogError(null);
        setLogBusy(true);
        try {
            setLogs(await listTaskLogs(item.id));
        } catch (error) {
            setLogs([]);
            setLogError(error instanceof Error ? error.message : "日志加载失败");
        } finally {
            setLogBusy(false);
        }
    };

    const onRetry = async (item: GenerationSourceProjection) => {
        if (!isNsfwAssetSelectable(sourceNsfwLike(item))) return;
        setBusyId(item.sourceId);
        setActionError(null);
        try {
            if (item.source === "toiv-job") {
                const ok = await rerunToivWork(item.id);
                if (!ok) throw new Error("重试失败，请稍后重试");
            } else {
                await retryGenerationTask(item.id);
            }
            await refresh();
        } catch (error) {
            setActionError(error instanceof Error ? error.message : "重试失败");
        } finally {
            setBusyId(null);
        }
    };

    const onCancel = async (item: GenerationSourceProjection) => {
        if (!isNsfwAssetSelectable(sourceNsfwLike(item))) return;
        setBusyId(item.sourceId);
        setActionError(null);
        try {
            if (item.source === "toiv-job") {
                const ok = await cancelJob(item.id);
                if (!ok) throw new Error("取消失败，请稍后重试");
            } else {
                await cancelGenerationTask(item.id);
            }
            await refresh();
        } catch (error) {
            setActionError(error instanceof Error ? error.message : "取消失败");
        } finally {
            setBusyId(null);
        }
    };

    const listBody = (
        <>
            {canvasError ? <ToivEmptyState compact className="toiv-queue-empty toiv-queue-source-error" title="画布任务读取失败" description={canvasError} /> : null}
            {toivError ? <ToivEmptyState compact className="toiv-queue-empty toiv-queue-source-error" title="ToIV 作业读取失败" description={toivError} /> : null}
            {actionError ? <ToivEmptyState compact className="toiv-queue-empty toiv-queue-action-error" title="操作未完成" description={actionError} /> : null}
            {!hasSourceError && !booted ? <ToivSkeletonList rows={3} className="toiv-queue-empty" /> : null}
            {!hasSourceError && booted && visibleTasks.length === 0 ? (
                <ToivEmptyState
                    compact
                    className="toiv-queue-empty"
                    icon={ListTodo}
                    title="暂无生成任务"
                    description="开始创作后会在此显示进度与重试入口。"
                />
            ) : null}
            <div className="toiv-queue-list" role="list">
                {visibleTasks.map((task) => {
                    const like = sourceNsfwLike(task);
                    const nsfw = assetLooksNsfw(like);
                    const locked = nsfw && !isNsfwAssetSelectable(like);
                    const pct = task.progressPct;
                    const indeterminate = task.showsProgress && pct === undefined && task.status === "running";
                    const previewUrl = task.source === "toiv-job" ? toivMediaUrl(task.previewUrl) : task.previewUrl;
                    return (
                        <article
                            key={task.sourceId}
                            role="listitem"
                            className={cn("toiv-queue-row", locked && "is-nsfw-locked", task.status === "failed" && "is-failed")}
                            data-task-id={task.sourceId}
                            data-source-id={task.sourceId}
                            data-health-label={task.health.label}
                            data-health-reason={task.health.reason}
                            data-active={String(task.isActive)}
                            data-nsfw={nsfw ? "1" : "0"}
                            data-locked={locked ? "1" : "0"}
                        >
                            <div className="toiv-queue-thumb" aria-hidden>
                                {previewUrl ? (
                                    task.previewKind === "video" ? (
                                        <video src={previewUrl} muted playsInline preload="metadata" poster={task.source === "canvas-task" ? (task.task as GenerationTask).previewPosterUrl || undefined : undefined} />
                                    ) : (
                                        <img src={previewUrl} alt="" loading="lazy" />
                                    )
                                ) : (
                                    <ListTodo className="size-4 opacity-40" />
                                )}
                            </div>
                            <div className="toiv-queue-row-main">
                                <p className="toiv-queue-row-title" title={task.kindLabel}>{task.kindLabel}</p>
                                <p className="toiv-queue-row-prompt" title={task.title}>{task.title}</p>
                                <div className="toiv-queue-row-statusline">
                                    <span className={cn("toiv-queue-dot", task.status === "running" && "is-running")} aria-hidden />
                                    <span className={cn("toiv-queue-badge", statusClass(task.status))}>{task.statusLabel}</span>
                                    <span className={cn("toiv-queue-health", `is-${task.health.state}`)}>{task.health.label}</span>
                                    {locked ? <NsfwLockBadge compact /> : null}
                                </div>
                                <p className="toiv-queue-row-meta">{task.stageLabel} · {task.artifactLabel} · {task.nextLabel}</p>
                                <p className="toiv-queue-row-meta toiv-queue-health-reason">{task.health.reason}</p>
                                {task.showsProgress ? (
                                    <>
                                        <div
                                            className={cn("toiv-queue-progress", indeterminate && "is-indeterminate")}
                                            role="progressbar"
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={pct ?? undefined}
                                            aria-label="生成进度"
                                        >
                                            <span style={pct === undefined ? undefined : { width: `${pct}%` }} />
                                        </div>
                                        <div className="toiv-queue-progress-meta">
                                            <span>{indeterminate ? "进行中…" : task.stageLabel}</span>
                                            <span>{pct === undefined ? "—" : `${pct}%`}</span>
                                        </div>
                                    </>
                                ) : null}
                                {task.status === "failed" ? <p className="toiv-queue-row-meta toiv-queue-row-error">{task.nextReason}</p> : null}
                                {locked ? (
                                    <p className="toiv-queue-row-meta">
                                        {COPY_QUEUE_LOCKED_HINT ? <>当前为{COPY_MODE_NORMAL}：{COPY_QUEUE_LOCKED_HINT}。切换到「{COPY_MODE_ADULT}」后可重试/取消。</> : null}
                                    </p>
                                ) : null}
                                {task.source === "canvas-task" && logTaskId === task.sourceId ? (
                                    <pre className="toiv-queue-log" aria-live="polite">
                                        {logBusy ? "加载日志…" : logError || (logs.length ? logs.map((log) => formatTaskLog(log)).join("\n") : "暂无日志")}
                                    </pre>
                                ) : null}
                            </div>
                            <div className="toiv-queue-row-actions">
                                {task.source === "canvas-task" ? (
                                    <button
                                        type="button"
                                        className="toiv-queue-action"
                                        disabled={locked || logBusy}
                                        title={logTaskId === task.sourceId ? "收起日志" : "查看日志"}
                                        aria-label={logTaskId === task.sourceId ? "收起日志" : "查看日志"}
                                        onClick={() => void openLogs(task)}
                                    >
                                        <FileText aria-hidden />
                                    </button>
                                ) : (
                                    <Link to={`/tasks?job=${encodeURIComponent(task.id)}`} className="toiv-queue-action" title="查看日志" aria-label="查看日志">
                                        <FileText aria-hidden />
                                    </Link>
                                )}
                                {task.canRetry ? (
                                    <button
                                        type="button"
                                        className="toiv-queue-action"
                                        disabled={locked || busyId === task.sourceId}
                                        title={locked ? COPY_MEDIA_LOCKED || "重试" : "重试"}
                                        aria-label="重试"
                                        onClick={() => void onRetry(task)}
                                    >
                                        {busyId === task.sourceId ? <LoaderCircle className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
                                    </button>
                                ) : null}
                                {task.canCancel ? (
                                    <button
                                        type="button"
                                        className="toiv-queue-action is-danger"
                                        disabled={locked || busyId === task.sourceId}
                                        title="取消"
                                        aria-label="取消"
                                        onClick={() => void onCancel(task)}
                                    >
                                        <X aria-hidden />
                                    </button>
                                ) : null}
                            </div>
                        </article>
                    );
                })}
            </div>
        </>
    );

    return (
        <>
            <div className="toiv-queue-root" ref={rootRef} data-testid="creation-studio-queue-dock">
                <button
                    type="button"
                    className="toiv-queue-trigger"
                    aria-label={`生成队列（${activeCount} 进行中）`}
                    aria-expanded={open}
                    aria-controls="toiv-queue-panel"
                    onClick={() => setOpen((v) => !v)}
                >
                    {activeCount > 0 ? (
                        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" style={{ color: "var(--toiv-accent)" }} aria-hidden />
                    ) : (
                        <ListTodo className="size-3.5" aria-hidden />
                    )}
                    <span>队列</span>
                    <span className={cn("toiv-queue-trigger-count", activeCount === 0 && "is-zero")}>{activeCount}</span>
                </button>
                {open ? (
                    <section id="toiv-queue-panel" className="toiv-queue-panel" aria-label="生成队列">
                        <header className="toiv-queue-panel-head">
                            <h3 className="toiv-queue-panel-title">生成队列</h3>
                            <div className="toiv-queue-panel-actions">
                                <button type="button" className="toiv-queue-icon-btn" aria-label="刷新" onClick={() => void refresh()}>
                                    <RefreshCw className="size-3.5" />
                                </button>
                                <Link to={TOIV_TASKS_PATH} className="toiv-queue-ghost" onClick={() => setOpen(false)}>
                                    任务中心
                                </Link>
                                <button type="button" className="toiv-queue-icon-btn" aria-label="关闭" onClick={() => setOpen(false)}>
                                    <X className="size-3.5" />
                                </button>
                            </div>
                        </header>
                        {listBody}
                    </section>
                ) : null}
            </div>

            {onCreate ? (
                <div className="toiv-queue-bottom" hidden={!bottomOpen && activeCount === 0} data-testid="creation-studio-queue-bottom">
                    <button
                        type="button"
                        className="toiv-queue-bottom-head"
                        aria-expanded={bottomOpen}
                        onClick={() => setBottomOpen((v) => !v)}
                    >
                        {activeCount > 0 ? (
                            <LoaderCircle className="size-3.5 animate-spin" style={{ color: "var(--toiv-accent)" }} aria-hidden />
                        ) : (
                            <ListTodo className="size-3.5" aria-hidden />
                        )}
                        <strong className="text-xs">底栏队列 · {activeCount} 进行中</strong>
                        <span className="ml-auto text-[11px] text-[var(--toiv-text-muted)]">{bottomOpen ? "收起" : "展开"}</span>
                    </button>
                    {bottomOpen ? listBody : null}
                </div>
            ) : null}
        </>
    );
}

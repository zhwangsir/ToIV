import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import { FileText, ListTodo, LoaderCircle, RefreshCw, RotateCcw, X } from "lucide-react";

import { NsfwLockBadge } from "@/components/toiv/nsfw-lock-badge";
import { ToivEmptyState } from "@/components/toiv/toiv-empty-state";
import { ToivSkeletonList } from "@/components/toiv/toiv-skeleton";
import { cn } from "@/lib/utils";
import { formatTaskKind, generationTaskShowsProgress, generationTaskStageLabel, generationTaskStatusLabel } from "@/lib/generation-task-display";
import {
    COPY_MODE_ADULT,
    COPY_MODE_NORMAL,
    assetLooksNsfw,
    getR18ModeSnapshot,
    getServerR18ModeSnapshot,
    isNsfwAssetSelectable,
    subscribeR18Mode,
    type NsfwAssetLike,
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
import { TOIV_TASKS_PATH } from "@/services/toiv/client-timeout";

import "@/components/create/creation-studio-queue-dock.css";

function taskAsNsfwLike(task: GenerationTask): NsfwAssetLike {
    return {
        id: task.id,
        label: task.prompt,
        basename: task.model || task.type,
        value: [task.prompt, task.model, task.type, task.operation, task.error].filter(Boolean).join("\n"),
    };
}

function statusClass(status: GenerationTask["status"]) {
    if (status === "running") return "is-running";
    if (status === "queued") return "is-queued";
    if (status === "failed") return "is-failed";
    if (status === "succeeded") return "is-succeeded";
    return "is-cancelled";
}

function progressPct(task: GenerationTask): number | undefined {
    if (!generationTaskShowsProgress(task)) return undefined;
    // Only trust server progress — never invent a full bar.
    if (typeof task.progress === "number" && Number.isFinite(task.progress)) {
        return Math.max(0, Math.min(100, Math.round(task.progress)));
    }
    if (task.status === "queued") return 0;
    return undefined; // running without % → indeterminate shimmer
}

/** Topbar-adjacent generation queue + optional /create bottom drawer. */
export function CreationStudioQueueDock() {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const { pathname, search } = useLocation();
    const onCreate = pathname.startsWith("/create");
    const [open, setOpen] = useState(false);
    const [bottomOpen, setBottomOpen] = useState(false);
    const [tasks, setTasks] = useState<GenerationTask[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [logTaskId, setLogTaskId] = useState<string | null>(null);
    const [logs, setLogs] = useState<TaskLog[]>([]);
    const [logBusy, setLogBusy] = useState(false);
    const [booted, setBooted] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    const projectId = useMemo(() => {
        const q = new URLSearchParams(search);
        return (q.get("project") || "").trim() || undefined;
    }, [search]);

    const refresh = useCallback(async () => {
        try {
            const next = await listGenerationTasks(40, { projectId, activeOnly: false });
            setTasks(Array.isArray(next) ? next.slice(0, 40) : []);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "队列加载失败");
        } finally {
            setBooted(true);
        }
    }, [projectId]);

    useEffect(() => {
        void refresh();
        const ms = 4000;
        const t = window.setInterval(() => void refresh(), ms);
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

    const activeCount = useMemo(
        () => tasks.filter((t) => t.status === "queued" || t.status === "running").length,
        [tasks],
    );

    const visibleTasks = useMemo(() => {
        // Always show known NSFW (locked in ordinary); unknown hidden via classify on string blob → marker only
        return tasks.filter((task) => {
            const like = taskAsNsfwLike(task);
            // unknown string-only classification: if no nsfw marker, keep
            if (!assetLooksNsfw(like)) return true;
            return true; // known nsfw always listable; lock handled in row
        });
    }, [tasks, adultOn]);

    const openLogs = async (taskId: string) => {
        if (logTaskId === taskId) {
            setLogTaskId(null);
            setLogs([]);
            return;
        }
        setLogTaskId(taskId);
        setLogBusy(true);
        try {
            setLogs(await listTaskLogs(taskId));
        } catch {
            setLogs([]);
        } finally {
            setLogBusy(false);
        }
    };

    const onRetry = async (task: GenerationTask) => {
        if (!isNsfwAssetSelectable(taskAsNsfwLike(task))) return;
        setBusyId(task.id);
        try {
            await retryGenerationTask(task.id);
            await refresh();
        } finally {
            setBusyId(null);
        }
    };

    const onCancel = async (task: GenerationTask) => {
        if (!isNsfwAssetSelectable(taskAsNsfwLike(task))) return;
        setBusyId(task.id);
        try {
            await cancelGenerationTask(task.id);
            await refresh();
        } finally {
            setBusyId(null);
        }
    };

    const listBody = (
        <>
            {error ? (
                <ToivEmptyState compact className="toiv-queue-empty" title="队列暂时不可用" description={error} />
            ) : null}
            {!error && !booted ? <ToivSkeletonList rows={3} className="toiv-queue-empty" /> : null}
            {!error && booted && visibleTasks.length === 0 ? (
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
                    const like = taskAsNsfwLike(task);
                    const nsfw = assetLooksNsfw(like);
                    const locked = nsfw && !isNsfwAssetSelectable(like);
                    const pct = progressPct(task);
                    const indeterminate = generationTaskShowsProgress(task) && pct === undefined && task.status === "running";
                    return (
                        <article
                            key={task.id}
                            role="listitem"
                            className={cn("toiv-queue-row", locked && "is-nsfw-locked", task.status === "failed" && "is-failed")}
                            data-task-id={task.id}
                            data-nsfw={nsfw ? "1" : "0"}
                            data-locked={locked ? "1" : "0"}
                        >
                            <div className="toiv-queue-thumb" aria-hidden>
                                {task.previewUrl ? (
                                    task.previewKind === "video" ? (
                                        <video src={task.previewUrl} muted playsInline preload="metadata" poster={task.previewPosterUrl || undefined} />
                                    ) : (
                                        <img src={task.previewUrl} alt="" loading="lazy" />
                                    )
                                ) : (
                                    <ListTodo className="size-4 opacity-40" />
                                )}
                            </div>
                            <div className="toiv-queue-row-main">
                                <p className="toiv-queue-row-title" title={formatTaskKind(task)}>
                                    {formatTaskKind(task)}
                                </p>
                                <div className="toiv-queue-row-statusline">
                                    <span className={cn("toiv-queue-dot", task.status === "running" && "is-running")} aria-hidden />
                                    <span className={cn("toiv-queue-badge", statusClass(task.status))}>{generationTaskStatusLabel(task)}</span>
                                    {locked ? <NsfwLockBadge compact /> : null}
                                </div>
                                <p className="toiv-queue-row-meta">{generationTaskStageLabel(task)}</p>
                                {generationTaskShowsProgress(task) ? (
                                    <>
                                        <div
                                            className={cn("toiv-queue-progress", indeterminate && "is-indeterminate")}
                                            role="progressbar"
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={pct ?? undefined}
                                            aria-label="生成进度"
                                        >
                                            {/* Determinate only when server sends % — never fake a full bar. */}
                                            <span style={pct === undefined ? undefined : { width: `${pct}%` }} />
                                        </div>
                                        <div className="toiv-queue-progress-meta">
                                            <span>{indeterminate ? "进行中…" : generationTaskStageLabel(task)}</span>
                                            <span>{pct === undefined ? "—" : `${pct}%`}</span>
                                        </div>
                                    </>
                                ) : null}
                                {task.error && task.status === "failed" ? (
                                    <p className="toiv-queue-row-meta" style={{ color: "var(--toiv-danger)" }}>
                                        {task.error}
                                    </p>
                                ) : null}
                                {locked ? (
                                    <p className="toiv-queue-row-meta">
                                        当前为{COPY_MODE_NORMAL}：NSFW 任务已锁定。切到顶栏「{COPY_MODE_ADULT}」后可重试/取消。
                                    </p>
                                ) : null}
                                {logTaskId === task.id ? (
                                    <pre className="toiv-queue-log" aria-live="polite">
                                        {logBusy
                                            ? "加载日志…"
                                            : logs.length
                                              ? logs.map((log) => formatTaskLog(log)).join("\n")
                                              : "暂无日志"}
                                    </pre>
                                ) : null}
                            </div>
                            <div className="toiv-queue-row-actions">
                                <button
                                    type="button"
                                    className="toiv-queue-action"
                                    disabled={locked || logBusy}
                                    title={logTaskId === task.id ? "收起日志" : "查看日志"}
                                    aria-label={logTaskId === task.id ? "收起日志" : "查看日志"}
                                    onClick={() => void openLogs(task.id)}
                                >
                                    <FileText aria-hidden />
                                </button>
                                {task.status === "failed" ? (
                                    <button
                                        type="button"
                                        className="toiv-queue-action"
                                        disabled={locked || busyId === task.id}
                                        title={locked ? "NSFW 已锁定" : "重试"}
                                        aria-label="重试"
                                        onClick={() => void onRetry(task)}
                                    >
                                        {busyId === task.id ? <LoaderCircle className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
                                    </button>
                                ) : null}
                                {task.status === "queued" || task.status === "running" ? (
                                    <button
                                        type="button"
                                        className="toiv-queue-action is-danger"
                                        disabled={locked || busyId === task.id}
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

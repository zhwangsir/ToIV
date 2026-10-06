import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { Button, Tooltip } from "antd";
import { ChevronDown, ChevronUp, Clock3, ListTodo, LoaderCircle, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { aceternityMotion } from "@/lib/aceternity-motion";
import { formatTaskKind, generationTaskShowsProgress, generationTaskStageLabel, generationTaskStatusLabel } from "@/lib/generation-task-display";
import { canvasThemes } from "@/lib/canvas-theme";
import type { GenerationTask } from "@/services/api/task-center";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";

// 生成任务入口：收起时只是一枚顶栏按钮（图标 + 进行中数量），不占画布内容区；
// 展开的列表贴在按钮下方，再点一次或点列表外即收起。
// placement="topbar" 时由顶栏右侧按钮组承载；"focusbar" 用于专注模式（顶栏隐藏），放进专注栏里，同样不占画布。
export function CanvasActiveTaskPanel({ tasks, placement = "topbar", onCancelTask }: { tasks: GenerationTask[]; placement?: "topbar" | "focusbar"; onCancelTask?: (task: GenerationTask) => void }) {
    const theme = canvasThemes[useActiveTheme()];
    const reducedMotion = useReducedMotion();
    const [now, setNow] = useState(() => Date.now());
    const [open, setOpen] = useState(false);
    const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!tasks.length) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [tasks.length]);

    useEffect(() => {
        if (expandedTaskId && !tasks.some((task) => task.id === expandedTaskId)) setExpandedTaskId(null);
    }, [expandedTaskId, tasks]);

    useEffect(() => {
        if (!tasks.length) setOpen(false);
    }, [tasks.length]);

    // 点列表外或按 Esc 收起，和顶栏其它下拉一致。
    useEffect(() => {
        if (!open) return;
        const onPointer = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
        window.addEventListener("pointerdown", onPointer, true);
        window.addEventListener("keydown", onKey);
        return () => { window.removeEventListener("pointerdown", onPointer, true); window.removeEventListener("keydown", onKey); };
    }, [open]);

    if (!tasks.length) return null;

    const motionTransition = reducedMotion ? { duration: 0 } : aceternityMotion.spring.panel;
    const label = `生成任务（${tasks.length} 个进行中）`;

    const trigger = placement === "focusbar" ? (
        <button
            type="button"
            className="flex h-8 items-center gap-1 rounded-full px-2 text-xs font-medium tabular-nums transition hover:bg-black/5 dark:hover:bg-white/10"
            style={{ color: theme.node.text, background: open ? theme.toolbar.itemHover : undefined }}
            onClick={() => setOpen((value) => !value)}
            aria-label={label}
            aria-expanded={open}
            aria-controls="canvas-active-task-list"
        >
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" style={{ color: theme.accent.primary }} />
            {tasks.length}
        </button>
    ) : (
        <Tooltip title={open ? undefined : label} placement="bottom">
            <Button
                type="text"
                className="canvas-topbar-action !h-9 !rounded-xl !px-2.5 !font-medium"
                style={{ color: theme.node.text, background: open ? theme.toolbar.activeBg : undefined }}
                icon={<LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" style={{ color: theme.accent.primary }} />}
                onClick={() => setOpen((value) => !value)}
                aria-label={label}
                aria-expanded={open}
                aria-controls="canvas-active-task-list"
            >
                <span className="tabular-nums">{tasks.length}</span>
            </Button>
        </Tooltip>
    );

    // 顶栏：贴按钮右下；专注栏在屏幕正中，列表在栏下方居中，窄屏也不出界。
    const listPosition = placement === "focusbar"
        ? "pointer-events-none fixed inset-x-0 top-14 z-[var(--z-panel-floating)] flex justify-center"
        : "absolute right-0 top-[calc(100%+8px)] z-[var(--z-panel-floating)]";
    const list = (
        <div className={listPosition}>
        <AnimatePresence initial={false}>
            {open ? (
                <motion.section
                    key="canvas-active-task-list"
                    id="canvas-active-task-list"
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={motionTransition}
                    className="pointer-events-auto w-[var(--canvas-panel-width)] overflow-hidden rounded-[var(--panel-radius)] border backdrop-blur-2xl"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: `0 24px 72px ${theme.spatial.shadow}` }}
                    aria-label="当前画布生成任务"
                >
                    <LayoutGroup id="canvas-active-tasks">
                        <div className="thin-scrollbar max-h-[min(70vh,520px)] space-y-2 overflow-y-auto p-2.5">
                            {tasks.map((task) => (
                                <ActiveTaskCard
                                    key={task.id}
                                    task={task}
                                    now={now}
                                    theme={theme}
                                    expanded={expandedTaskId === task.id}
                                    onToggle={() => setExpandedTaskId((current) => (current === task.id ? null : task.id))}
                                    onCancelTask={onCancelTask}
                                    reducedMotion={Boolean(reducedMotion)}
                                />
                            ))}
                        </div>
                    </LayoutGroup>
                </motion.section>
            ) : null}
        </AnimatePresence>
        </div>
    );

    return (
        <div ref={rootRef} data-canvas-no-zoom data-canvas-active-tasks className="relative inline-flex shrink-0">
            {trigger}
            {list}
        </div>
    );
}

function ActiveTaskCard({
    task,
    now,
    theme,
    expanded,
    onToggle,
    onCancelTask,
    reducedMotion,
}: {
    task: GenerationTask;
    now: number;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    expanded: boolean;
    onToggle: () => void;
    onCancelTask?: (task: GenerationTask) => void;
    reducedMotion: boolean;
}) {
    const showsProgress = generationTaskShowsProgress(task);
    const progress = showsProgress && typeof task.progress === "number" ? Math.max(0, Math.min(100, Math.round(task.progress))) : showsProgress && task.status === "queued" ? 0 : undefined;
    const startedAt = task.startedAt || task.createdAt;
    const elapsedMs = Math.max(0, now - parseTime(startedAt));
    const durationLabel = `${task.status === "queued" ? "已等待" : "已运行"} ${formatDuration(elapsedMs)}`;
    const statusTone = task.status === "running" ? theme.accent.primary : theme.node.muted;
    const transition = reducedMotion ? { duration: 0 } : aceternityMotion.spring.panel;

    return (
        <motion.article layout layoutId={`canvas-active-task-${task.id}`} className="overflow-hidden rounded-xl border" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}>
            <button type="button" className="block w-full p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]" onClick={onToggle} aria-expanded={expanded}>
                <div className="flex min-w-0 items-start gap-2">
                    <motion.span layout="position" className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md" style={{ background: `${statusTone}18`, color: statusTone }}>
                        <ListTodo className="size-3.5" />
                    </motion.span>
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-semibold" title={formatTaskKind(task)}>
                                {formatTaskKind(task)}
                            </span>
                            <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[var(--fs-tiny)] font-medium" style={{ borderColor: `${statusTone}44`, color: statusTone }}>
                                {generationTaskStatusLabel(task)}
                            </span>
                        </span>
                        <span className="mt-1 block truncate text-[var(--fs-label)]" style={{ color: theme.node.muted }} title={generationTaskStageLabel(task)}>
                            {generationTaskStageLabel(task)}
                        </span>
                    </span>
                    {expanded ? <ChevronUp className="mt-0.5 size-3.5 shrink-0" style={{ color: theme.node.muted }} /> : <ChevronDown className="mt-0.5 size-3.5 shrink-0" style={{ color: theme.node.muted }} />}
                </div>

                {showsProgress ? (
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: theme.toolbar.itemHover }}>
                        {progress !== undefined ? (
                            <motion.div className="relative h-full rounded-full overflow-hidden" animate={{ width: `${progress}%` }} transition={reducedMotion ? { duration: 0 } : { duration: 0.3, ease: "easeOut" }} style={{ background: statusTone }}>
                                {/* 进度条 shimmer 扫描动画（对应 #98 决策3）*/}
                                {task.status === "running" && !reducedMotion ? (
                                    <span className="absolute inset-0 canvas-task-progress-shimmer" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,.3), transparent)" }} aria-hidden />
                                ) : null}
                            </motion.div>
                        ) : (
                            // indeterminate 模式（无具体百分比，从左到右循环扫描）
                            <motion.div
                                className="h-full rounded-full"
                                initial={{ width: "20%", x: "-100%" }}
                                animate={{ width: "20%", x: "400%" }}
                                transition={reducedMotion ? { duration: 0 } : { duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                                style={{ background: statusTone }}
                            />
                        )}
                    </div>
                ) : null}

                {/* 进度百分比显示（对应 #98 决策3：列表视图）*/}
                {progress !== undefined && task.status === "running" ? (
                    <div className="mt-1 flex items-center justify-between text-[var(--fs-micro)]" style={{ color: theme.node.muted }}>
                        <span>{durationLabel}</span>
                        <span className="font-medium tabular-nums" style={{ color: statusTone }}>
                            {progress}%
                        </span>
                    </div>
                ) : (
                    <div className="mt-3 grid grid-cols-1 gap-2 text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>
                        <span className="inline-flex min-w-0 items-center gap-1 truncate" title={durationLabel}>
                            <Clock3 className="size-3 shrink-0" />
                            {durationLabel}
                        </span>
                    </div>
                )}
            </button>

            <AnimatePresence initial={false}>
                {expanded ? (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={transition}
                        className="border-t px-3 pb-3 pt-2 text-[var(--fs-label)]"
                        style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <span>当前阶段</span>
                            <span className="max-w-[200px] truncate text-right" style={{ color: theme.node.text }}>
                                {generationTaskStageLabel(task)}
                            </span>
                        </div>
                        {onCancelTask && (task.status === "queued" || task.status === "running") ? (
                            <button
                                type="button"
                                className="mt-3 inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium transition-colors"
                                style={{ background: `${theme.accent.danger}16`, color: theme.accent.danger }}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onCancelTask(task);
                                }}
                                onMouseDown={(event) => event.stopPropagation()}
                            >
                                <XCircle className="size-3" />
                                取消任务
                            </button>
                        ) : null}
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </motion.article>
    );
}

function parseTime(value?: string) {
    if (!value) return Date.now();
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : Date.now();
}

function formatDuration(value: number) {
    const totalSeconds = Math.floor(value / 1_000);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

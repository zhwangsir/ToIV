import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Dropdown } from "antd";
import { AlignLeft, ArrowRight, AudioLines, Check, ChevronDown, ChevronUp, CircleUserRound, Clapperboard, FolderKanban, ImagePlus, Images, MoreHorizontal, MousePointer2, Palette, Pencil, Plus, PlusCircle, ScanLine, Sparkles, Type, Upload, Video, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasCreateCommand } from "@/components/canvas/canvas-create-menu";
import { CANVAS_EMPTY_TEMPLATES, CANVAS_TIDY_LAYOUT_LABEL } from "@/lib/canvas/canvas-empty-templates";
import type { CanvasShortDramaProgress, CanvasShortDramaStepId } from "@/lib/canvas/canvas-short-drama";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasLinkedProjectEmptyState({ projectName, hasChapter, onAddFirstChapter, onOpenAssets, onAddText }: { projectName: string; hasChapter: boolean; onAddFirstChapter: () => void; onOpenAssets: () => void; onAddText: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    return (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center px-4 pb-16 pt-20">
            <div className="pointer-events-auto w-full max-w-[440px] rounded-lg border p-3 shadow-sm backdrop-blur" data-canvas-no-zoom style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
                <div className="flex items-center gap-2.5"><span className="grid size-8 shrink-0 place-items-center rounded-md" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }}><FolderKanban className="size-4" /></span><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{projectName}</h2><p className="mt-0.5 text-[var(--fs-label)]" style={{ color: theme.node.muted }}>项目画布为空</p></div></div>
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                    <button type="button" disabled={!hasChapter} onClick={onAddFirstChapter} className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-[var(--fs-label)] font-medium disabled:opacity-35" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}><Plus className="size-3.5 shrink-0" /><span className="truncate">添加首章</span></button>
                    <button type="button" onClick={onOpenAssets} className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-[var(--fs-label)] font-medium" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}><Images className="size-3.5 shrink-0" /><span className="truncate">项目资产</span></button>
                    <button type="button" onClick={onAddText} className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-[var(--fs-label)] font-medium" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}><Type className="size-3.5 shrink-0" /><span className="truncate">新建文本</span></button>
                </div>
            </div>
        </div>
    );
}

export function CanvasShortDramaEmptyState({ onCreatePipeline, onCreateImageToVideo, onStartFreeform, onUpload, onAddText, onAddScript }: {
    onCreatePipeline: () => void;
    onCreateImageToVideo?: () => void;
    onStartFreeform: () => void;
    onUpload: () => void;
    onAddText: () => void;
    onAddScript: () => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const focusStyle = { "--tw-ring-color": theme.accent.primary } as CSSProperties;
    return (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center px-4 pb-20 pt-36">
            <div className="pointer-events-auto w-full max-w-[760px]" data-canvas-no-zoom>
                <div className="mb-4 text-center">
                    <h2 className="text-lg font-semibold">从哪里开始？</h2>
                </div>
                <div className="grid gap-3 md:grid-cols-3" data-testid="canvas-empty-templates">
                    <PathCard
                        icon={<Clapperboard className="size-5" />}
                        title={CANVAS_EMPTY_TEMPLATES[0].label}
                        description={CANVAS_EMPTY_TEMPLATES[0].description}
                        action={CANVAS_EMPTY_TEMPLATES[0].action}
                        accent={theme.accent.primary}
                        theme={theme}
                        focusStyle={focusStyle}
                        onClick={onCreatePipeline}
                    />
                    <PathCard
                        icon={<ImagePlus className="size-5" />}
                        title={CANVAS_EMPTY_TEMPLATES[1].label}
                        description={CANVAS_EMPTY_TEMPLATES[1].description}
                        action={CANVAS_EMPTY_TEMPLATES[1].action}
                        accent="#8ec5ff"
                        theme={theme}
                        focusStyle={focusStyle}
                        onClick={() => (onCreateImageToVideo || onCreatePipeline)()}
                    />
                    <PathCard
                        icon={<Plus className="size-5" />}
                        title={CANVAS_EMPTY_TEMPLATES[2].label}
                        description={CANVAS_EMPTY_TEMPLATES[2].description}
                        action={CANVAS_EMPTY_TEMPLATES[2].action}
                        accent={theme.node.muted}
                        theme={theme}
                        focusStyle={focusStyle}
                        onClick={onStartFreeform}
                    />
                </div>
                <div className="mt-3 flex justify-center">
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                { key: "upload", icon: <Upload className="size-4" />, label: "导入素材", onClick: onUpload },
                                { key: "text", icon: <Type className="size-4" />, label: "新建文本", onClick: onAddText },
                                { key: "storyboard", icon: <Clapperboard className="size-4" />, label: "新建空白分镜", onClick: onAddScript },
                            ],
                        }}
                    >
                        <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/10" style={{ color: theme.node.muted, ...focusStyle }}>
                            <MoreHorizontal className="size-4" />其他起点<ChevronDown className="size-3" />
                        </button>
                    </Dropdown>
                </div>
            </div>
        </div>
    );
}

export function CanvasFreeformEmptyState({ commands, onOpenAssistant, onCreateShortDrama, onCreateImageToVideo, onTidyLayout }: {
    commands: CanvasCreateCommand[];
    onOpenAssistant?: () => void;
    onCreateShortDrama?: () => void;
    onCreateImageToVideo?: () => void;
    onTidyLayout?: () => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const [connectionsHintOpen, setConnectionsHintOpen] = useState(true);
    useEffect(() => {
        try {
            setConnectionsHintOpen(window.localStorage.getItem("canvas:connections-hint-dismissed") !== "1");
        } catch {
            // 本地存储不可用时保留首次提示，不影响画布操作。
        }
    }, []);
    const createCommands = commands.map((command) => ({
        ...command,
        onClick: command.onClick,
    }));
    const commandById = new Map(createCommands.map((command) => [command.id, command]));
    const templateActions = [
        {
            id: CANVAS_EMPTY_TEMPLATES[0].id,
            label: CANVAS_EMPTY_TEMPLATES[0].label,
            description: CANVAS_EMPTY_TEMPLATES[0].description,
            icon: <Clapperboard className="size-4" />,
            accent: "#9bcf6b",
            onClick: () => (onCreateShortDrama || commandById.get("script")?.onClick)?.(),
        },
        {
            id: CANVAS_EMPTY_TEMPLATES[1].id,
            label: CANVAS_EMPTY_TEMPLATES[1].label,
            description: CANVAS_EMPTY_TEMPLATES[1].description,
            icon: <ImagePlus className="size-4" />,
            accent: "#8ec5ff",
            onClick: () => (onCreateImageToVideo || commandById.get("video")?.onClick)?.(),
        },
        {
            id: CANVAS_EMPTY_TEMPLATES[2].id,
            label: CANVAS_EMPTY_TEMPLATES[2].label,
            description: CANVAS_EMPTY_TEMPLATES[2].description,
            icon: <Plus className="size-4" />,
            accent: "#b58be8",
            onClick: () => commandById.get("text")?.onClick(),
        },
    ];
    return (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center px-4 pb-20 pt-24">
            <div className="pointer-events-none select-none flex w-full max-w-[984px] flex-col items-center justify-center text-center" style={{ color: theme.node.text }}>
                <div className="relative -top-2 flex items-center justify-center gap-1.5 text-sm font-medium tracking-tight">
                    <span className="relative inline-grid size-5 place-items-center" aria-hidden="true">
                        <PlusCircle className="size-[18px] opacity-80" />
                        <MousePointer2 className="absolute -bottom-1 -right-1 size-3.5 fill-current stroke-[1.5]" />
                    </span>
                    <span>双击画布 <span className="mx-1 opacity-45">·</span> 自由生成节点</span>
                </div>
                {onOpenAssistant ? (
                    <button
                        type="button"
                        className="mt-1.5 rounded-md px-2.5 py-1 text-xs opacity-70 transition-opacity hover:opacity-100"
                        style={{ color: theme.node.muted }}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onClick={onOpenAssistant}
                    >
                        或让助手搭个草案 <span className="ml-1 opacity-70">⌘J</span>
                    </button>
                ) : null}
                <div className="pointer-events-auto mt-6 grid w-full max-w-[720px] grid-cols-1 gap-2 sm:grid-cols-3" data-testid="canvas-empty-templates">
                    {templateActions.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            aria-label={item.label}
                            title={item.description}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onClick={() => item.onClick?.()}
                            className="group flex min-h-[72px] min-w-0 flex-col items-start gap-2 rounded-lg border px-3 py-3 text-left shadow-sm outline-none transition hover:-translate-y-0.5 hover:brightness-105 focus-visible:ring-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                            style={{ background: theme.node.fill, borderColor: theme.node.stroke, boxShadow: theme.node.shadow, "--tw-ring-color": theme.accent.primary } as CSSProperties}
                        >
                            <span className="grid size-8 place-items-center rounded-md" style={{ color: "#fff", background: item.accent }}>{item.icon}</span>
                            <span className="text-xs font-semibold leading-4">{item.label}</span>
                            <span className="line-clamp-2 text-[10px] leading-4" style={{ color: theme.node.muted }}>{item.description}</span>
                        </button>
                    ))}
                </div>
                {onTidyLayout ? (
                    <button
                        type="button"
                        className="pointer-events-auto mt-3 rounded-md px-2.5 py-1 text-xs opacity-70 transition-opacity hover:opacity-100"
                        style={{ color: theme.node.muted }}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onClick={onTidyLayout}
                    >
                        {CANVAS_TIDY_LAYOUT_LABEL}（有节点后可用）
                    </button>
                ) : null}
                <button type="button" aria-label="添加第一项" className="sr-only" tabIndex={-1} onClick={() => commandById.get("text")?.onClick()} />
            </div>
            {connectionsHintOpen ? (
                <div
                    className="canvas-connections-hint pointer-events-auto fixed bottom-[52px] left-[176px] z-[var(--z-toolbar)] flex min-w-[218px] items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium shadow-lg max-sm:hidden"
                    style={{ background: "#6fe8e5", color: "#10292a" }}
                >
                    <span>点击可显示/隐藏画布上的连线</span>
                    <button
                        type="button"
                        aria-label="关闭连线提示"
                        className="grid size-4 shrink-0 place-items-center rounded-full transition hover:bg-black/10"
                        onClick={() => {
                            setConnectionsHintOpen(false);
                            try { window.localStorage.setItem("canvas:connections-hint-dismissed", "1"); } catch { /* ignore */ }
                        }}
                    >
                        <X className="size-3.5" />
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function PathCard({ icon, title, description, action, accent, theme, focusStyle, onClick }: {
    icon: ReactNode;
    title: string;
    description: string;
    action: string;
    accent: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    focusStyle: CSSProperties;
    onClick: () => void;
}) {
    return (
        <section className="flex min-h-[176px] flex-col rounded-lg border p-4 shadow-sm backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
            <span className="grid size-9 place-items-center rounded-md" style={{ background: `${accent}16`, color: accent }}>{icon}</span>
            <div className="mt-3 text-base font-semibold">{title}</div>
            <p className="mt-1 min-h-10 text-sm leading-5" style={{ color: theme.node.muted }}>{description}</p>
            <button type="button" className="mt-auto inline-flex h-9 w-full items-center justify-between rounded-md border px-3 text-sm font-semibold outline-none transition hover:brightness-105 focus-visible:ring-2" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text, ...focusStyle }} onClick={onClick}>
                <span>{action}</span><ArrowRight className="size-4" />
            </button>
        </section>
    );
}

export function CanvasShortDramaGuide({ progress, collapsed, onToggle, onSkip, onStepClick }: {
    progress: CanvasShortDramaProgress;
    collapsed: boolean;
    onToggle: () => void;
    onSkip: () => void;
    onStepClick: (stepId: CanvasShortDramaStepId) => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    if (!progress.active || collapsed) return null;
    return (
        <div data-canvas-no-zoom className="absolute left-1/2 top-[var(--canvas-topbar-offset)] z-[var(--z-toolbar)] flex max-w-[calc(100%_-_24px)] -translate-x-1/2 items-center gap-1 rounded-lg border p-1 shadow-sm backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
            <div className="hide-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto">
                <div className="flex shrink-0 items-center px-[var(--space-1)]">
                    {progress.steps.map((step, index) => (
                        <Fragment key={step.id}>
                            {index ? (
                                <span
                                    aria-hidden
                                    className="shrink-0 rounded-full transition-colors duration-150 motion-reduce:transition-none"
                                    style={{ width: "var(--flow-step-track-width)", height: "var(--flow-step-track-height)", background: step.status === "pending" ? theme.node.stroke : theme.accent.primary }}
                                />
                            ) : null}
                            <button
                                type="button"
                                aria-current={step.status === "current" ? "step" : undefined}
                                className="flex h-8 shrink-0 items-center gap-[var(--flow-step-gap)] rounded-md px-[var(--space-1-half)] outline-none transition-colors motion-reduce:transition-none hover:bg-black/5 focus-visible:ring-1 focus-visible:ring-inset dark:hover:bg-white/10"
                                style={{ "--tw-ring-color": theme.accent.primary } as CSSProperties}
                                onClick={() => onStepClick(step.id)}
                            >
                                <span
                                    className="grid shrink-0 place-items-center rounded-full font-semibold transition-all duration-150 motion-reduce:transition-none"
                                    style={{
                                        width: step.status === "current" ? "var(--flow-step-node-current)" : "var(--flow-step-node)",
                                        height: step.status === "current" ? "var(--flow-step-node-current)" : "var(--flow-step-node)",
                                        background: step.status === "pending" ? "transparent" : theme.accent.primary,
                                        border: step.status === "pending" ? "var(--stroke-2) solid var(--cn-stroke)" : "none",
                                        color: step.status === "pending" ? theme.node.muted : theme.accent.onPrimary,
                                        boxShadow: step.status === "current" ? "var(--flow-step-current-glow)" : undefined,
                                        fontSize: step.status === "current" ? "var(--fs-body)" : "var(--fs-caption)",
                                    }}
                                >
                                    {step.status === "completed" ? <Check className="size-3.5" /> : index + 1}
                                </span>
                                <span
                                    className="whitespace-nowrap text-[var(--fs-caption)] font-semibold transition-colors duration-150 motion-reduce:transition-none"
                                    style={{ color: step.status === "current" ? theme.accent.primary : step.status === "completed" ? theme.node.text : theme.node.muted }}
                                >
                                    {step.label}
                                </span>
                            </button>
                        </Fragment>
                    ))}
                </div>
            </div>
            <span className="mx-1 h-4 w-px shrink-0" style={{ background: theme.toolbar.border }} />
            {!progress.completed ? <button type="button" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[var(--fs-label)] outline-none transition hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/10" style={{ color: theme.node.muted, "--tw-ring-color": theme.accent.primary } as CSSProperties} onClick={onSkip}><X className="size-3" />跳过导引</button> : null}
            <button type="button" className="grid size-8 shrink-0 place-items-center rounded-md outline-none transition hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/10" style={{ color: theme.node.muted, "--tw-ring-color": theme.accent.primary } as CSSProperties} onClick={onToggle} aria-label="折叠短剧流程"><ChevronUp className="size-3.5" /></button>
        </div>
    );
}

export function CanvasStylePlaceholderNodeContent({ onChoose }: { onChoose: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    return (
        <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center" style={{ color: theme.node.text }}>
            <span className="grid size-10 place-items-center rounded-md" style={{ background: `${theme.accent.primary}16`, color: theme.accent.primary }}><Palette className="size-5" /></span>
            <div className="mt-3 text-sm font-semibold">项目画风</div>
            <div className="mt-1 text-xs" style={{ color: theme.node.muted }}>待选择</div>
            <button type="button" className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium outline-none transition hover:brightness-105 focus-visible:ring-2" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, "--tw-ring-color": theme.accent.primary } as CSSProperties} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onChoose(); }}><Sparkles className="size-3.5" />选择画风</button>
        </div>
    );
}

export function CanvasStoryInputNodeContent({ node, onEdit }: { node: CanvasNodeData; onEdit: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    const content = (node.metadata?.content || "").replace(/\s+/g, " ").trim();
    return (
        <div className="flex h-full w-full flex-col overflow-hidden p-4" style={{ color: theme.node.text }}>
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2"><span className="grid size-8 shrink-0 place-items-center rounded-md" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }}><AlignLeft className="size-4" /></span><span className="truncate text-sm font-semibold">故事梗概</span></div>
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-hidden border-t pt-3 text-xs leading-6" style={{ borderColor: theme.node.stroke, color: content ? theme.node.muted : theme.node.placeholder }}>{content || "写下题材、角色、冲突和结局方向…"}</div>
            <button type="button" className="mt-3 inline-flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/10" style={{ color: theme.node.text, "--tw-ring-color": theme.accent.primary } as CSSProperties} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onEdit(); }}><Pencil className="size-3.5" />编辑故事</button>
        </div>
    );
}

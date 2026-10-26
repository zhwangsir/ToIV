import { Camera } from "lucide-react";
import type { ReactNode } from "react";

import { StatusBadge } from "@/components/ui/base/badges";
import { ToolButton } from "@/components/ui/base/buttons";
import { EmptyState } from "@/components/ui/product/empty-state";
import { dramaShotBoardColumn, type DramaBoardColumnId } from "@/pages/toiv/drama-shot-board";
import type { ToivDramaShot, ToivFrameVariant } from "@/services/toiv/client";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<DramaBoardColumnId, string> = {
    pending: "待生成",
    generating: "生成中",
    rendered: "已出视频",
    audio: "配音/口型",
    done: "完成",
    failed: "失败",
};

const STATUS_TONE: Record<string, "success" | "warning" | "error" | "neutral"> = {
    done: "success",
    rendered: "success",
    voiced: "success",
    lipsynced: "success",
    rendering: "warning",
    generating: "warning",
    queued: "warning",
    lipsyncing: "warning",
    error: "error",
    failed: "error",
};

function statusLabelZh(status?: string | null): string {
    const s = String(status || "").trim();
    if (!s) return "未知";
    const map: Record<string, string> = {
        pending: "待处理",
        queued: "排队",
        generating: "生成中",
        rendering: "渲染中",
        rendered: "已出视频",
        voiced: "已配音",
        lipsyncing: "口型中",
        lipsynced: "已口型",
        done: "完成",
        error: "失败",
        failed: "失败",
    };
    return map[s] || s;
}

function finishedUrl(shot: ToivDramaShot): string {
    return String(shot.final_clip_url || shot.video_url || "").trim();
}

function sketchUrl(shot: ToivDramaShot): string {
    return String(shot.image_url || "").trim();
}

export type CreationStudioStoryboardFlowProps = {
    shots: readonly ToivDramaShot[];
    selectedShotId?: string | null;
    onSelectShot?: (shotId: string | null) => void;
    frameBusy?: ReadonlySet<string>;
    frameVariants?: Record<string, ToivFrameVariant[]>;
    frameError?: string | null;
    onFrameVariants?: (shotId: string) => void;
    onAdoptFrame?: (shotId: string, url: string) => void;
    emptyHint?: string;
    className?: string;
    footer?: ReactNode;
};

/** Center-stage storyboard cards — TL: 16:9 + PiP 2:3 sketch, no tabs; select expands right pane. */
export function CreationStudioStoryboardFlow({
    shots,
    selectedShotId = null,
    onSelectShot,
    frameBusy,
    frameVariants = {},
    frameError,
    onFrameVariants,
    onAdoptFrame,
    emptyHint = "暂无分镜（在「剧本」段用 AI 拆解或导入词锚定脚本生成）",
    className,
    footer,
}: CreationStudioStoryboardFlowProps) {
    if (shots.length === 0) {
        return (
            <div className={cn("toiv-storyboard-flow", className)} data-testid="creation-studio-storyboard-flow">
                <header className="toiv-storyboard-flow-head">
                    <h2 className="toiv-storyboard-flow-title">分镜卡片</h2>
                </header>
                <EmptyState description={emptyHint} />
            </div>
        );
    }

    return (
        <div className={cn("toiv-storyboard-flow", className)} data-testid="creation-studio-storyboard-flow">
            <header className="toiv-storyboard-flow-head">
                <h2 className="toiv-storyboard-flow-title">分镜卡片</h2>
                <p className="toiv-storyboard-flow-meta">{shots.length} 镜 · PiP 双轨 · 阶段色条可见</p>
            </header>
            {frameError ? <p className="toiv-storyboard-flow-error">{frameError}</p> : null}
            <div className="toiv-storyboard-flow-grid" role="list">
                {shots.map((shot) => {
                    const phase = dramaShotBoardColumn(shot);
                    const variants = frameVariants[shot.id] ?? [];
                    const busy = frameBusy?.has(shot.id);
                    const selected = selectedShotId === shot.id;
                    const finished = finishedUrl(shot);
                    const sketch = sketchUrl(shot);
                    const mainIsVideo = Boolean(finished);
                    const mainSrc = finished || sketch;
                    const pipSrc = mainIsVideo && sketch ? sketch : "";
                    const summary = String(shot.dialogue || shot.prompt || "—").trim() || "—";

                    return (
                        <article
                            key={shot.id}
                            className={cn("toiv-storyboard-card", selected && "is-selected")}
                            role="listitem"
                            tabIndex={0}
                            aria-selected={selected}
                            data-phase={phase}
                            data-shot-id={shot.id}
                            data-testid={`storyboard-card-${shot.id}`}
                            onClick={() => onSelectShot?.(selected ? null : shot.id)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSelectShot?.(selected ? null : shot.id);
                                }
                            }}
                        >
                            <div className={`toiv-storyboard-card-phase is-${phase}`} aria-label={`阶段 ${PHASE_LABEL[phase]}`}>
                                {PHASE_LABEL[phase]}
                            </div>
                            <div className="toiv-storyboard-card-body">
                                <div className="toiv-storyboard-card-top">
                                    <span className="toiv-storyboard-card-idx">#{shot.idx}</span>
                                    <StatusBadge
                                        variant="filled"
                                        tone={STATUS_TONE[shot.status] ?? "neutral"}
                                        label={statusLabelZh(shot.status)}
                                        size="sm"
                                    />
                                </div>
                                <div className={cn("toiv-storyboard-card-media", !mainSrc && "is-empty")} aria-hidden={!mainSrc}>
                                    {mainIsVideo && mainSrc ? (
                                        <video
                                            className="toiv-storyboard-card-main"
                                            src={mainSrc}
                                            muted
                                            playsInline
                                            preload="metadata"
                                            poster={sketch || undefined}
                                        />
                                    ) : mainSrc ? (
                                        <img src={mainSrc} alt="" className="toiv-storyboard-card-main" loading="lazy" />
                                    ) : null}
                                    {pipSrc ? (
                                        <div className="toiv-storyboard-card-pip" title="草图 2:3">
                                            <img src={pipSrc} alt="" loading="lazy" />
                                        </div>
                                    ) : null}
                                </div>
                                <div className="toiv-storyboard-card-footer">
                                    <p className="toiv-storyboard-card-scene">{shot.scene || "未命名场景"}</p>
                                    <p className="toiv-storyboard-card-dialogue">{summary}</p>
                                    <div className="toiv-storyboard-card-meta">
                                        <span>{shot.duration_sec != null ? `${shot.duration_sec}s` : "—"}</span>
                                        <span>
                                            {shot.seam_to_next || "hardcut"}
                                            {shot.seam_anchor ? `·${shot.seam_anchor}` : ""}
                                        </span>
                                    </div>
                                    {onFrameVariants ? (
                                        <div
                                            className="toiv-storyboard-card-actions"
                                            onClick={(e) => e.stopPropagation()}
                                            onKeyDown={(e) => e.stopPropagation()}
                                        >
                                            <ToolButton
                                                size="xs"
                                                variant="ghost"
                                                icon={<Camera />}
                                                label={busy ? "配景中…" : "AI 配景"}
                                                loading={busy}
                                                onClick={() => onFrameVariants(shot.id)}
                                            />
                                            <div className="toiv-storyboard-nine" role="group" aria-label="配景候选">
                                                {variants.map((v) => (
                                                    <button
                                                        key={v.scale}
                                                        type="button"
                                                        className="toiv-storyboard-card-variant"
                                                        title={`采用为关键帧（${v.scale}）`}
                                                        aria-label={`采用${v.scale}为关键帧`}
                                                        onClick={() => onAdoptFrame?.(shot.id, v.url)}
                                                    >
                                                        <img src={v.url} alt={v.scale} loading="lazy" />
                                                    </button>
                                                ))}
                                            </div>
                                            {shot.image_url ? (
                                                <StatusBadge variant="filled" tone="success" label="已有关键帧" size="sm" />
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        </article>
                    );
                })}
            </div>
            {footer}
        </div>
    );
}

/**
 * W2 · 管线C 链尾候选 / 续段 / 取消 —— 从 classic drama-detail 迁入 BeefTV 密台表面。
 * 宿主：drama-workspace shots 段；启动按钮可留在宿主工具条，本面板负责态与改选续段。
 */
import { Clapperboard, Film, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { StatusBadge } from "@/components/ui/base/badges";
import { ToolButton } from "@/components/ui/base/buttons";
import {
    appendCChainSegments,
    cancelJob,
    fetchCChain,
    pickCChainSegment,
    type ToivCChainDetail,
} from "@/services/toiv/client";

export type CChainTailPanelProps = {
    projectId: string;
    /** 宿主 createCChain / 外部刷新时递增，触发重新拉取 */
    refreshToken?: number;
    /** 宿主刚提交的顶层 job_id；有值时开启轮询 */
    activeJobId?: string | null;
    onActiveJobIdChange?: (jobId: string | null) => void;
    onBusyChange?: (busy: boolean) => void;
    onNote?: (note: string | null) => void;
    onProjectReload?: () => void;
};

export function CChainTailPanel({
    projectId,
    refreshToken = 0,
    activeJobId = null,
    onActiveJobIdChange,
    onBusyChange,
    onNote,
    onProjectReload,
}: CChainTailPanelProps) {
    const [chainDetail, setChainDetail] = useState<ToivCChainDetail | null>(null);
    const [pickingId, setPickingId] = useState<string | null>(null);
    const [appendPrompt, setAppendPrompt] = useState("");
    const [appending, setAppending] = useState(false);
    const [cancelling, setCancelling] = useState(false);

    const reloadChain = useCallback(() => {
        void fetchCChain(projectId)
            .then(setChainDetail)
            .catch(() => setChainDetail(null));
    }, [projectId]);

    useEffect(() => {
        reloadChain();
    }, [reloadChain, refreshToken]);

    const chainBusy = Boolean(activeJobId) || Boolean(chainDetail?.active_job_id);
    useEffect(() => {
        onBusyChange?.(chainBusy);
    }, [chainBusy, onBusyChange]);

    useEffect(() => {
        if (!activeJobId) return;
        const tick = () => {
            void fetchCChain(projectId)
                .then((chain) => {
                    setChainDetail(chain);
                    const active = chain.active_job_id;
                    if (!active || active !== activeJobId) {
                        onActiveJobIdChange?.(null);
                        onNote?.(chain.final_url ? "管线C已完成" : "管线C已结束");
                        onProjectReload?.();
                        return;
                    }
                    const done = (chain.segments ?? []).filter(
                        (s) => s.status === "done" || s.shot_status === "rendered",
                    ).length;
                    const total = (chain.segments ?? []).length || 0;
                    onNote?.(`管线C进行中 ${done}/${total} · job ${activeJobId.slice(0, 8)}`);
                })
                .catch(() => {});
        };
        tick();
        const timer = window.setInterval(tick, 8000);
        return () => window.clearInterval(timer);
    }, [activeJobId, projectId, onActiveJobIdChange, onNote, onProjectReload]);

    const segs = chainDetail?.segments ?? [];
    const tail = segs.length ? segs[segs.length - 1] : null;
    const cands = (tail?.candidates ?? []).filter((c) => c && typeof c.id === "string");
    const canPick = !chainBusy && !pickingId && cands.length > 0;
    const canAppend = !chainBusy && !appending;

    if (!chainDetail && cands.length === 0 && !activeJobId) return null;

    return (
        <section
            aria-label="管线C候选与续段"
            className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3"
            data-testid="c-chain-tail-panel"
        >
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">管线C · 链尾候选</h3>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--muted-foreground)]">
                        {segs.length ? `共 ${segs.length} 段` : "尚无链"}
                        {chainDetail?.active_job_id || activeJobId ? " · 作业中" : ""}
                    </span>
                    {activeJobId ? (
                        <ToolButton
                            size="xs"
                            variant="default"
                            icon={<Film />}
                            label={cancelling ? "取消中…" : "取消管线C"}
                            loading={cancelling}
                            onClick={() => {
                                setCancelling(true);
                                void cancelJob(activeJobId)
                                    .then((ok) => {
                                        onActiveJobIdChange?.(null);
                                        onNote?.(ok ? "已请求取消（顶层 job_id）" : "取消失败");
                                        reloadChain();
                                    })
                                    .finally(() => setCancelling(false));
                            }}
                        />
                    ) : null}
                </div>
            </div>

            {cands.length === 0 ? (
                <p className="text-xs text-[var(--muted-foreground)]">链尾暂无候选；出片后可在此改选（仅尾段）。</p>
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
                    {cands.map((c) => (
                        <div
                            key={c.id}
                            className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-2"
                        >
                            {c.url || c.first_frame ? (
                                c.url ? (
                                    <video
                                        src={c.url}
                                        className="aspect-[9/16] w-full rounded-md bg-black object-cover"
                                        muted
                                        playsInline
                                        controls={false}
                                    />
                                ) : (
                                    <img
                                        src={c.first_frame}
                                        alt=""
                                        className="aspect-[9/16] w-full rounded-md object-cover"
                                        loading="lazy"
                                    />
                                )
                            ) : (
                                <div className="flex aspect-[9/16] items-center justify-center rounded-md bg-black/40 text-xs text-[var(--muted-foreground)]">
                                    {c.id.slice(0, 8)}
                                </div>
                            )}
                            <div className="flex items-center justify-between gap-1">
                                {c.is_picked ? (
                                    <StatusBadge variant="filled" tone="success" label="已选" size="sm" />
                                ) : (
                                    <StatusBadge
                                        variant="filled"
                                        tone="neutral"
                                        label={c.status || "候选"}
                                        size="sm"
                                    />
                                )}
                                <ToolButton
                                    size="xs"
                                    variant="default"
                                    label={pickingId === c.id ? "选用中…" : c.is_picked ? "当前" : "选用"}
                                    loading={pickingId === c.id}
                                    disabled={!canPick || !!c.is_picked}
                                    onClick={() => {
                                        if (tail == null) return;
                                        setPickingId(c.id);
                                        void pickCChainSegment(projectId, tail.index, c.id)
                                            .then((next) => {
                                                setChainDetail(next);
                                                onNote?.(`已选候选 ${c.id.slice(0, 8)}`);
                                                onProjectReload?.();
                                            })
                                            .catch((err: unknown) =>
                                                onNote?.(err instanceof Error ? err.message : "改选失败"),
                                            )
                                            .finally(() => setPickingId(null));
                                    }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex flex-wrap items-end gap-2 border-t border-[var(--border)] pt-3">
                <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs text-[var(--muted-foreground)]">
                    续段文案
                    <input
                        value={appendPrompt}
                        onChange={(e) => setAppendPrompt(e.target.value)}
                        disabled={!canAppend}
                        placeholder="追加一段 prompt（makeup）"
                        className="h-8 rounded-md border border-[var(--border)] bg-transparent px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45"
                    />
                </label>
                <ToolButton
                    variant="default"
                    icon={appending ? <Loader2 className="animate-spin" /> : <Clapperboard />}
                    label={appending ? "续段中…" : "续段"}
                    loading={appending}
                    disabled={!canAppend || !appendPrompt.trim()}
                    onClick={() => {
                        const prompt = appendPrompt.trim();
                        if (!prompt) return;
                        setAppending(true);
                        void appendCChainSegments(projectId, {
                            segments: [{ prompt, duration_sec: 6 }],
                            num_candidates: 2,
                            auto_assemble: true,
                        })
                            .then((ack) => {
                                onActiveJobIdChange?.(ack.job_id);
                                setAppendPrompt("");
                                onNote?.(`续段已排队 job ${ack.job_id.slice(0, 8)}`);
                                reloadChain();
                            })
                            .catch((err: unknown) =>
                                onNote?.(err instanceof Error ? err.message : "续段失败"),
                            )
                            .finally(() => setAppending(false));
                    }}
                />
            </div>
        </section>
    );
}

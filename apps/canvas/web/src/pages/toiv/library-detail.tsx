import { ArrowLeft, Clapperboard, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { AppModal } from "@/components/ui/product/app-modal";
import { EmptyState } from "@/components/ui/product/empty-state";
import { fetchBoardItems, toivHttp, type ToivBoardItem } from "@/services/toiv/client";

function statusTag(s: string) {
    if (s === "done") return <StatusBadge variant="filled" tone="success" label="已完成" size="sm" />;
    if (s === "error") return <StatusBadge variant="filled" tone="error" label="失败" size="sm" />;
    if (s === "running") return <StatusBadge variant="filled" tone="loading" label="生成中" size="sm" />;
    return <StatusBadge variant="filled" tone="neutral" label={s} size="sm" />;
}

function metaOf(item: ToivBoardItem): { scene?: string; camera?: string; prompt?: string } {
    try { return JSON.parse(item.shot_meta || "{}"); } catch { return {}; }
}

function firstMedia(job: NonNullable<ToivBoardItem["job"]>): { url: string; video: boolean } | null {
    const url = (job.results || [])[0];
    if (!url) return null;
    return { url, video: /\.(mp4|webm|mov)(\?|$)/i.test(url) || job.kind === "video" };
}

export default function LibraryDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [items, setItems] = useState<ToivBoardItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [preview, setPreview] = useState<ToivBoardItem | null>(null);
    const [recycleTarget, setRecycleTarget] = useState<ToivBoardItem | null>(null);
    const [recycling, setRecycling] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!id) return;
        setLoading(true); setError(false);
        try { setItems(await fetchBoardItems(id)); }
        catch { setError(true); }
        finally { setLoading(false); }
    }, [id]);

    useEffect(() => { void load(); }, [load]);

    const confirmRecycle = useCallback(async () => {
        const item = recycleTarget;
        const job = item?.job;
        if (!job) return;
        setRecycling(true);
        try {
            await toivHttp.delete(`/jobs/${job.id}`);
            setNotice("已移入回收站");
            setRecycleTarget(null);
            void load();
        } catch {
            setNotice("操作失败");
        } finally {
            setRecycling(false);
        }
    }, [recycleTarget, load]);

    return (
        <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">作品集详情</h1>
                    <p className="text-xs leading-5 text-muted-foreground">{items.length} 个条目 · 分镜行与成品作品（实时域：/api/boards/{id?.slice(0, 8)}…/items）</p>
                </div>
                <div className="flex items-center gap-2">
                    <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                    <Link to="/toiv/library"><ToolButton variant="default" icon={<ArrowLeft />} label="返回作品库" /></Link>
                </div>
            </header>

            {notice ? (
                <p role="status" className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground">
                    {notice}
                    <button type="button" className="ml-2 underline text-muted-foreground" onClick={() => setNotice(null)}>关闭</button>
                </p>
            ) : null}

            {loading ? <div className="flex min-h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" /></div>
                : error ? <EmptyState description="读取失败，请刷新重试" />
                : items.length === 0 ? <EmptyState description="这个作品集还是空的" />
                : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                        {items.map((item) => {
                            const job = item.job;
                            const media = job ? firstMedia(job) : null;
                            const meta = metaOf(item);
                            return (
                                <div key={item.id} className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
                                    <button type="button" className="flex h-36 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]" onClick={() => setPreview(item)} aria-label="预览">
                                        {media
                                            ? (media.video
                                                ? <video src={media.url} className="h-full w-full object-cover" muted preload="metadata" />
                                                : <img src={media.url} alt="" className="h-full w-full object-cover" loading="lazy" />)
                                            : <Clapperboard className="h-7 w-7 text-muted-foreground" />}
                                    </button>
                                    <div className="flex flex-1 flex-col gap-1.5 p-3">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-[11px] text-muted-foreground">#{item.sort_order + 1}</span>
                                            {job ? statusTag(job.status) : <StatusBadge variant="filled" tone="neutral" label="分镜占位" size="sm" />}
                                            {job && (
                                                <button type="button" onClick={() => setRecycleTarget(item)} className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-label="移入回收站">
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            )}
                                        </div>
                                        <p className="line-clamp-3 min-h-10 text-xs leading-relaxed text-muted-foreground" title={item.shot_text}>
                                            {item.shot_text || (job?.prompt || "").slice(0, 90) || "—"}
                                        </p>
                                        {meta.camera && <span className="text-[11px] text-muted-foreground">🎥 {meta.camera}</span>}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

            <AppDrawer open={!!preview} onClose={() => setPreview(null)} width={560} title={preview ? `条目 #${preview.sort_order + 1}` : ""}>
                {preview && (() => {
                    const job = preview.job;
                    const media = job ? firstMedia(job) : null;
                    const meta = metaOf(preview);
                    return (
                        <div className="flex flex-col gap-3">
                            {media && (media.video
                                ? <video src={media.url} controls className="w-full rounded-xl" />
                                : <img src={media.url} alt="" className="w-full rounded-xl" />)}
                            {job ? (
                                <div className="flex flex-wrap items-center gap-2">
                                    {statusTag(job.status)}
                                    {job.kind && <StatusBadge variant="filled" tone="neutral" label={job.kind} size="sm" />}
                                    <span className="text-xs text-muted-foreground">{new Date(job.created_at).toLocaleString("zh-CN")}</span>
                                </div>
                            ) : <StatusBadge variant="filled" tone="neutral" label="分镜占位行(尚未挂作品)" size="sm" />}
                            <p className="whitespace-pre-wrap text-sm leading-relaxed">{preview.shot_text || job?.prompt}</p>
                            {meta.scene && <p className="text-xs text-muted-foreground">场景:{meta.scene}</p>}
                            {meta.prompt && <p className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs text-muted-foreground">{meta.prompt}</p>}
                            {job && (
                                <button
                                    type="button"
                                    onClick={() => { setPreview(null); setRecycleTarget(preview); }}
                                    className="inline-flex h-8 w-fit select-none items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-caption font-medium text-status-error transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
                                >
                                    <Trash2 aria-hidden />
                                    <span>移入回收站</span>
                                </button>
                            )}
                        </div>
                    );
                })()}
            </AppDrawer>

            <AppModal
                open={!!recycleTarget}
                onCancel={() => { if (!recycling) setRecycleTarget(null); }}
                title="移入回收站"
                footer={null}
                destroyOnHidden
            >
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-foreground/80">该作品将从板中移除并进入回收站(可在回收站恢复)。</p>
                    <div className="flex justify-end gap-2">
                        <ToolButton variant="default" label="取消" disabled={recycling} onClick={() => setRecycleTarget(null)} />
                        <button
                            type="button"
                            disabled={recycling}
                            aria-busy={recycling || undefined}
                            onClick={() => void confirmRecycle()}
                            className="inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-md bg-status-error px-3 text-caption font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-45"
                        >
                            {recycling ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                            <span>移入回收站</span>
                        </button>
                    </div>
                </div>
            </AppModal>
        </main>
    );
}

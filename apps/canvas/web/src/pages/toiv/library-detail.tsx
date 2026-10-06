import { App as AntApp, Button, Drawer, Empty, Modal, Spin, Tag, Typography } from "antd";
import { ArrowLeft, Clapperboard, Film, Image as ImageIcon, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";

import { fetchBoardItems, toivHttp, type ToivBoardItem } from "@/services/toiv/client";

function statusTag(s: string) {
    if (s === "done") return <Tag color="success" bordered={false}>已完成</Tag>;
    if (s === "error") return <Tag color="error" bordered={false}>失败</Tag>;
    if (s === "running") return <Tag color="processing" bordered={false}>生成中</Tag>;
    return <Tag bordered={false}>{s}</Tag>;
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
    const { message, modal } = AntApp.useApp();
    const [items, setItems] = useState<ToivBoardItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [preview, setPreview] = useState<ToivBoardItem | null>(null);

    const load = useCallback(async () => {
        if (!id) return;
        setLoading(true); setError(false);
        try { setItems(await fetchBoardItems(id)); }
        catch { setError(true); message.error("作品列表读取失败"); }
        finally { setLoading(false); }
    }, [id, message]);

    useEffect(() => { void load(); }, [load]);

    const recycle = useCallback((item: ToivBoardItem) => {
        const job = item.job;
        if (!job) return;
        modal.confirm({
            title: "移入回收站",
            content: `该作品将从板中移除并进入回收站(可在回收站恢复)。`,
            okText: "移入回收站",
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    await toivHttp.delete(`/jobs/${job.id}`);
                    message.success("已移入回收站");
                    void load();
                } catch {
                    message.error("操作失败");
                }
            },
        });
    }, [load, message, modal]);

    return (
        <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                    <Typography.Title level={3} className="!mb-0">作品集详情</Typography.Title>
                    <Typography.Text type="secondary">{items.length} 个条目 · 分镜行与成品作品（实时域：/api/boards/{id?.slice(0, 8)}…/items）</Typography.Text>
                </div>
                <div className="flex items-center gap-2">
                    <Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void load()} loading={loading}>刷新</Button>
                    <Link to="/toiv/library"><Button icon={<ArrowLeft className="h-3.5 w-3.5" />}>返回作品库</Button></Link>
                </div>
            </header>

            {loading ? <div className="flex min-h-64 items-center justify-center"><Spin /></div>
                : error ? <Empty description="读取失败，请刷新重试" />
                : items.length === 0 ? <Empty description="这个作品集还是空的" />
                : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                        {items.map((item) => {
                            const job = item.job;
                            const media = job ? firstMedia(job) : null;
                            const meta = metaOf(item);
                            return (
                                <div key={item.id} className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)]">
                                    <button type="button" className="flex h-36 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]" onClick={() => setPreview(item)} aria-label="预览">
                                        {media
                                            ? (media.video
                                                ? <video src={media.url} className="h-full w-full object-cover" muted preload="metadata" />
                                                : <img src={media.url} alt="" className="h-full w-full object-cover" loading="lazy" />)
                                            : <Clapperboard className="h-7 w-7 text-[var(--muted-foreground,#a8a8a8)]" />}
                                    </button>
                                    <div className="flex flex-1 flex-col gap-1.5 p-3">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">#{item.sort_order + 1}</span>
                                            {job ? statusTag(job.status) : <Tag bordered={false}>分镜占位</Tag>}
                                            {job && (
                                                <button type="button" onClick={() => recycle(item)} className="text-[var(--muted-foreground,#a8a8a8)] opacity-0 transition-opacity group-hover:opacity-100" aria-label="移入回收站">
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            )}
                                        </div>
                                        <p className="line-clamp-3 min-h-10 text-xs leading-relaxed text-[var(--muted-foreground,#a8a8a8)]" title={item.shot_text}>
                                            {item.shot_text || (job?.prompt || "").slice(0, 90) || "—"}
                                        </p>
                                        {meta.camera && <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">🎥 {meta.camera}</span>}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

            <Drawer open={!!preview} onClose={() => setPreview(null)} width={560} title={preview ? `条目 #${preview.sort_order + 1}` : ""}>
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
                                    {job.kind && <Tag bordered={false}>{job.kind}</Tag>}
                                    <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">{new Date(job.created_at).toLocaleString("zh-CN")}</span>
                                </div>
                            ) : <Tag bordered={false}>分镜占位行(尚未挂作品)</Tag>}
                            <p className="whitespace-pre-wrap text-sm leading-relaxed">{preview.shot_text || job?.prompt}</p>
                            {meta.scene && <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">场景:{meta.scene}</p>}
                            {meta.prompt && <p className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs text-[var(--muted-foreground,#a8a8a8)]">{meta.prompt}</p>}
                            {job && <Button danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => { setPreview(null); recycle(preview); }}>移入回收站</Button>}
                        </div>
                    );
                })()}
            </Drawer>
        </main>
    );
}

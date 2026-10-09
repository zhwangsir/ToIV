import {
    ArrowLeft,
    Clapperboard,
    FolderOpen,
    Layers,
    Loader2,
    RefreshCw,
    RotateCcw,
    Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { AppModal } from "@/components/ui/product/app-modal";
import { EmptyState } from "@/components/ui/product/empty-state";
import {
    bulkDeleteJobs,
    deleteBoard,
    deleteJob,
    fetchBoardItems,
    fetchBoards,
    fetchTrash,
    permanentDeleteJob,
    putBoardItems,
    restoreJob,
    undoDeleteJob,
    type ToivBoard,
    type ToivBoardItem,
    type ToivTrashJob,
} from "@/services/toiv/client";
import {
    folderCover,
    formatRetention,
    groupBoardEntries,
    type BoardEntry,
    type BoardFolder,
} from "@/services/toiv/library-group";

function statusTag(s: string) {
    if (s === "done") return <StatusBadge variant="filled" tone="success" label="已完成" size="sm" />;
    if (s === "error") return <StatusBadge variant="filled" tone="error" label="失败" size="sm" />;
    if (s === "queued") return <StatusBadge variant="filled" tone="loading" label="排队中" size="sm" />;
    if (s === "held") return <StatusBadge variant="filled" tone="loading" label="等待资源" size="sm" />;
    if (s === "running") return <StatusBadge variant="filled" tone="loading" label="生成中" size="sm" />;
    return <StatusBadge variant="filled" tone="neutral" label={s} size="sm" />;
}

function metaOf(item: ToivBoardItem): { scene?: string; camera?: string; prompt?: string } {
    try {
        return JSON.parse(item.shot_meta || "{}");
    } catch {
        return {};
    }
}

function firstMedia(job: NonNullable<ToivBoardItem["job"]>): { url: string; video: boolean } | null {
    const url = (job.results || [])[0];
    if (!url) return null;
    return { url, video: /\.(mp4|webm|mov)(\?|$)/i.test(url) || job.kind === "video" };
}

const dangerBtn =
    "inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-md bg-status-error px-3 text-caption font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-45 [&_svg]:size-4";
const ghostDanger =
    "inline-flex h-8 w-fit select-none items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-caption font-medium text-status-error transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";

export default function LibraryDetailPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [board, setBoard] = useState<ToivBoard | null>(null);
    const [items, setItems] = useState<ToivBoardItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [groupVariants, setGroupVariants] = useState(true);
    const [preview, setPreview] = useState<ToivBoardItem | null>(null);
    const [folderOpen, setFolderOpen] = useState<BoardFolder | null>(null);
    const [recycleTarget, setRecycleTarget] = useState<ToivBoardItem[] | null>(null);
    const [recycling, setRecycling] = useState(false);
    const [deleteBoardOpen, setDeleteBoardOpen] = useState(false);
    const [deletingBoard, setDeletingBoard] = useState(false);
    const [showTrash, setShowTrash] = useState(false);
    const [trash, setTrash] = useState<ToivTrashJob[]>([]);
    const [trashLoading, setTrashLoading] = useState(false);
    const [trashBusy, setTrashBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [undoToken, setUndoToken] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!id) return;
        setLoading(true);
        setError(false);
        try {
            const [boards, boardItems] = await Promise.all([fetchBoards(), fetchBoardItems(id)]);
            setBoard(boards.find((b) => b.id === id) ?? null);
            setItems(boardItems);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    const loadTrash = useCallback(async () => {
        setTrashLoading(true);
        try {
            setTrash(await fetchTrash());
        } catch {
            setNotice("回收站加载失败");
        } finally {
            setTrashLoading(false);
        }
    }, []);

    useEffect(() => {
        if (showTrash) void loadTrash();
    }, [showTrash, loadTrash]);

    const entries = useMemo(
        () => groupBoardEntries(items, { groupVariants }),
        [items, groupVariants],
    );

    const confirmRecycle = useCallback(async () => {
        const targets = recycleTarget;
        if (!targets?.length) return;
        setRecycling(true);
        try {
            const jobIds = targets.map((t) => t.job?.id).filter((x): x is string => !!x);
            if (jobIds.length === 0) return;
            if (jobIds.length === 1) {
                const res = await deleteJob(jobIds[0]!);
                setUndoToken(res.undo_token ?? null);
            } else {
                const res = await bulkDeleteJobs(jobIds);
                setUndoToken(res.done.find((d) => d.undo_token)?.undo_token ?? null);
            }
            setNotice(
                jobIds.length > 1
                    ? `已将 ${jobIds.length} 件作品移入回收站（72 小时内可恢复）`
                    : "已移入回收站（72 小时内可恢复）",
            );
            setRecycleTarget(null);
            setPreview(null);
            setFolderOpen(null);
            void load();
        } catch {
            setNotice("移入回收站失败");
        } finally {
            setRecycling(false);
        }
    }, [recycleTarget, load]);

    const handleUndo = useCallback(async () => {
        if (!undoToken) return;
        try {
            await undoDeleteJob(undoToken);
            setNotice("已撤销删除，作品已恢复");
            setUndoToken(null);
            void load();
        } catch {
            setNotice("撤销失败（可能已过期）");
            setUndoToken(null);
        }
    }, [undoToken, load]);

    const handleRemoveFromBoard = useCallback(
        async (item: ToivBoardItem) => {
            if (!id) return;
            try {
                const next = items
                    .filter((it) => it.id !== item.id)
                    .map((it) => ({
                        job_id: it.job?.id ?? "",
                        note: it.note ?? "",
                        shot_text: it.shot_text ?? "",
                        shot_meta: it.shot_meta ?? "",
                    }));
                await putBoardItems(id, next);
                setNotice("已从作品集中移除（作品本身保留）");
                setPreview(null);
                void load();
            } catch {
                setNotice("移除失败");
            }
        },
        [id, items, load],
    );

    const handleDeleteBoard = useCallback(async () => {
        if (!id) return;
        setDeletingBoard(true);
        try {
            await deleteBoard(id);
            navigate("/toiv/library");
        } catch {
            setNotice("删除作品集失败");
            setDeletingBoard(false);
            setDeleteBoardOpen(false);
        }
    }, [id, navigate]);

    const handleRestore = useCallback(
        async (jobId: string) => {
            setTrashBusy(jobId);
            try {
                await restoreJob(jobId);
                setNotice("已从回收站恢复");
                void loadTrash();
                void load();
            } catch {
                setNotice("恢复失败（可能已过保留期）");
            } finally {
                setTrashBusy(null);
            }
        },
        [load, loadTrash],
    );

    const handlePermanent = useCallback(
        async (jobId: string) => {
            setTrashBusy(jobId);
            try {
                await permanentDeleteJob(jobId);
                setNotice("已彻底删除");
                void loadTrash();
            } catch {
                setNotice("彻底删除失败");
            } finally {
                setTrashBusy(null);
            }
        },
        [loadTrash],
    );

    const renderItemCard = (item: ToivBoardItem) => {
        const job = item.job;
        const media = job ? firstMedia(job) : null;
        const meta = metaOf(item);
        return (
            <div
                key={item.id}
                className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)]"
            >
                <button
                    type="button"
                    className="flex h-36 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]"
                    onClick={() => setPreview(item)}
                    aria-label="预览"
                >
                    {media ? (
                        media.video ? (
                            <video src={media.url} className="h-full w-full object-cover" muted preload="metadata" />
                        ) : (
                            <img src={media.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                        )
                    ) : (
                        <Clapperboard className="h-7 w-7 text-[var(--muted-foreground,#a8a8a8)]" />
                    )}
                </button>
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">#{item.sort_order + 1}</span>
                        {job ? statusTag(job.status) : <StatusBadge variant="filled" tone="neutral" label="分镜占位" size="sm" />}
                        {job && (
                            <button
                                type="button"
                                onClick={() => setRecycleTarget([item])}
                                className="text-[var(--muted-foreground,#a8a8a8)] opacity-0 transition-opacity group-hover:opacity-100"
                                aria-label="移入回收站"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                    <p
                        className="line-clamp-3 min-h-10 text-xs leading-relaxed text-[var(--muted-foreground,#a8a8a8)]"
                        title={item.shot_text}
                    >
                        {item.shot_text || (job?.prompt || "").slice(0, 90) || "—"}
                    </p>
                    {meta.camera && (
                        <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">🎥 {meta.camera}</span>
                    )}
                </div>
            </div>
        );
    };

    const renderFolderCard = (folder: BoardFolder) => {
        const cover = folderCover(folder);
        const job = cover.job;
        const media = job ? firstMedia(job) : null;
        return (
            <div
                key={folder.key}
                className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)]"
            >
                <button
                    type="button"
                    className="relative flex h-36 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]"
                    onClick={() => setFolderOpen(folder)}
                    aria-label={folder.variant ? "打开变体组" : "打开批次"}
                >
                    {media ? (
                        media.video ? (
                            <video src={media.url} className="h-full w-full object-cover" muted preload="metadata" />
                        ) : (
                            <img src={media.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                        )
                    ) : (
                        <Layers className="h-7 w-7 text-[var(--muted-foreground,#a8a8a8)]" />
                    )}
                    <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-white">
                        {folder.variant ? "变体" : "批次"} · {folder.members.length}
                    </span>
                </button>
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-foreground">
                            {folder.variant ? "同参变体组" : "内容批次"}
                        </span>
                        <button
                            type="button"
                            onClick={() => setRecycleTarget(folder.members.filter((m) => m.job))}
                            className="text-[var(--muted-foreground,#a8a8a8)] opacity-0 transition-opacity group-hover:opacity-100"
                            aria-label="整组移入回收站"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    </div>
                    <p className="line-clamp-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                        {(job?.prompt || cover.shot_text || "—").slice(0, 90)}
                    </p>
                </div>
            </div>
        );
    };

    const renderEntry = (entry: BoardEntry) =>
        entry.type === "folder" ? renderFolderCard(entry.folder) : renderItemCard(entry.item);

    return (
        <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
            <header className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">
                        {board?.name || "作品集详情"}
                    </h1>
                    <p className="text-xs leading-5 text-[var(--muted-foreground,#a8a8a8)]">
                        {items.length} 个条目
                        {board?.description ? ` · ${board.description}` : ""}
                        {" · "}
                        预览 / 删除 / 回收站 / 变体分组
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <ToolButton
                        variant="default"
                        active={groupVariants}
                        icon={<Layers />}
                        label={groupVariants ? "变体已折叠" : "展开变体"}
                        onClick={() => setGroupVariants((v) => !v)}
                    />
                    <ToolButton
                        variant="default"
                        icon={<FolderOpen />}
                        label="回收站"
                        onClick={() => setShowTrash(true)}
                    />
                    <ToolButton
                        variant="default"
                        icon={<RefreshCw />}
                        label="刷新"
                        onClick={() => void load()}
                        loading={loading}
                    />
                    <ToolButton
                        variant="default"
                        icon={<Trash2 />}
                        label="删除作品集"
                        onClick={() => setDeleteBoardOpen(true)}
                    />
                    <Link to="/toiv/library">
                        <ToolButton variant="default" icon={<ArrowLeft />} label="返回作品库" />
                    </Link>
                </div>
            </header>

            {notice ? (
                <p
                    role="status"
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card,#181818)] px-3 py-2 text-xs text-foreground"
                >
                    <span>{notice}</span>
                    {undoToken ? (
                        <button type="button" className="underline text-foreground" onClick={() => void handleUndo()}>
                            撤销
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="ml-auto underline text-[var(--muted-foreground,#a8a8a8)]"
                        onClick={() => {
                            setNotice(null);
                            setUndoToken(null);
                        }}
                    >
                        关闭
                    </button>
                </p>
            ) : null}

            {loading ? (
                <div className="flex min-h-64 items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" />
                </div>
            ) : error ? (
                <EmptyState description="读取失败，请刷新重试" />
            ) : items.length === 0 ? (
                <EmptyState description="这个作品集还是空的" />
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                    {entries.map(renderEntry)}
                </div>
            )}

            <AppDrawer
                open={!!preview}
                onClose={() => setPreview(null)}
                width={560}
                title={preview ? `条目 #${preview.sort_order + 1}` : ""}
            >
                {preview &&
                    (() => {
                        const job = preview.job;
                        const media = job ? firstMedia(job) : null;
                        const meta = metaOf(preview);
                        return (
                            <div className="flex flex-col gap-3">
                                {media &&
                                    (media.video ? (
                                        <video src={media.url} controls className="w-full rounded-xl" />
                                    ) : (
                                        <img src={media.url} alt="" className="w-full rounded-xl" />
                                    ))}
                                {job ? (
                                    <div className="flex flex-wrap items-center gap-2">
                                        {statusTag(job.status)}
                                        {job.kind && (
                                            <StatusBadge variant="filled" tone="neutral" label={job.kind} size="sm" />
                                        )}
                                        {job.seed != null && (
                                            <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                                seed {job.seed}
                                            </span>
                                        )}
                                        <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                            {new Date(job.created_at).toLocaleString("zh-CN")}
                                        </span>
                                    </div>
                                ) : (
                                    <StatusBadge variant="filled" tone="neutral" label="分镜占位行(尚未挂作品)" size="sm" />
                                )}
                                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                                    {preview.shot_text || job?.prompt}
                                </p>
                                {meta.scene && (
                                    <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">场景:{meta.scene}</p>
                                )}
                                {meta.prompt && (
                                    <p className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                        {meta.prompt}
                                    </p>
                                )}
                                <div className="flex flex-wrap gap-2">
                                    {job && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setPreview(null);
                                                setRecycleTarget([preview]);
                                            }}
                                            className={ghostDanger}
                                        >
                                            <Trash2 aria-hidden />
                                            <span>移入回收站</span>
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => void handleRemoveFromBoard(preview)}
                                        className="inline-flex h-8 w-fit select-none items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-caption font-medium text-foreground transition-colors hover:bg-surface-hover [&_svg]:size-4"
                                    >
                                        <span>从作品集移除</span>
                                    </button>
                                </div>
                            </div>
                        );
                    })()}
            </AppDrawer>

            <AppDrawer
                open={!!folderOpen}
                onClose={() => setFolderOpen(null)}
                width={640}
                title={
                    folderOpen
                        ? `${folderOpen.variant ? "变体组" : "批次"} · ${folderOpen.members.length} 件`
                        : ""
                }
            >
                {folderOpen && (
                    <div className="flex flex-col gap-3">
                        <div className="flex justify-end">
                            <button
                                type="button"
                                className={ghostDanger}
                                onClick={() => {
                                    setRecycleTarget(folderOpen.members.filter((m) => m.job));
                                    setFolderOpen(null);
                                }}
                            >
                                <Trash2 aria-hidden />
                                <span>整组移入回收站</span>
                            </button>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            {folderOpen.members.map((m) => {
                                const media = m.job ? firstMedia(m.job) : null;
                                return (
                                    <button
                                        key={m.id}
                                        type="button"
                                        className="overflow-hidden rounded-xl border border-[var(--border)] text-left"
                                        onClick={() => {
                                            setFolderOpen(null);
                                            setPreview(m);
                                        }}
                                    >
                                        <div className="flex h-28 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]">
                                            {media ? (
                                                media.video ? (
                                                    <video
                                                        src={media.url}
                                                        className="h-full w-full object-cover"
                                                        muted
                                                        preload="metadata"
                                                    />
                                                ) : (
                                                    <img
                                                        src={media.url}
                                                        alt=""
                                                        className="h-full w-full object-cover"
                                                        loading="lazy"
                                                    />
                                                )
                                            ) : (
                                                <Clapperboard className="h-6 w-6 text-[var(--muted-foreground,#a8a8a8)]" />
                                            )}
                                        </div>
                                        <div className="flex items-center justify-between gap-2 p-2">
                                            <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                                                #{m.sort_order + 1}
                                            </span>
                                            {m.job ? statusTag(m.job.status) : null}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </AppDrawer>

            <AppDrawer open={showTrash} onClose={() => setShowTrash(false)} width={560} title="回收站（72 小时可恢复）">
                <div className="flex flex-col gap-3">
                    <div className="flex justify-end">
                        <ToolButton
                            variant="default"
                            icon={<RefreshCw />}
                            label="刷新"
                            onClick={() => void loadTrash()}
                            loading={trashLoading}
                        />
                    </div>
                    {trashLoading ? (
                        <div className="flex min-h-40 items-center justify-center">
                            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="加载中" />
                        </div>
                    ) : trash.length === 0 ? (
                        <EmptyState description="回收站是空的" />
                    ) : (
                        trash.map((job) => {
                            const media = firstMedia(job);
                            return (
                                <div
                                    key={job.id}
                                    className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--card,#181818)] p-3"
                                >
                                    <div className="flex h-16 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--muted,rgba(255,255,255,0.05))]">
                                        {media ? (
                                            media.video ? (
                                                <video
                                                    src={media.url}
                                                    className="h-full w-full object-cover"
                                                    muted
                                                    preload="metadata"
                                                />
                                            ) : (
                                                <img src={media.url} alt="" className="h-full w-full object-cover" />
                                            )
                                        ) : (
                                            <Clapperboard className="h-5 w-5 text-[var(--muted-foreground,#a8a8a8)]" />
                                        )}
                                    </div>
                                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                                        <p className="line-clamp-2 text-xs text-foreground">
                                            {(job.prompt || job.kind || job.id).slice(0, 120)}
                                        </p>
                                        <p className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                                            {formatRetention(job.restore_remaining_seconds)}
                                        </p>
                                        <div className="mt-1 flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                disabled={trashBusy === job.id}
                                                onClick={() => void handleRestore(job.id)}
                                                className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium hover:bg-surface-hover disabled:opacity-45"
                                            >
                                                <RotateCcw className="size-3.5" aria-hidden />
                                                恢复
                                            </button>
                                            <button
                                                type="button"
                                                disabled={trashBusy === job.id}
                                                onClick={() => void handlePermanent(job.id)}
                                                className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-status-error hover:bg-surface-hover disabled:opacity-45"
                                            >
                                                <Trash2 className="size-3.5" aria-hidden />
                                                彻底删除
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </AppDrawer>

            <AppModal
                open={!!recycleTarget}
                onCancel={() => {
                    if (!recycling) setRecycleTarget(null);
                }}
                title="移入回收站"
                footer={null}
                destroyOnHidden
            >
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-foreground/80">
                        {recycleTarget && recycleTarget.length > 1
                            ? `将把选中的 ${recycleTarget.length} 件作品移入回收站；72 小时内可恢复。`
                            : "该作品将移入回收站；72 小时内可恢复（删除提示中点「撤销」，或到回收站恢复）。"}
                    </p>
                    <div className="flex justify-end gap-2">
                        <ToolButton
                            variant="default"
                            label="取消"
                            disabled={recycling}
                            onClick={() => setRecycleTarget(null)}
                        />
                        <button
                            type="button"
                            disabled={recycling}
                            aria-busy={recycling || undefined}
                            onClick={() => void confirmRecycle()}
                            className={dangerBtn}
                        >
                            {recycling ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                            <span>移入回收站</span>
                        </button>
                    </div>
                </div>
            </AppModal>

            <AppModal
                open={deleteBoardOpen}
                onCancel={() => {
                    if (!deletingBoard) setDeleteBoardOpen(false);
                }}
                title="删除作品集"
                footer={null}
                destroyOnHidden
            >
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-foreground/80">
                        将删除作品集「{board?.name || id}」及其分镜行；
                        <strong>不会删除</strong>成员作品本身（作品仍在作品库/任务中可查）。
                    </p>
                    <div className="flex justify-end gap-2">
                        <ToolButton
                            variant="default"
                            label="取消"
                            disabled={deletingBoard}
                            onClick={() => setDeleteBoardOpen(false)}
                        />
                        <button
                            type="button"
                            disabled={deletingBoard}
                            aria-busy={deletingBoard || undefined}
                            onClick={() => void handleDeleteBoard()}
                            className={dangerBtn}
                        >
                            {deletingBoard ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                            <span>删除作品集</span>
                        </button>
                    </div>
                </div>
            </AppModal>
        </main>
    );
}

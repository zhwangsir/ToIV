import {
    ArrowLeft,
    Clapperboard,
    Download,
    ExternalLink,
    FileDown,
    FolderOpen,
    Image as ImageIcon,
    Layers,
    Loader2,
    Music,
    Pencil,
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
    exportBoardJson,
    fetchBoardItems,
    fetchBoards,
    fetchTrash,
    patchBoard,
    permanentDeleteJob,
    putBoardItems,
    restoreJob,
    undoDeleteJob,
    type ToivBoard,
    type ToivBoardItem,
    type ToivTrashJob,
} from "@/services/toiv/client";
import {
    canvasAddPathForMedia,
    filenameFromMediaUrl,
    folderCover,
    formatRetention,
    groupBoardEntries,
    listJobMedia,
    primaryMedia,
    type BoardEntry,
    type BoardFolder,
    type LibraryMedia,
    type LibraryMediaKind,
} from "@/services/toiv/library-group";
import { WorkspacePage } from "@/components/layout/workspace-page";

function statusTag(s: string) {
    if (s === "done") return <StatusBadge variant="filled" tone="success" label="已完成" size="sm" />;
    if (s === "error") return <StatusBadge variant="filled" tone="error" label="失败" size="sm" />;
    if (s === "queued") return <StatusBadge variant="filled" tone="loading" label="排队中" size="sm" />;
    if (s === "held") return <StatusBadge variant="filled" tone="loading" label="等待资源" size="sm" />;
    if (s === "running") return <StatusBadge variant="filled" tone="loading" label="生成中" size="sm" />;
    return <StatusBadge variant="filled" tone="neutral" label={s} size="sm" />;
}

function metaOf(item: ToivBoardItem): { scene?: string; camera?: string; prompt?: string; [k: string]: unknown } {
    try {
        return JSON.parse(item.shot_meta || "{}");
    } catch {
        return {};
    }
}

function mediaKindLabel(kind: LibraryMediaKind): string {
    if (kind === "video") return "视频";
    if (kind === "audio") return "音频";
    if (kind === "image") return "图片";
    return "媒体";
}

function MediaThumb({ media, className = "h-full w-full object-cover" }: { media: LibraryMedia | null; className?: string }) {
    if (!media) return <Clapperboard className="h-7 w-7 text-[var(--muted-foreground,#a8a8a8)]" />;
    if (media.kind === "video") {
        return <video src={media.url} className={className} muted preload="metadata" />;
    }
    if (media.kind === "audio") {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[var(--muted,rgba(255,255,255,0.05))] text-[var(--muted-foreground,#a8a8a8)]">
                <Music className="h-7 w-7" aria-hidden />
                <span className="text-[10px]">音频</span>
            </div>
        );
    }
    if (media.kind === "image") {
        return <img src={media.url} alt="" className={className} loading="lazy" />;
    }
    return <ImageIcon className="h-7 w-7 text-[var(--muted-foreground,#a8a8a8)]" />;
}

function MediaPreview({ media }: { media: LibraryMedia }) {
    if (media.kind === "video") {
        return <video src={media.url} controls className="w-full rounded-xl bg-black" />;
    }
    if (media.kind === "audio") {
        return (
            <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--muted,rgba(255,255,255,0.05))] p-4">
                <div className="flex items-center gap-2 text-sm text-foreground">
                    <Music className="size-4" aria-hidden />
                    <span>音频预览</span>
                </div>
                <audio src={media.url} controls className="w-full" preload="metadata" />
            </div>
        );
    }
    return <img src={media.url} alt="" className="w-full rounded-xl" />;
}

function triggerBrowserDownload(url: string, filename: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function downloadJsonFile(filename: string, doc: unknown) {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    triggerBrowserDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

const dangerBtn =
    "inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-md bg-status-error px-3 text-caption font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-45 [&_svg]:size-4";
const ghostDanger =
    "inline-flex h-8 w-fit select-none items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-caption font-medium text-status-error transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";
const ghostBtn =
    "inline-flex h-8 w-fit select-none items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-caption font-medium text-foreground transition-colors hover:bg-surface-hover [&_svg]:size-4";

export default function LibraryDetailPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [board, setBoard] = useState<ToivBoard | null>(null);
    const [items, setItems] = useState<ToivBoardItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [groupVariants, setGroupVariants] = useState(true);
    const [preview, setPreview] = useState<ToivBoardItem | null>(null);
    const [previewMediaIndex, setPreviewMediaIndex] = useState(0);
    const [folderOpen, setFolderOpen] = useState<BoardFolder | null>(null);
    const [recycleTarget, setRecycleTarget] = useState<ToivBoardItem[] | null>(null);
    const [recycling, setRecycling] = useState(false);
    const [deleteBoardOpen, setDeleteBoardOpen] = useState(false);
    const [deletingBoard, setDeletingBoard] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameName, setRenameName] = useState("");
    const [renameDesc, setRenameDesc] = useState("");
    const [renaming, setRenaming] = useState(false);
    const [exporting, setExporting] = useState(false);
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

    useEffect(() => {
        setPreviewMediaIndex(0);
    }, [preview?.id]);

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

    const doneCount = useMemo(
        () => items.filter((it) => it.job?.status === "done").length,
        [items],
    );

    const openPreview = useCallback((item: ToivBoardItem) => {
        setPreviewMediaIndex(0);
        setPreview(item);
    }, []);

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

    const openRename = useCallback(() => {
        setRenameName(board?.name ?? "");
        setRenameDesc(board?.description ?? "");
        setRenameOpen(true);
    }, [board]);

    const handleRename = useCallback(async () => {
        if (!id) return;
        const name = renameName.trim();
        if (!name) {
            setNotice("作品集名称不能为空");
            return;
        }
        setRenaming(true);
        try {
            const next = await patchBoard(id, { name, description: renameDesc.trim() });
            setBoard(next);
            setRenameOpen(false);
            setNotice("作品集已更新");
        } catch {
            setNotice("改名失败");
        } finally {
            setRenaming(false);
        }
    }, [id, renameName, renameDesc]);

    const handleExport = useCallback(async () => {
        if (!id) return;
        setExporting(true);
        try {
            const { filename, doc } = await exportBoardJson(id);
            downloadJsonFile(filename, doc);
            setNotice(`已导出 ${filename}`);
        } catch {
            setNotice("导出失败");
        } finally {
            setExporting(false);
        }
    }, [id]);

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
        const media = job ? primaryMedia(job) : null;
        const meta = metaOf(item);
        const mediaCount = job ? listJobMedia(job).length : 0;
        return (
            <div
                key={item.id}
                className="group flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card,#181818)]"
            >
                <button
                    type="button"
                    className="relative flex h-36 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]"
                    onClick={() => openPreview(item)}
                    aria-label="预览"
                >
                    <MediaThumb media={media} />
                    {mediaCount > 1 ? (
                        <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-white">
                            {mediaCount} 个结果
                        </span>
                    ) : null}
                    {media ? (
                        <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-white">
                            {mediaKindLabel(media.kind)}
                        </span>
                    ) : null}
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
                    {job?.kind ? (
                        <span className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">{job.kind}</span>
                    ) : null}
                </div>
            </div>
        );
    };

    const renderFolderCard = (folder: BoardFolder) => {
        const cover = folderCover(folder);
        const job = cover.job;
        const media = job ? primaryMedia(job) : null;
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
                    <MediaThumb media={media} />
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

    const previewMedias = preview?.job ? listJobMedia(preview.job) : [];
    const activePreviewMedia =
        previewMedias[Math.min(previewMediaIndex, Math.max(0, previewMedias.length - 1))] ?? null;

    return (
        <WorkspacePage fluid className="toiv-library-detail-page">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
            <header className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold leading-7 text-foreground">
                        {board?.name || "作品集详情"}
                    </h1>
                    <p className="text-xs leading-5 text-[var(--muted-foreground,#a8a8a8)]">
                        {items.length} 个条目
                        {doneCount ? ` · ${doneCount} 已完成` : ""}
                        {board?.description ? ` · ${board.description}` : ""}
                        {" · "}
                        预览 / 下载 / 画布 / 改名 / 导出 / 回收站
                    </p>
                    {board?.created_at ? (
                        <p className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                            创建于 {new Date(board.created_at).toLocaleString("zh-CN")}
                            {board.id ? ` · id ${board.id.slice(0, 8)}…` : ""}
                        </p>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <ToolButton
                        variant="default"
                        active={groupVariants}
                        icon={<Layers />}
                        label={groupVariants ? "变体已折叠" : "展开变体"}
                        onClick={() => setGroupVariants((v) => !v)}
                    />
                    <ToolButton variant="default" icon={<Pencil />} label="改名" onClick={openRename} />
                    <ToolButton
                        variant="default"
                        icon={<FileDown />}
                        label="导出 JSON"
                        onClick={() => void handleExport()}
                        loading={exporting}
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
                width={600}
                title={preview ? `条目 #${preview.sort_order + 1}` : ""}
            >
                {preview &&
                    (() => {
                        const job = preview.job;
                        const meta = metaOf(preview);
                        const medias = previewMedias;
                        const media = activePreviewMedia;
                        return (
                            <div className="flex flex-col gap-3">
                                {media ? <MediaPreview media={media} /> : null}
                                {medias.length > 1 ? (
                                    <div className="flex flex-wrap gap-2">
                                        {medias.map((m, idx) => (
                                            <button
                                                key={`${m.url}-${idx}`}
                                                type="button"
                                                onClick={() => setPreviewMediaIndex(idx)}
                                                className={`overflow-hidden rounded-lg border ${
                                                    idx === previewMediaIndex
                                                        ? "border-[var(--workspace-accent,#f5f5f5)]"
                                                        : "border-[var(--border)]"
                                                }`}
                                                aria-label={`结果 ${idx + 1}`}
                                            >
                                                <div className="flex h-14 w-20 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]">
                                                    <MediaThumb media={m} />
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                ) : null}

                                {job ? (
                                    <div className="flex flex-wrap items-center gap-2">
                                        {statusTag(job.status)}
                                        {job.kind && (
                                            <StatusBadge variant="filled" tone="neutral" label={job.kind} size="sm" />
                                        )}
                                        {media ? (
                                            <StatusBadge
                                                variant="filled"
                                                tone="neutral"
                                                label={mediaKindLabel(media.kind)}
                                                size="sm"
                                            />
                                        ) : null}
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

                                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl border border-[var(--border)] bg-[var(--muted,rgba(255,255,255,0.03))] p-3 text-xs">
                                    {job?.id ? (
                                        <>
                                            <dt className="text-[var(--muted-foreground,#a8a8a8)]">作业 id</dt>
                                            <dd className="break-all font-mono text-foreground">{job.id}</dd>
                                        </>
                                    ) : null}
                                    {job?.batch_id ? (
                                        <>
                                            <dt className="text-[var(--muted-foreground,#a8a8a8)]">批次</dt>
                                            <dd className="break-all font-mono text-foreground">{job.batch_id}</dd>
                                        </>
                                    ) : null}
                                    {job?.parent_id ? (
                                        <>
                                            <dt className="text-[var(--muted-foreground,#a8a8a8)]">父作业</dt>
                                            <dd className="break-all font-mono text-foreground">{job.parent_id}</dd>
                                        </>
                                    ) : null}
                                    {job?.root_id ? (
                                        <>
                                            <dt className="text-[var(--muted-foreground,#a8a8a8)]">根作业</dt>
                                            <dd className="break-all font-mono text-foreground">{job.root_id}</dd>
                                        </>
                                    ) : null}
                                    {job?.post_status ? (
                                        <>
                                            <dt className="text-[var(--muted-foreground,#a8a8a8)]">后处理</dt>
                                            <dd className="text-foreground">{job.post_status}</dd>
                                        </>
                                    ) : null}
                                    {preview.note ? (
                                        <>
                                            <dt className="text-[var(--muted-foreground,#a8a8a8)]">备注</dt>
                                            <dd className="text-foreground">{preview.note}</dd>
                                        </>
                                    ) : null}
                                    {medias.length ? (
                                        <>
                                            <dt className="text-[var(--muted-foreground,#a8a8a8)]">结果数</dt>
                                            <dd className="text-foreground">{medias.length}</dd>
                                        </>
                                    ) : null}
                                    {job?.error ? (
                                        <>
                                            <dt className="text-status-error">错误</dt>
                                            <dd className="text-status-error">{job.error}</dd>
                                        </>
                                    ) : null}
                                </dl>

                                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                                    {preview.shot_text || job?.prompt}
                                </p>
                                {meta.scene && (
                                    <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">场景:{meta.scene}</p>
                                )}
                                {meta.camera && (
                                    <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">运镜:{String(meta.camera)}</p>
                                )}
                                {meta.prompt && (
                                    <p className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                        {String(meta.prompt)}
                                    </p>
                                )}

                                <div className="flex flex-wrap gap-2">
                                    {media ? (
                                        <button
                                            type="button"
                                            className={ghostBtn}
                                            onClick={() =>
                                                triggerBrowserDownload(
                                                    media.url,
                                                    filenameFromMediaUrl(media.url, `toiv-${job?.id || preview.id}`),
                                                )
                                            }
                                        >
                                            <Download aria-hidden />
                                            <span>下载{medias.length > 1 ? `（当前 ${previewMediaIndex + 1}/${medias.length}）` : ""}</span>
                                        </button>
                                    ) : null}
                                    {media && media.kind !== "unknown" ? (
                                        <Link to={canvasAddPathForMedia(media.kind)} className={ghostBtn}>
                                            <ExternalLink aria-hidden />
                                            <span>在画布打开（{mediaKindLabel(media.kind)}节点）</span>
                                        </Link>
                                    ) : null}
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
                                        className={ghostBtn}
                                    >
                                        <span>从作品集移除</span>
                                    </button>
                                </div>
                                {media ? (
                                    <p className="text-[11px] text-[var(--muted-foreground,#a8a8a8)]">
                                        画布深链会新建空白{mediaKindLabel(media.kind)}节点；请先下载媒体再拖入节点（不走自动接线，避免假手递）。
                                    </p>
                                ) : null}
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
                                const media = m.job ? primaryMedia(m.job) : null;
                                return (
                                    <button
                                        key={m.id}
                                        type="button"
                                        className="overflow-hidden rounded-xl border border-[var(--border)] text-left"
                                        onClick={() => {
                                            setFolderOpen(null);
                                            openPreview(m);
                                        }}
                                    >
                                        <div className="flex h-28 items-center justify-center bg-[var(--muted,rgba(255,255,255,0.05))]">
                                            <MediaThumb media={media} />
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
                            const media = primaryMedia(job);
                            return (
                                <div
                                    key={job.id}
                                    className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--card,#181818)] p-3"
                                >
                                    <div className="flex h-16 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--muted,rgba(255,255,255,0.05))]">
                                        <MediaThumb media={media} />
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
                open={renameOpen}
                onCancel={() => {
                    if (!renaming) setRenameOpen(false);
                }}
                title="改名作品集"
                footer={null}
                destroyOnHidden
            >
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                        名称
                        <input
                            value={renameName}
                            onChange={(e) => setRenameName(e.target.value)}
                            maxLength={64}
                            className="h-9 rounded-md border border-border bg-[var(--card,#181818)] px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                        描述（可选）
                        <textarea
                            value={renameDesc}
                            onChange={(e) => setRenameDesc(e.target.value)}
                            maxLength={500}
                            rows={3}
                            className="rounded-md border border-border bg-[var(--card,#181818)] px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                    </label>
                    <div className="flex justify-end gap-2">
                        <ToolButton
                            variant="default"
                            label="取消"
                            disabled={renaming}
                            onClick={() => setRenameOpen(false)}
                        />
                        <ToolButton
                            variant="default"
                            label="保存"
                            loading={renaming}
                            onClick={() => void handleRename()}
                        />
                    </div>
                </div>
            </AppModal>

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
        </div>
        </WorkspacePage>
    );
}

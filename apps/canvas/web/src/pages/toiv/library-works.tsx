import { ArrowLeft, Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { EmptyState } from "@/components/ui/product/empty-state";
import { ToolButton } from "@/components/ui/base/buttons";
import { toivCoverImageUrl, toivMediaUrl } from "@/services/toiv/cover-url";
import {
    deleteToivWork,
    fetchToivTrashPage,
    fetchToivWorksPage,
    rerunToivWork,
    restoreToivWork,
    type ToivWorkJob,
} from "@/services/toiv/client";

/**
 * 作品库「作品」面 v1(2026-10-14 融合批):canvas 侧 SFW 作品网格。
 *
 * 为什么是 v1 而不是整页搬:经典 LibraryView 有 4275 行(收藏/保存视图/密度/3D/超分/批量删除…),
 * 一次搬完不可验证也不可回滚。本面先覆盖高频主链路:浏览(分页/类型/搜索/排序)→ 打开详情 →
 * 重跑 → 删除(软删)→ 回收站恢复;其余能力仍在经典壳,经 ?classic=1 可达(见 apps/web page.tsx)。
 * R18 不进 canvas:/api/jobs 在无 R18 意图头时本就不返回 R18 作品,与「canvas 纯 SFW」拍板一致。
 */

const KIND_TABS = [
    { key: "", label: "全部" },
    { key: "image", label: "图片" },
    { key: "video", label: "视频" },
    { key: "audio", label: "音频" },
    { key: "3d", label: "3D" },
] as const;

const PAGE_SIZE = 60;

function formatTime(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

function statusLabel(job: ToivWorkJob): { text: string; tone: "ok" | "run" | "err" } {
    if (job.status === "done" || job.status === "success") return { text: "完成", tone: "ok" };
    if (job.status === "error" || job.status === "failed") return { text: "失败", tone: "err" };
    if (job.status === "processing" || job.status === "queued" || job.status === "running") return { text: "生成中", tone: "run" };
    return { text: job.status || "—", tone: "run" };
}

export default function LibraryWorks() {
    const [kind, setKind] = useState<string>("");
    const [query, setQuery] = useState("");
    const [sortNewest, setSortNewest] = useState(true);
    const [trashMode, setTrashMode] = useState(false);

    const [items, setItems] = useState<ToivWorkJob[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [confirmId, setConfirmId] = useState<string | null>(null);

    const load = useCallback(async (mode: "reset" | "more") => {
        if (mode === "reset") setLoading(true);
        else setLoadingMore(true);
        setError(false);
        try {
            if (trashMode) {
                const rows = await fetchToivTrashPage({ limit: PAGE_SIZE });
                setItems(rows);
                setHasMore(false);
            } else {
                const offset = mode === "more" ? items.length : 0;
                const page = await fetchToivWorksPage({ limit: PAGE_SIZE, offset, kind: kind || undefined });
                setItems(mode === "more" ? [...items, ...page.items] : page.items);
                setHasMore(page.hasMore);
            }
        } catch {
            setError(true);
        } finally {
            setLoading(false);
            setLoadingMore(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, trashMode, items.length]);

    useEffect(() => {
        void load("reset");
    }, [kind, trashMode]); // eslint-disable-line react-hooks/exhaustive-deps

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        const rows = q ? items.filter((j) => (j.prompt || "").toLowerCase().includes(q) || (j.app_name || "").toLowerCase().includes(q)) : items;
        return sortNewest ? rows : [...rows].reverse();
    }, [items, query, sortNewest]);

    const act = useCallback(async (job: ToivWorkJob, op: "delete" | "restore" | "rerun") => {
        setBusyId(job.id);
        try {
            if (op === "delete") await deleteToivWork(job.id);
            if (op === "restore") await restoreToivWork(job.id);
            if (op === "rerun") await rerunToivWork(job.id);
            setItems((prev) => (op === "rerun" ? prev : prev.filter((j) => j.id !== job.id)));
        } finally {
            setBusyId(null);
            setConfirmId(null);
        }
    }, []);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                {!trashMode &&
                    KIND_TABS.map((t) => (
                        <button
                            key={t.key || "all"}
                            type="button"
                            aria-pressed={kind === t.key}
                            onClick={() => setKind(t.key)}
                            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                                kind === t.key
                                    ? "border-transparent bg-[var(--workspace-accent,#f5f5f5)] text-[var(--workspace-accent-foreground,#111)]"
                                    : "border-[var(--border-semantic,var(--border,#333))] text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                <div className="ml-auto flex items-center gap-2">
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索提示词 / 来源应用"
                        aria-label="搜索作品"
                        className="h-8 w-52 rounded-md border border-[var(--border-semantic,var(--border,#333))] bg-transparent px-2 text-xs text-foreground outline-none focus:border-[var(--workspace-accent,#888)]"
                    />
                    <ToolButton
                        variant="ghost"
                        icon={<RefreshCw />}
                        label={sortNewest ? "最新优先" : "最早优先"}
                        onClick={() => setSortNewest((v) => !v)}
                    />
                    <ToolButton
                        variant={trashMode ? "default" : "ghost"}
                        icon={<Trash2 />}
                        label={trashMode ? "回收站中" : "回收站"}
                        onClick={() => setTrashMode((v) => !v)}
                    />
                    <ToolButton variant="ghost" icon={<RefreshCw />} label="刷新" onClick={() => void load("reset")} loading={loading} />
                </div>
            </div>

            {loading ? (
                <div className="flex min-h-64 items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" />
                </div>
            ) : error ? (
                <EmptyState description="读取作品失败,请刷新重试" />
            ) : visible.length === 0 ? (
                <EmptyState description={trashMode ? "回收站是空的" : "还没有作品;生成第一个作品后会出现在这里"} />
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                    {visible.map((job) => {
                        const st = statusLabel(job);
                        const cover = job.results?.[0] ?? "";
                        const isVideo = /\.(mp4|webm|mov|m4v)$/i.test(cover);
                        return (
                            <div
                                key={job.id}
                                className="group flex flex-col overflow-hidden rounded-[var(--card-radius,12px)] bg-[var(--card-surface,#f7f7f7)] transition-colors hover:bg-[var(--card-surface-hover,#f0f0f0)]"
                            >
                                <Link to={`/library/works/${job.id}`} className="block aspect-video w-full overflow-hidden bg-black/20">
                                    {cover ? (
                                        isVideo ? (
                                            <video src={toivMediaUrl(cover)} muted preload="metadata" className="size-full object-cover" />
                                        ) : (
                                            <img src={toivCoverImageUrl(cover)} alt="" loading="lazy" className="size-full object-cover" />
                                        )
                                    ) : (
                                        <div className="flex size-full items-center justify-center text-xs text-muted-foreground">无预览</div>
                                    )}
                                </Link>
                                <div className="flex flex-col gap-1 p-3">
                                    <div className="flex items-center gap-2 text-[11px]">
                                        <span
                                            className={
                                                st.tone === "ok"
                                                    ? "text-[var(--success,#4ade80)]"
                                                    : st.tone === "err"
                                                      ? "text-[var(--destructive,#f87171)]"
                                                      : "text-muted-foreground"
                                            }
                                        >
                                            {st.text}
                                        </span>
                                        <span className="text-muted-foreground">{job.kind || "—"}</span>
                                        {job.app_name ? <span className="truncate text-muted-foreground">· {job.app_name}</span> : null}
                                        <span className="ml-auto shrink-0 text-muted-foreground">{formatTime(job.created_at)}</span>
                                    </div>
                                    <p className="line-clamp-2 min-h-8 text-xs leading-4 text-foreground" title={job.prompt}>
                                        {job.prompt || job.error || "（无提示词）"}
                                    </p>
                                    <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                                        {trashMode ? (
                                            <ToolButton
                                                variant="ghost"
                                                icon={<RotateCcw />}
                                                label="恢复"
                                                loading={busyId === job.id}
                                                onClick={() => void act(job, "restore")}
                                            />
                                        ) : (
                                            <>
                                                <ToolButton
                                                    variant="ghost"
                                                    icon={<RefreshCw />}
                                                    label="重跑"
                                                    loading={busyId === job.id}
                                                    onClick={() => void act(job, "rerun")}
                                                />
                                                {confirmId === job.id ? (
                                                    <ToolButton
                                                        variant="default"
                                                        icon={<Trash2 />}
                                                        label="确认删除"
                                                        loading={busyId === job.id}
                                                        onClick={() => void act(job, "delete")}
                                                    />
                                                ) : (
                                                    <ToolButton variant="ghost" icon={<Trash2 />} label="删除" onClick={() => setConfirmId(job.id)} />
                                                )}
                                                <Link to={`/library/works/${job.id}`} className="ml-auto">
                                                    <ToolButton variant="ghost" icon={<ArrowLeft className="rotate-180" />} label="打开" />
                                                </Link>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {!trashMode && hasMore ? (
                <div className="flex justify-center">
                    <ToolButton variant="default" icon={<RefreshCw />} label="加载更多" loading={loadingMore} onClick={() => void load("more")} />
                </div>
            ) : null}
        </div>
    );
}

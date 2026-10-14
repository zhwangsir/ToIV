import { Loader2, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { EmptyState } from "@/components/ui/product/empty-state";
import { toivMediaUrl } from "@/services/toiv/cover-url";
import {
    searchMediaTranscripts,
    type ToivTranscriptHit,
} from "@/services/toiv/transcript-search";

/**
 * F11(2026-10-15):媒体库「台词检索」面(admin-only,由 library-page 按角色门禁挂载)。
 *
 * 交互:300ms 防抖输入 → searchMediaTranscripts(/api/admin/media/transcripts/search)→
 * 结果卡(缩略/命中文本/来源标签/时长)→ 点卡打开预览浮层。
 * 预览复用 library-works 的页面内置浮层模式(role=dialog + Esc 关闭),
 * **不把媒体地址/id 路由进画板详情路由**(那条 :id 是画板 id,喂别的东西必 404,10-14 实测回归)。
 */

const DEBOUNCE_MS = 300;

function formatDuration(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return "—";
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

function mediaName(url: string): string {
    const clean = (url || "").split(/[?#]/, 1)[0] ?? "";
    return decodeURIComponent(clean.split("/").pop() || clean) || "未知媒体";
}

export default function LibraryTranscriptSearch() {
    const [query, setQuery] = useState("");
    const [items, setItems] = useState<ToivTranscriptHit[]>([]);
    const [searched, setSearched] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<ToivTranscriptHit | null>(null);

    // 300ms 防抖 + AbortController:输入连打时旧请求作废,避免竞态把旧结果盖到新结果上
    useEffect(() => {
        const q = query.trim();
        if (!q) {
            setItems([]);
            setSearched(false);
            setError(null);
            setLoading(false);
            return;
        }
        const ac = new AbortController();
        setLoading(true);
        const timer = setTimeout(() => {
            searchMediaTranscripts(q, { signal: ac.signal })
                .then((rows) => {
                    setItems(rows);
                    setSearched(true);
                    setError(null);
                })
                .catch((e) => {
                    if (ac.signal.aborted) return;
                    // P-11:检索失败(含形状门抛错)必须透出,不得静默空集
                    setError(e instanceof Error ? e.message : "台词检索失败");
                    setItems([]);
                    setSearched(true);
                })
                .finally(() => {
                    if (!ac.signal.aborted) setLoading(false);
                });
        }, DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            ac.abort();
        };
    }, [query]);

    useEffect(() => {
        if (!preview) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPreview(null); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [preview]);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
                <div className="relative flex-1 max-w-md">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索台词（媒体转录全文）"
                        aria-label="搜索台词"
                        data-testid="transcript-search-input"
                        className="h-9 w-full rounded-md border border-[var(--border-semantic,var(--border,#333))] bg-transparent pl-8 pr-2 text-xs text-foreground outline-none focus:border-[var(--workspace-accent,#888)]"
                    />
                </div>
                {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="检索中" /> : null}
            </div>

            {error ? (
                <EmptyState description={error} />
            ) : !searched && !loading ? (
                <EmptyState description="输入台词关键词，检索已转录媒体（300ms 防抖；仅管理员可见）" />
            ) : items.length === 0 && !loading ? (
                <EmptyState description="没有命中的台词；换个关键词或先为媒体建立转录索引" />
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
                    {items.map((item) => (
                        <button
                            key={item.media_url}
                            type="button"
                            onClick={() => setPreview(item)}
                            aria-label={`预览台词命中 ${mediaName(item.media_url)}`}
                            data-testid="transcript-result-item"
                            className="group flex flex-col overflow-hidden rounded-[var(--card-radius,12px)] bg-[var(--card-surface,#f7f7f7)] text-left transition-colors hover:bg-[var(--card-surface-hover,#f0f0f0)]"
                        >
                            <span className="block aspect-video w-full overflow-hidden bg-black/20">
                                {item.media_url ? (
                                    <video
                                        src={toivMediaUrl(item.media_url)}
                                        muted
                                        preload="metadata"
                                        className="size-full object-cover"
                                    />
                                ) : null}
                            </span>
                            <span className="flex flex-col gap-1 p-3">
                                <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                    <span className="truncate font-medium text-foreground" title={item.media_url}>{mediaName(item.media_url)}</span>
                                    <span className="ml-auto shrink-0">{formatDuration(item.duration_sec)}</span>
                                </span>
                                <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                    {item.source_tag ? (
                                        <span className="rounded-full border border-[var(--border-semantic,var(--border,#333))] px-2 py-0.5">{item.source_tag}</span>
                                    ) : null}
                                    <span>{item.hits.length} 处命中</span>
                                </span>
                                <span className="line-clamp-3 min-h-10 text-xs leading-4 text-foreground">
                                    {item.hits[0] || "（无命中行回显）"}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            )}

            {preview ? (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="台词命中预览"
                    onClick={() => setPreview(null)}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
                >
                    <div
                        className="flex max-h-full w-full max-w-3xl flex-col gap-3 overflow-auto rounded-[var(--card-radius,12px)] bg-[var(--popover,#1f1f1f)] p-4"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-xs text-muted-foreground" title={preview.media_url}>
                                {mediaName(preview.media_url)} · {formatDuration(preview.duration_sec)}
                                {preview.source_tag ? ` · ${preview.source_tag}` : ""}
                            </span>
                            <button type="button" onClick={() => setPreview(null)} aria-label="关闭预览" className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                                关闭 (Esc)
                            </button>
                        </div>
                        <div className="flex max-h-[60vh] items-center justify-center overflow-hidden rounded-lg bg-black/30">
                            {preview.media_url ? (
                                <video src={toivMediaUrl(preview.media_url)} controls autoPlay className="max-h-[60vh] w-full object-contain" />
                            ) : (
                                <span className="p-10 text-xs text-muted-foreground">该记录没有可播放的媒体地址</span>
                            )}
                        </div>
                        <div className="flex flex-col gap-1">
                            {preview.hits.length > 0 ? (
                                preview.hits.map((h, i) => (
                                    <p key={`${i}-${h.slice(0, 24)}`} className="whitespace-pre-wrap text-xs leading-5 text-foreground">{h}</p>
                                ))
                            ) : (
                                <p className="text-xs text-muted-foreground">（无命中行回显）</p>
                            )}
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

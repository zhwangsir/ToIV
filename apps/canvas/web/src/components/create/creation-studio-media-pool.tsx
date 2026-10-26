import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useSyncExternalStore } from "react";
import { AudioLines, Clapperboard, FileText, Image as ImageIcon, Box } from "lucide-react";

import { NsfwLockBadge } from "@/components/toiv/nsfw-lock-badge";
import { cn } from "@/lib/utils";
import {
    COPY_MODE_ADULT,
    COPY_MODE_NORMAL,
    assetLooksNsfw,
    filterNsfwListableAssets,
    getR18ModeSnapshot,
    getServerR18ModeSnapshot,
    isNsfwAssetSelectable,
    subscribeR18Mode,
    type NsfwAssetLike,
} from "@/redline";
import { useAssetStore, type Asset, type AssetKind } from "@/stores/use-asset-store";

import "@/components/create/creation-studio-media-pool.css";

const PAGE = 24;
const KIND_CHIPS: Array<{ value: AssetKind | "all"; label: string }> = [
    { value: "all", label: "全部" },
    { value: "image", label: "图片" },
    { value: "video", label: "视频" },
    { value: "audio", label: "音频" },
    { value: "text", label: "文本" },
    { value: "model", label: "模型" },
];

function assetAsNsfwLike(asset: Asset): NsfwAssetLike {
    const meta = asset.metadata || {};
    return {
        id: asset.id,
        label: asset.title,
        basename: asset.title,
        nsfw: typeof meta.nsfw === "boolean" ? meta.nsfw : undefined,
        is_nsfw: typeof meta.is_nsfw === "boolean" ? meta.is_nsfw : undefined,
        content_rating: typeof meta.content_rating === "string" ? meta.content_rating : undefined,
        content_mode: typeof meta.content_mode === "string" ? meta.content_mode : undefined,
        rating: typeof meta.rating === "string" ? meta.rating : undefined,
        purposeZh: asset.note,
        value: [...(asset.tags || []), asset.source || ""].join(" "),
    };
}

function thumbUrl(asset: Asset): string {
    if (asset.coverUrl) return asset.coverUrl;
    if (asset.kind === "image") return asset.data.dataUrl || "";
    if (asset.kind === "video") return asset.data.url || "";
    return "";
}

function KindGlyph({ kind }: { kind: AssetKind }) {
    const props = { className: "size-4 opacity-50", "aria-hidden": true as const };
    if (kind === "image") return <ImageIcon {...props} />;
    if (kind === "video") return <Clapperboard {...props} />;
    if (kind === "audio") return <AudioLines {...props} />;
    if (kind === "model") return <Box {...props} />;
    return <FileText {...props} />;
}

/** Compact media pool for /create left rail — Freezone cards + NSFW dual-channel lock. */
export function CreationStudioMediaPool({ projectId }: { projectId: string | null }) {
    const navigate = useNavigate();
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const assets = useAssetStore((s) => s.assets);
    const [keyword, setKeyword] = useState("");
    const [kind, setKind] = useState<AssetKind | "all">("all");
    const [activeTag, setActiveTag] = useState<string | null>(null);
    const [visibleCount, setVisibleCount] = useState(PAGE);
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    const library = useMemo(
        () => assets.filter((a): a is Exclude<Asset, { kind: "entity" }> => a.kind !== "entity" && a.status !== "archived"),
        [assets],
    );

    const listable = useMemo(
        () => filterNsfwListableAssets(library, assetAsNsfwLike),
        [library, adultOn], // adultOn flips unknown visibility via nsfwAllowed()
    );

    const smartTags = useMemo(() => {
        const counts = new Map<string, number>();
        for (const asset of listable) {
            for (const tag of asset.tags || []) {
                const t = String(tag || "").trim();
                if (!t) continue;
                counts.set(t, (counts.get(t) || 0) + 1);
            }
        }
        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
            .slice(0, 8)
            .map(([tag]) => tag);
    }, [listable]);

    const filtered = useMemo(() => {
        const q = keyword.trim().toLowerCase();
        return listable.filter((asset) => {
            if (kind !== "all" && asset.kind !== kind) return false;
            if (activeTag && !(asset.tags || []).includes(activeTag)) return false;
            if (!q) return true;
            const blob = [asset.title, asset.note, asset.source, ...(asset.tags || [])].join("\n").toLowerCase();
            return blob.includes(q);
        });
    }, [listable, keyword, kind, activeTag]);

    useEffect(() => {
        setVisibleCount(PAGE);
    }, [keyword, kind, activeTag, adultOn]);

    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return;
        const io = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setVisibleCount((n) => Math.min(filtered.length, n + PAGE));
                }
            },
            { root: el.parentElement, rootMargin: "80px" },
        );
        io.observe(el);
        return () => io.disconnect();
    }, [filtered.length]);

    const slice = filtered.slice(0, visibleCount);
    const lockedCount = useMemo(
        () => filtered.filter((a) => assetLooksNsfw(assetAsNsfwLike(a)) && !isNsfwAssetSelectable(assetAsNsfwLike(a))).length,
        [filtered, adultOn],
    );

    const assetsHref = projectId
        ? `/assets?project=${encodeURIComponent(projectId)}`
        : "/assets";

    return (
        <section className="toiv-asset-pool" data-testid="creation-studio-media-pool" aria-label="媒体池">
            <header className="toiv-asset-pool-head">
                <h3 className="toiv-asset-pool-title">媒体池</h3>
                <span className="toiv-asset-pool-meta">
                    {filtered.length}
                    {lockedCount ? ` · 锁 ${lockedCount}` : ""}
                    {" · "}
                    {adultOn ? COPY_MODE_ADULT : COPY_MODE_NORMAL}
                </span>
            </header>

            <input
                className="toiv-asset-pool-search"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索标题 / 标签…"
                aria-label="搜索媒体池"
            />

            <div className="toiv-asset-pool-filters" role="toolbar" aria-label="类型筛选">
                {KIND_CHIPS.map((chip) => (
                    <button
                        key={chip.value}
                        type="button"
                        className={cn("toiv-asset-pool-chip", kind === chip.value && "is-active")}
                        aria-pressed={kind === chip.value}
                        onClick={() => setKind(chip.value)}
                    >
                        {chip.label}
                    </button>
                ))}
            </div>

            {smartTags.length ? (
                <div className="toiv-asset-pool-filters" role="toolbar" aria-label="智能标签">
                    {smartTags.map((tag) => (
                        <button
                            key={tag}
                            type="button"
                            className={cn("toiv-asset-pool-chip is-tag", activeTag === tag && "is-active")}
                            aria-pressed={activeTag === tag}
                            onClick={() => setActiveTag((cur) => (cur === tag ? null : tag))}
                        >
                            #{tag}
                        </button>
                    ))}
                </div>
            ) : null}

            {filtered.length === 0 ? (
                <div className="toiv-asset-pool-empty" data-testid="creation-studio-media-pool-empty">
                    {library.length === 0 ? (
                        <>
                            暂无本地素材。去 <Link to={assetsHref}>资产库</Link> 上传，或在成片后自动入库。
                        </>
                    ) : !adultOn && listable.length < library.length ? (
                        <>
                            当前为{COPY_MODE_NORMAL}：部分未评级条目已隐藏。切到顶栏「{COPY_MODE_ADULT}」可查看。
                        </>
                    ) : (
                        <>无匹配结果。试试清空筛选，或打开 <Link to={assetsHref}>资产库</Link>。</>
                    )}
                </div>
            ) : (
                <div className="toiv-asset-pool-scroll">
                    <div className="toiv-asset-pool-grid" role="list">
                        {slice.map((asset) => {
                            const like = assetAsNsfwLike(asset);
                            const nsfw = assetLooksNsfw(like);
                            const selectable = isNsfwAssetSelectable(like);
                            const locked = nsfw && !selectable;
                            const src = thumbUrl(asset);
                            return (
                                <article
                                    key={asset.id}
                                    role="listitem"
                                    className={cn("toiv-asset-card", locked && "is-locked is-nsfw-locked")}
                                    data-asset-id={asset.id}
                                    data-nsfw={nsfw ? "1" : "0"}
                                    data-locked={locked ? "1" : "0"}
                                    tabIndex={locked ? -1 : 0}
                                    aria-disabled={locked || undefined}
                                    title={locked ? `已锁定 · NSFW（当前为${COPY_MODE_NORMAL}）` : asset.title}
                                    onClick={() => {
                                        if (locked) return;
                                        navigate(`${assetsHref}${assetsHref.includes("?") ? "&" : "?"}focus=${encodeURIComponent(asset.id)}`);
                                    }}
                                    onKeyDown={(e) => {
                                        if (locked) return;
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            (e.currentTarget as HTMLElement).click();
                                        }
                                    }}
                                >
                                    <div className={cn("toiv-asset-card-thumb", !src && "is-empty")}>
                                        {locked ? (
                                            <span className="toiv-asset-card-lock">
                                                <NsfwLockBadge compact />
                                            </span>
                                        ) : null}
                                        {src && asset.kind === "video" ? (
                                            <video src={src} muted playsInline preload="metadata" />
                                        ) : src ? (
                                            <img src={src} alt="" loading="lazy" />
                                        ) : (
                                            <KindGlyph kind={asset.kind} />
                                        )}
                                    </div>
                                    <div className="toiv-asset-card-body">
                                        <p className="toiv-asset-card-title">{asset.title || "未命名"}</p>
                                        {(asset.tags || []).length ? (
                                            <div className="toiv-asset-card-tags">
                                                {(asset.tags || []).slice(0, 2).map((tag) => (
                                                    <span key={tag} className="toiv-asset-card-tag">
                                                        {tag}
                                                    </span>
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                    <div ref={sentinelRef} className="toiv-asset-pool-sentinel" aria-hidden />
                    {visibleCount < filtered.length ? (
                        <p className="toiv-asset-pool-more">滚动加载 · 已显 {slice.length}/{filtered.length}</p>
                    ) : null}
                </div>
            )}

            <p className="toiv-asset-pool-foot">
                {adultOn
                    ? `${COPY_MODE_ADULT}：成人条目可选。切换在顶栏光幕。`
                    : `${COPY_MODE_NORMAL}：NSFW 灰化+锁标可见不可点；未评级隐藏。`}
            </p>
        </section>
    );
}

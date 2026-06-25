"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { Magnifier } from "@/components/ui/Magnifier";
import { useNsfw } from "@/components/nav/NsfwContext";
import { imageUrl, listJobs } from "@/lib/api";
import { springSoft } from "@/lib/motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import type { JobItem } from "@/lib/types";

import { LazyImage } from "./LazyImage";
import { LazyVideo } from "./LazyVideo";

import "./library-extra.css";

/** 每批增量渲染的瓦片数(无限滚动)。 */
const PAGE_SIZE = 24;

interface Asset {
  key: string;
  url: string;
  kind: string;
  prompt: string;
  seed: number;
}

type AssetKind = "glb" | "audio" | "video" | "image";

const KIND_LABELS: Record<string, string> = {
  txt2img: "文生图",
  img2img: "图生图",
  wan_i2v: "视频",
  hunyuan3d: "3D",
  ace_step: "音乐",
  ace_audio: "音乐",
  agent_audio: "音乐",
  agent_image: "文生图",
  agent_img2img: "图生图",
  agent_video: "视频",
  agent_3d: "3D",
  agent_workflow: "工作流",
};

const FILTERS: { k: string; l: string }[] = [
  { k: "all", l: "全部" },
  { k: "image", l: "图像" },
  { k: "video", l: "视频" },
  { k: "glb", l: "3D" },
  { k: "audio", l: "音乐" },
];

function assetType(url: string): AssetKind {
  const u = url.toLowerCase();
  if (u.includes(".glb")) return "glb";
  if (u.includes(".mp3") || u.includes(".flac") || u.includes(".wav") || u.includes(".ogg"))
    return "audio";
  if (u.includes(".mp4") || u.includes(".webm") || u.includes(".mov")) return "video";
  return "image";
}

/** 图片/视频可进灯箱;3D/音频就地交互不进。 */
function isLightboxable(t: AssetKind): boolean {
  return t === "image" || t === "video";
}

export function LibraryView() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 灯箱以「当前筛选列表内的下标」驱动,便于 ← → 切换。
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState("all");
  // 灯箱内图片的真实像素(供元信息侧栏显示),从 naturalWidth/Height 读取。
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // 无限滚动:当前已渲染的瓦片数,滚到底部哨兵时增量增长。
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const reduced = useReducedMotion();
  // R18 软开关:切换后(revision 变化)重拉作品库,让后端的服务端过滤即时生效。
  const { revision: nsfwRevision } = useNsfw();

  useEffect(() => {
    let alive = true;
    listJobs()
      .then((jobs: JobItem[]) => {
        if (!alive) return;
        const flat: Asset[] = [];
        for (const j of jobs) {
          (j.results ?? []).forEach((u, i) =>
            flat.push({
              key: `${j.id}-${i}`,
              url: imageUrl(u),
              kind: j.kind,
              prompt: j.prompt,
              seed: j.seed,
            }),
          );
        }
        setAssets(flat);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [nsfwRevision]);

  const shown = useMemo(() => {
    if (!assets) return [];
    if (filter === "all") return assets;
    return assets.filter((a) => assetType(a.url) === filter);
  }, [assets, filter]);

  // 切换筛选 / 数据变化:重置增量游标到首屏一批,并关闭可能开着的灯箱
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setActiveIndex(null);
  }, [filter, assets]);

  // 实际渲染的瓦片(增量切片);还有更多则保留哨兵
  const visible = useMemo(() => shown.slice(0, visibleCount), [shown, visibleCount]);
  const hasMore = visibleCount < shown.length;

  const loadMore = useCallback(() => {
    setVisibleCount((c) => Math.min(c + PAGE_SIZE, shown.length));
  }, [shown.length]);

  // 无限滚动:哨兵进入视口即加载下一批(IntersectionObserver,无滚动监听抖动)
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  const active = activeIndex !== null ? shown[activeIndex] ?? null : null;
  const activeType = active ? assetType(active.url) : null;

  const openLightbox = useCallback((index: number) => {
    setDims(null);
    setActiveIndex(index);
  }, []);

  const closeLightbox = useCallback(() => setActiveIndex(null), []);

  // 在当前筛选列表内切上/下一件(边界处理:夹在 [0, len-1])
  const step = useCallback(
    (delta: number) => {
      setActiveIndex((cur) => {
        if (cur === null) return cur;
        const next = cur + delta;
        if (next < 0 || next >= shown.length) return cur;
        setDims(null);
        return next;
      });
    },
    [shown.length],
  );

  // 灯箱键盘:Esc 关闭、← → 切换;打开时焦点落在关闭键
  useEffect(() => {
    if (activeIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeLightbox();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      }
    };
    window.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [activeIndex, closeLightbox, step]);

  const hasPrev = activeIndex !== null && activeIndex > 0;
  const hasNext = activeIndex !== null && activeIndex < shown.length - 1;

  return (
    <div className="view">
      <header className="view-header">
        <span className="view-eyebrow">Collection · 作品集</span>
        <h1 className="view-title">
          作品 <em>库</em>
        </h1>
        <p className="view-lede">
          每一次生成都汇入这里 —— 图像、视频、3D、音乐,按时间线沉淀成你的个人作品集。
        </p>
        <div className="view-tally">
          <span className="n">{assets?.length ?? 0}</span>
          <span className="l">件作品</span>
        </div>
      </header>

      {assets && assets.length > 0 && (
        <div className="view-toolbar">
          <div className="filter-chips" role="group" aria-label="按类型筛选">
            {FILTERS.map((f) => (
              <button
                key={f.k}
                type="button"
                className={`filter-chip${filter === f.k ? " is-on" : ""}`}
                aria-pressed={filter === f.k}
                onClick={() => setFilter(f.k)}
              >
                {f.l}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="alert">⚠ {error}</div>}

      {!assets ? (
        <div className="skel-masonry" aria-hidden="true">
          {[34, 22, 28, 26, 20, 32, 24, 30].map((h, i) => (
            <div key={i} className="skel-card" style={{ height: `${h}vh` }} />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="editorial-empty">
          <span className="ee-orb" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </span>
          <h2>还没有作品</h2>
          <p>
            去图像 / 视频 / 3D / 音乐模块创作,生成的每一件作品都会自动汇集到这里。
          </p>
        </div>
      ) : (
        <motion.div
          className="masonry"
          initial="initial"
          animate="enter"
          variants={{ enter: { transition: { staggerChildren: reduced ? 0 : 0.035 } } }}
        >
          {visible.map((a, i) => {
            const type = assetType(a.url);
            const lightboxable = isLightboxable(type);
            return (
              <motion.figure
                className="tile"
                key={a.key}
                variants={{
                  initial: { opacity: 0, y: reduced ? 0 : 14 },
                  enter: { opacity: 1, y: 0, transition: springSoft },
                }}
                onClick={lightboxable ? () => openLightbox(i) : undefined}
                style={lightboxable ? undefined : { cursor: "default" }}
              >
                <span className="tile-kind">{KIND_LABELS[a.kind] ?? a.kind}</span>
                {type === "glb" ? (
                  <a className="tile-pad" href={a.url} download onClick={(e) => e.stopPropagation()}>
                    <span className="badge">3D · GLB</span>
                    <span className="hint">可旋转网格模型</span>
                    <span className="tile-dl">下载模型</span>
                  </a>
                ) : type === "audio" ? (
                  <div className="tile-pad" onClick={(e) => e.stopPropagation()}>
                    <span className="badge audio">♪ 音乐</span>
                    <audio controls preload="none" src={a.url} />
                  </div>
                ) : type === "video" ? (
                  <>
                    <span className="tile-play" aria-hidden="true">▶</span>
                    <LazyVideo src={a.url} label={a.prompt || "视频作品"} />
                    <figcaption className="tile-cap">
                      <p className="p">{a.prompt || "未命名作品"}</p>
                      <p className="s">seed {a.seed}</p>
                    </figcaption>
                  </>
                ) : (
                  <>
                    <LazyImage src={a.url} alt={a.prompt} />
                    <figcaption className="tile-cap">
                      <p className="p">{a.prompt || "未命名作品"}</p>
                      <p className="s">seed {a.seed}</p>
                    </figcaption>
                  </>
                )}
              </motion.figure>
            );
          })}

          {/* 无限滚动:哨兵 + 加载中指示(进入视口即续渲一批) */}
          {hasMore && (
            <>
              <div ref={sentinelRef} className="lib-sentinel" aria-hidden="true" />
              <div className="lib-more" role="status" aria-live="polite">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </>
          )}
        </motion.div>
      )}

      <AnimatePresence>
        {active && (
          <motion.div
            className="lightbox"
            onClick={closeLightbox}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            role="dialog"
            aria-modal="true"
            aria-label={active.prompt || "作品预览"}
          >
            {/* 两侧切换按钮:在筛选列表内上/下一件(边界禁用) */}
            <button
              type="button"
              className="lightbox-nav prev"
              onClick={(e) => {
                e.stopPropagation();
                step(-1);
              }}
              disabled={!hasPrev}
              aria-label="上一件"
            >
              ‹
            </button>
            <button
              type="button"
              className="lightbox-nav next"
              onClick={(e) => {
                e.stopPropagation();
                step(1);
              }}
              disabled={!hasNext}
              aria-label="下一件"
            >
              ›
            </button>

            <motion.div
              className="lightbox-inner"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: reduced ? 1 : 0.94, y: reduced ? 0 : 12 }}
              animate={{ opacity: 1, scale: 1, y: 0, transition: springSoft }}
              exit={{ opacity: 0, scale: reduced ? 1 : 0.96, transition: { duration: 0.15 } }}
            >
              <div className="lightbox-stage">
                {activeType === "video" ? (
                  <video
                    key={active.key}
                    className="lightbox-video"
                    src={active.url}
                    controls
                    autoPlay
                    loop
                    playsInline
                    aria-label={active.prompt || "视频作品"}
                  />
                ) : (
                  <Magnifier
                    key={active.key}
                    src={active.url}
                    alt={active.prompt || "作品"}
                    wrapClassName="lightbox-magnifier"
                    zoom={2.6}
                    lensSize={200}
                    onLoadDims={(w, h) => setDims({ w, h })}
                  />
                )}
              </div>

              <aside className="lightbox-meta" aria-label="作品信息">
                <p className="lb-prompt">{active.prompt || "未命名作品"}</p>
                <dl className="lb-specs">
                  <div>
                    <dt>题材</dt>
                    <dd>{KIND_LABELS[active.kind] ?? active.kind}</dd>
                  </div>
                  <div>
                    <dt>seed</dt>
                    <dd className="num">{active.seed}</dd>
                  </div>
                  {activeType === "image" && dims && (
                    <div>
                      <dt>尺寸</dt>
                      <dd className="num">
                        {dims.w}×{dims.h}
                      </dd>
                    </div>
                  )}
                </dl>
                <div className="lb-actions">
                  <a className="btn-ghost" href={active.url} download>
                    {activeType === "video" ? "下载视频" : "下载原图"}
                  </a>
                </div>
              </aside>

              <button
                ref={closeBtnRef}
                type="button"
                className="lightbox-close"
                onClick={closeLightbox}
                aria-label="关闭"
              >
                ✕
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { Magnifier } from "@/components/ui/Magnifier";
import { useNsfw } from "@/components/nav/NsfwContext";
import { deleteJob, imageUrl, invalidateJobs, jobVersions, listJobs, rerunJob, type RerunOptions } from "@/lib/api";
import { springSoft } from "@/lib/motion";
import { trackJob } from "@/lib/trackJob";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import type { JobItem } from "@/lib/types";

import { LazyImage } from "./LazyImage";
import { LazyVideo } from "./LazyVideo";

import "./library-extra.css";

/** 每批增量渲染的瓦片数(无限滚动)。 */
const PAGE_SIZE = 24;

interface Asset {
  key: string;
  jobId: string;
  url: string;
  kind: string;
  prompt: string;
  seed: number;
  /** 版本树:同链归组的根 job id。 */
  rootId: string;
  /** 有参数快照才能精确重生(旧数据无)。 */
  hasParams: boolean;
  /** 同链版本数(>1 才显示版本徽章/历史)。 */
  versionCount: number;
}

/** 作业列表 → 平铺产物;同链(root)版本计数供版本徽章。 */
function flattenJobs(jobs: JobItem[]): Asset[] {
  const rootCount = new Map<string, number>();
  for (const j of jobs) {
    const root = j.root_id || j.id;
    rootCount.set(root, (rootCount.get(root) ?? 0) + 1);
  }
  const flat: Asset[] = [];
  for (const j of jobs) {
    const root = j.root_id || j.id;
    (j.results ?? []).forEach((u, i) =>
      flat.push({
        key: `${j.id}-${i}`,
        jobId: j.id,
        url: imageUrl(u),
        kind: j.kind,
        prompt: j.prompt,
        seed: j.seed,
        rootId: root,
        hasParams: !!j.has_params,
        versionCount: rootCount.get(root) ?? 1,
      }),
    );
  }
  return flat;
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
  // 精修 / 放大 / 漫剧 / 对口型等衍生产物,补齐友好中文名(否则露原始大写 kind)
  manju_shot: "漫剧镜头",
  manju_shot_pulid: "漫剧镜头",
  supir: "高清放大",
  sdupscale: "高清放大",
  hires: "高清修复",
  facedetailer: "面部精修",
  inpaint: "局部重绘",
  controlnet: "构图控制",
  lipsync: "对口型",
  dubsync: "对口型",
};

/** 未登记的 kind 兜底成体面标签(避免露原始大写 kind 名),按产物类型给通用词。 */
function kindLabel(kind: string, url: string): string {
  const known = KIND_LABELS[kind];
  if (known) return known;
  const t = assetType(url);
  return t === "video" ? "视频" : t === "glb" ? "3D" : t === "audio" ? "音乐" : "图像";
}

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

/** 可「重生成(换seed)」的 kind:有采样随机性;确定性 kind(upscale/removebg/raw)重抽只会出一样的图。 */
const RERUN_KINDS = new Set([
  "txt2img", "img2img", "controlnet", "facedetailer", "inpaint",
  "wan_t2v", "wan_i2v", "hunyuan3d", "ace_audio",
  "manju_shot_txt2img", "manju_shot_ipadapter", "manju_lipsync",
]);
/** 可「微调(锁seed改词)」的 kind:请求模型有 positive 字段,overrides 才不会被后端丢弃。 */
const TWEAK_KINDS = new Set([
  "txt2img", "img2img", "controlnet", "facedetailer", "inpaint",
  "wan_t2v", "wan_i2v", "manju_shot_txt2img", "manju_shot_ipadapter",
]);

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
  // 版本树:挂起跳转(列表刷新后按 jobId 重新定位灯箱)+ 当前灯箱 jobId(异步回调防串台)
  const pendingJumpRef = useRef<string | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const reduced = useReducedMotion();
  // R18 软开关:切换后(revision 变化)重拉作品库,让后端的服务端过滤即时生效。
  const { revision: nsfwRevision } = useNsfw();

  useEffect(() => {
    let alive = true;
    listJobs()
      .then((jobs: JobItem[]) => {
        if (alive) setAssets(flattenJobs(jobs));
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

  // 切换筛选 / 数据变化:重置增量游标;默认关灯箱(防新条目前插导致索引漂移)。
  // 有挂起跳转(点了版本条里尚未入列的新版本 → 触发刷新)则按 jobId 重新定位。
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    const target = pendingJumpRef.current;
    if (target) {
      pendingJumpRef.current = null;
      const idx = shown.findIndex((a) => a.jobId === target);
      setDims(null);
      setActiveIndex(idx >= 0 ? idx : null);
      return;
    }
    setActiveIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shown 由 assets+filter 派生,同拍
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

  // ---------- 版本树:重生成 / 微调(锁seed)/ 版本历史 ----------
  const [versions, setVersions] = useState<JobItem[] | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [rerunMsg, setRerunMsg] = useState<string | null>(null);
  const [tweakOpen, setTweakOpen] = useState(false);
  const [tweakText, setTweakText] = useState("");
  // rerun 产生过新版本 → 关灯箱时重拉列表(避免开着时索引漂移)
  const dirtyRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      invalidateJobs();
      const jobs = await listJobs();
      setAssets(flattenJobs(jobs));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const closeLightbox = useCallback(() => {
    setActiveIndex(null);
    if (dirtyRef.current) {
      dirtyRef.current = false;
      void reload();
    }
  }, [reload]);

  // 切换灯箱对象:收起版本条 / 微调编辑器 / 状态提示
  useEffect(() => {
    setVersions(null);
    setVersionsOpen(false);
    setTweakOpen(false);
    setRerunMsg(null);
  }, [activeIndex]);

  // 异步回调防串台:随时可读的「当前灯箱 jobId」(rerun/版本请求完成时比对)
  useEffect(() => {
    activeJobIdRef.current = active?.jobId ?? null;
  }, [active]);

  // 删除一件作品:确认 → 删后端记录 → 从本地列表剔除该 job 的所有产物 → 关灯箱
  const [deleting, setDeleting] = useState<string | null>(null);
  const handleDelete = useCallback(async (jobId: string) => {
    if (deleting) return;
    if (!window.confirm("确认删除这件作品?此操作不可撤销。")) return;
    setDeleting(jobId);
    try {
      await deleteJob(jobId);
      setAssets((cur) => (cur ? cur.filter((a) => a.jobId !== jobId) : cur));
      setActiveIndex(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(null);
    }
  }, [deleting]);

  /** 展开/收起版本历史条(首次展开时拉取同根版本链;晚到的旧响应丢弃防串台)。 */
  const toggleVersions = useCallback(async () => {
    if (!active) return;
    if (versionsOpen) {
      setVersionsOpen(false);
      return;
    }
    const forJob = active.jobId;
    setVersionsOpen(true);
    try {
      const list = await jobVersions(forJob);
      if (activeJobIdRef.current === forJob) setVersions(list);
    } catch (e) {
      if (activeJobIdRef.current === forJob) {
        setVersionsOpen(false);
        // 错误在灯箱内展示(页面顶部横幅会被灯箱遮罩盖住)
        setRerunMsg(`版本历史加载失败:${(e as Error).message}`);
      }
    }
  }, [active, versionsOpen]);

  /** 点版本缩略图 → 灯箱跳到该版本;不在当前列表(刚生成/超窗)则刷新后按 jobId 定位。 */
  const jumpToJob = useCallback(
    (jobId: string) => {
      const idx = shown.findIndex((a) => a.jobId === jobId);
      if (idx >= 0) {
        setDims(null);
        setActiveIndex(idx);
        return;
      }
      pendingJumpRef.current = jobId;
      dirtyRef.current = false;
      void reload();
    },
    [shown, reload],
  );

  /** 重生成(random)/微调(keep=锁 seed):提交 → 等完成 → 就地刷新版本条。
   *  完成回调一律与「当前灯箱对象」比对,等待期间切图/关灯箱都不会把状态写错地方。 */
  const handleRerun = useCallback(
    async (a: Asset, opts: RerunOptions) => {
      if (rerunBusy) return;
      setRerunBusy(true);
      setRerunMsg(opts.seed_mode === "keep" ? "微调中(锁 seed)…" : "重新生成中…");
      try {
        const res = await rerunJob(a.jobId, opts);
        await trackJob(res);
        invalidateJobs(); // 缓存先失效:无论灯箱开关,下次拉取都是新链
        dirtyRef.current = true;
        if (activeJobIdRef.current === a.jobId) {
          setRerunMsg("完成 ✓ 新版本已入链(关闭后列表刷新)");
          setVersionsOpen(true);
          const list = await jobVersions(a.jobId);
          if (activeJobIdRef.current === a.jobId) setVersions(list);
        } else if (activeJobIdRef.current === null) {
          // 灯箱已关:立即刷新列表,新版本/徽章直接可见
          dirtyRef.current = false;
          void reload();
        }
        // 切到了别的作品:不动当前 UI,关灯箱时经 dirtyRef 刷新
      } catch (e) {
        const msg = (e as Error).message;
        if (activeJobIdRef.current === a.jobId) setRerunMsg(`失败:${msg}`);
        else setError(msg);
      } finally {
        setRerunBusy(false);
      }
    },
    [rerunBusy, reload],
  );

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
        <span className="view-eyebrow">Library</span>
        <h1 className="view-title">作品库</h1>
        <p className="view-lede">图像、视频、3D、音乐,按时间线沉淀。</p>
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
                <span className="tile-kind">{kindLabel(a.kind, a.url)}</span>
                {a.versionCount > 1 && (
                  <span className="tile-ver" title={`同链 ${a.versionCount} 个版本`}>
                    {a.versionCount} 版
                  </span>
                )}
                <button
                  type="button"
                  className="tile-del"
                  aria-label="删除作品"
                  title="删除"
                  disabled={deleting === a.jobId}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(a.jobId);
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                </button>
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
                    <dd>{kindLabel(active.kind, active.url)}</dd>
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
                  {active.versionCount > 1 && (
                    <div>
                      <dt>版本</dt>
                      <dd className="num">{active.versionCount}</dd>
                    </div>
                  )}
                </dl>
                <div className="lb-actions">
                  {active.hasParams && RERUN_KINDS.has(active.kind) && (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={rerunBusy}
                      title="同参数换 seed 重抽"
                      onClick={() => handleRerun(active, { seed_mode: "random" })}
                    >
                      重生成
                    </button>
                  )}
                  {active.hasParams && TWEAK_KINDS.has(active.kind) && (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={rerunBusy}
                      title="锁 seed 只改提示词:构图不变,改哪动哪"
                      onClick={() => {
                        setTweakOpen((o) => !o);
                        setTweakText(active.prompt);
                      }}
                    >
                      微调
                    </button>
                  )}
                  <button type="button" className="btn-ghost" onClick={toggleVersions}>
                    {versionsOpen ? "收起版本" : `版本历史${active.versionCount > 1 ? ` (${active.versionCount})` : ""}`}
                  </button>
                  <a className="btn-ghost" href={active.url} download>
                    {activeType === "video" ? "下载视频" : "下载原图"}
                  </a>
                  <button
                    type="button"
                    className="btn-ghost btn-danger"
                    disabled={deleting === active.jobId}
                    onClick={() => handleDelete(active.jobId)}
                  >
                    {deleting === active.jobId ? "删除中…" : "删除作品"}
                  </button>
                </div>

                {tweakOpen && active.hasParams && TWEAK_KINDS.has(active.kind) && (
                  <div className="lb-tweak">
                    <textarea
                      rows={3}
                      value={tweakText}
                      onChange={(e) => setTweakText(e.target.value)}
                      placeholder="改动提示词(锁 seed,构图保持)"
                    />
                    <div className="lb-tweak-row">
                      <span className="lb-tweak-seed">seed {active.seed} 已锁</span>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={rerunBusy || !tweakText.trim()}
                        onClick={() => {
                          setTweakOpen(false);
                          const text = tweakText.trim();
                          handleRerun(active, {
                            seed_mode: "keep",
                            ...(text && text !== active.prompt
                              ? { overrides: { positive: text } }
                              : {}),
                          });
                        }}
                      >
                        生成微调版
                      </button>
                    </div>
                  </div>
                )}

                {rerunMsg && (
                  <p className="lb-rerun-msg" role="status">
                    {rerunBusy && <span className="lb-spin" aria-hidden="true" />}
                    {rerunMsg}
                  </p>
                )}

                {versionsOpen && (
                  <div className="lb-versions" aria-label="版本历史">
                    {versions === null ? (
                      <p className="lb-vs-loading">加载版本…</p>
                    ) : (
                      versions.map((v, idx) => {
                        const thumb = v.results?.[0];
                        const t = thumb ? assetType(thumb) : "image";
                        const isCurrent = v.id === active.jobId;
                        return (
                          <button
                            key={v.id}
                            type="button"
                            className={`lb-ver${isCurrent ? " is-current" : ""}`}
                            title={`v${idx + 1} · seed ${v.seed}${isCurrent ? "(当前)" : ""}`}
                            onClick={() => jumpToJob(v.id)}
                          >
                            {thumb && t === "image" ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={imageUrl(thumb)} alt={`v${idx + 1}`} loading="lazy" />
                            ) : (
                              <span className="lb-ver-ph">{t === "video" ? "▶" : "…"}</span>
                            )}
                            <span className="lb-ver-tag">v{idx + 1}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
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

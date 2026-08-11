"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deleteJob, imageUrl, invalidateJobs, listJobs } from "@/lib/api";
import { ENGINE_DRAFT_KEY } from "@/lib/engine";
import type { JobItem } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Popover } from "@/components/ui/Popover";
import { Input } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { StyleBar, type StyleCard } from "@/components/library/StyleBar";

/** localStorage 键:风格卡列表(WS4「存为风格」)。 */
const STYLE_CARDS_KEY = "toiv_style_cards";
/** localStorage 键:优化提示词管线读取的风格描述(与 ui/OptimizeButton 一致)。 */
const STYLE_HINT_KEY = "toiv_optimize_style_hint";

function loadStyleCards(): StyleCard[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STYLE_CARDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is StyleCard =>
        !!c && typeof c.id === "string" && typeof c.name === "string",
    );
  } catch {
    return [];
  }
}

function persistStyleCards(cards: StyleCard[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STYLE_CARDS_KEY, JSON.stringify(cards));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

type FilterKey = "all" | "image" | "video" | "audio" | "3d";

interface FilterDef {
  key: FilterKey;
  label: string;
  kinds: string[];
}

const FILTERS: FilterDef[] = [
  { key: "all", label: "全部", kinds: [] },
  {
    key: "image",
    label: "图像",
    kinds: [
      "txt2img", "img2img", "controlnet", "upscale", "facedetailer",
      "inpaint", "removebg", "raw",
      // 短剧 studio 图像类产物
      "drama_grid_storyboard", "drama_scene_layout",
    ],
  },
  {
    key: "video",
    label: "视频",
    kinds: [
      "video", "txt2video", "img2video", "lipsync", "kenburns",
      "wan_t2v", "wan_i2v", "hunyuan_i2v", "h3_t2v", "h3_i2v",
      "ltx_t2v", "ltx_i2v", "ltx_lipsync", "ltx2_t2v", "ltx2_i2v",
      "frame_interpolate", "dub_lipsync_long", "manju_lipsync", "anime_lipsync",
      // LongCat 长视频(t2v/i2v/续写)
      "longcat_t2v", "longcat_i2v", "longcat_continue",
      // LongCat-Avatar 数字人说话视频
      "avatar_talk",
      // 短剧 studio 视频类产物
      "drama_shot_video", "drama_shot_video_i2v", "drama_shot_video_v2", "drama_shot_lipsync",
    ],
  },
  {
    key: "audio",
    label: "音频",
    kinds: ["audio", "ace_audio", "audio_sep", "transcribe", "voice_track"],
  },
  { key: "3d", label: "3D", kinds: ["3d", "model3d", "hunyuan3d"] },
];

/** 动态前缀规则(后端按 preset/视角拼 kind):cad_* → 3D;drama_char_reference_* → 图像。 */
const KIND_PREFIX_RULES: [string, FilterKey][] = [
  ["cad_", "3d"],
  ["drama_char_reference_", "image"],
];

/** 分页大小:每页 60 条,点击「加载更多」追加,避免全量渲染大图列表。 */
const PAGE_SIZE = 60;

/**
 * kind → 筛选桶。未识别的 kind 返回 null:只在「全部」出现,
 * 不硬塞进「图像」(修复 transcribe/voice_track 等被错算成图像的问题)。
 */
function kindToFilter(kind: string): FilterKey | null {
  for (const f of FILTERS) {
    if (f.kinds.includes(kind)) return f.key;
  }
  for (const [prefix, key] of KIND_PREFIX_RULES) {
    if (kind.startsWith(prefix)) return key;
  }
  return null;
}

/** Badge 短名:映射后的中文短名;未知 kind 兜底「其他」,不回显超长原始 kind 名。 */
function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    txt2img: "文生图",
    img2img: "图生图",
    controlnet: "ControlNet",
    upscale: "放大",
    facedetailer: "脸部修复",
    inpaint: "局部重绘",
    removebg: "抠图",
    raw: "原图",
    video: "视频",
    txt2video: "文生视频",
    img2video: "图生视频",
    lipsync: "对口型",
    kenburns: "运镜",
    wan_t2v: "文生视频",
    wan_i2v: "图生视频",
    hunyuan_i2v: "图生视频",
    h3_t2v: "文生视频",
    h3_i2v: "图生视频",
    ltx_t2v: "文生视频",
    ltx_i2v: "图生视频",
    ltx_lipsync: "对口型",
    ltx2_t2v: "文生视频",
    ltx2_i2v: "图生视频",
    frame_interpolate: "补帧",
    dub_lipsync_long: "长对口型",
    manju_lipsync: "对口型",
    anime_lipsync: "动漫对口型",
    longcat_t2v: "长视频",
    longcat_i2v: "长视频",
    longcat_continue: "长视频续写",
    avatar_talk: "数字人",
    audio: "音频",
    ace_audio: "音乐",
    audio_sep: "人声分离",
    transcribe: "听写",
    voice_track: "配音轨",
    "3d": "3D",
    model3d: "3D",
    hunyuan3d: "图生3D",
    drama_grid_storyboard: "分镜",
    drama_scene_layout: "场景布局",
    drama_shot_video: "镜头视频",
    drama_shot_video_i2v: "镜头视频",
    drama_shot_video_v2: "镜头视频",
    drama_shot_lipsync: "镜头对口型",
  };
  if (map[kind]) return map[kind];
  if (kind.startsWith("cad_")) return "CAD";
  if (kind.startsWith("drama_char_reference_")) return "角色参考";
  return "其他";
}

function isVideoKind(kind: string): boolean {
  return kindToFilter(kind) === "video";
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000;
    const hr = 60 * min;
    const day = 24 * hr;
    if (diff < min) return "刚刚";
    if (diff < hr) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hr)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    return d.toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

function ThumbPlaceholder({ job }: { job: JobItem }) {
  const filterKey = kindToFilter(job.kind);
  return (
    <div
      className={`lib-thumb-placeholder ${job.status === "error" ? "has-error" : ""}`}
    >
      {/* 图标居中,状态文本分层为左上角小胶囊,互不重叠 */}
      <Icon
        name={
          job.status === "running"
            ? "loading"
            : job.status === "error"
              ? "error"
              : filterKey === "audio"
                ? "audio"
                : filterKey === "video"
                  ? "film"
                  : filterKey === "3d"
                    ? "box"
                    : "image"
        }
        size={28}
        strokeWidth={1.4}
      />
      {job.status === "running" && (
        <span className="lib-thumb-status is-running">生成中…</span>
      )}
      {job.status === "error" && (
        <span className="lib-thumb-status is-error">生成失败</span>
      )}
    </div>
  );
}

function ImageThumb({ job }: { job: JobItem }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ThumbPlaceholder job={job} />;
  return (
    <img
      src={imageUrl(job.results[0])}
      alt={job.prompt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

interface LibraryViewProps {
  /**
   * 视图跳转(复用 page.tsx 的 fusion 导航:写引擎草稿后跳生成工作台)。
   * 未提供时灯箱「复用提示词」退化为整页跳转。
   */
  onNavigate?: (target: string) => void;
  /**
   * NSFW 专区(/nsfw)作品库内嵌时置 true:只展示 R18 作品(Job.nsfw),
   * 不混入 SFW 作品;配合 jobs 接口的 nsfw 字段与 X-NSFW 上下文使用。
   */
  onlyNsfw?: boolean;
}

export function LibraryView({ onNavigate, onlyNsfw = false }: LibraryViewProps = {}) {
  const toast = useToast();
  const [jobs, setJobs] = useState<JobItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  // 分页:首屏只渲染 PAGE_SIZE 条,「加载更多」追加;切筛选时重置
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 删除确认对话框(替代 window.confirm / window.alert)
  const [confirmDelete, setConfirmDelete] = useState<JobItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 沉浸查看器(批 3):当前筛选列表内的索引;失败/音频作品也允许打开(显示对应占位)
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  // 风格卡(WS4):StyleBar 数据源 + 「存为风格」Popover 状态
  const [styleCards, setStyleCards] = useState<StyleCard[]>([]);
  const [styleTarget, setStyleTarget] = useState<JobItem | null>(null);
  const [styleName, setStyleName] = useState("");
  const styleAnchorRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listJobs()
      .then(setJobs)
      .catch((err) => setError(err instanceof Error ? err.message : "加载作品失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 挂载后读取本地风格卡(SSR 安全:loadStyleCards 内部判 window)
  useEffect(() => {
    setStyleCards(loadStyleCards());
  }, []);

  const filtered = useMemo(() => {
    if (!jobs) return [];
    const base = onlyNsfw ? jobs.filter((j) => j.nsfw) : jobs;
    if (filter === "all") return base;
    return base.filter((j) => kindToFilter(j.kind) === filter);
  }, [jobs, filter, onlyNsfw]);

  // 灯箱索引越界钳制:删除当前作品后 filtered 收缩,滑到下一件;列表清空则关闭
  useEffect(() => {
    if (lightboxIdx === null) return;
    if (filtered.length === 0) setLightboxIdx(null);
    else if (lightboxIdx >= filtered.length) setLightboxIdx(filtered.length - 1);
  }, [filtered.length, lightboxIdx]);

  const visibleJobs = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const hasMore = filtered.length > visibleCount;

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, image: 0, video: 0, audio: 0, "3d": 0 };
    if (jobs) {
      const base = onlyNsfw ? jobs.filter((j) => j.nsfw) : jobs;
      c.all = base.length;
      for (const j of base) {
        // 未识别 kind 不计入任何分类桶,只算进「全部」
        const key = kindToFilter(j.kind);
        if (key) c[key]++;
      }
    }
    return c;
  }, [jobs, onlyNsfw]);

  // 段控 Tabs 项:计数始终渲染预留宽度(visibility 控制),避免计数出现后段宽跳动(CLS 加固)
  const filterTabs = useMemo(
    () =>
      FILTERS.map((f) => ({
        key: f.key,
        label: (
          <>
            <span>{f.label}</span>
            <span
              style={{
                visibility: counts[f.key] > 0 ? "visible" : "hidden",
                fontSize: "var(--text-label)",
                fontVariantNumeric: "tabular-nums",
                display: "inline-block",
                minWidth: "1.1em",
                textAlign: "right",
              }}
            >
              {counts[f.key]}
            </span>
          </>
        ),
      })),
    [counts],
  );

  // 点击删除:仅打开确认对话框(不再使用 window.confirm)
  const handleDelete = (job: JobItem) => {
    setDeleteError(null);
    setConfirmDelete(job);
  };

  // 确认删除:执行实际删除,失败时把错误信息内联显示在对话框中
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    const job = confirmDelete;
    setDeletingId(job.id);
    try {
      await deleteJob(job.id);
      invalidateJobs();
      setJobs((prev) => (prev ?? []).filter((j) => j.id !== job.id));
      setConfirmDelete(null);
      setDeleteError(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  // 打开沉浸查看器:定位到当前筛选列表中的索引(失败/音频作品同样可打开,灯箱内显示对应占位)
  const openLightbox = (job: JobItem) => {
    const idx = filtered.findIndex((j) => j.id === job.id);
    if (idx >= 0) setLightboxIdx(idx);
  };

  // ── WS4 快捷操作 + 风格卡 ──

  // 复用提示词:写入剪贴板并 toast(项目已有 Toast 机制,不用 alert)
  const reusePrompt = async (job: JobItem) => {
    const text = job.prompt?.trim();
    if (!text) {
      toast.info("该作品没有提示词");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("提示词已复制到剪贴板");
    } catch {
      toast.error("复制失败,请检查浏览器剪贴板权限");
    }
  };

  // 灯箱「复用提示词」:写引擎草稿(toiv_engine_draft,GenerateView 挂载时消费)并跳生成工作台
  const reusePromptAsDraft = (job: JobItem) => {
    const text = job.prompt?.trim();
    if (!text) {
      toast.info("该作品没有提示词");
      return;
    }
    const target = isVideoKind(job.kind) ? "video" : "image";
    try {
      window.localStorage.setItem(
        ENGINE_DRAFT_KEY,
        JSON.stringify({ prompt: text, target }),
      );
    } catch {
      /* localStorage 不可用时仍跳转,草稿缺失不阻塞 */
    }
    setLightboxIdx(null);
    if (onNavigate) onNavigate(target);
    else window.location.assign(`/?view=${target}`);
  };

  // 打开「存为风格」Popover:记录锚点按钮与目标作品
  const openStylePopover = (job: JobItem, anchor: HTMLButtonElement) => {
    styleAnchorRef.current = anchor;
    setStyleName("");
    setStyleTarget(job);
  };

  // 保存风格卡:同名覆盖,新卡置顶;prompt 截取 500 字作 hint
  const saveStyleCard = () => {
    if (!styleTarget) return;
    const name = styleName.trim();
    if (!name) {
      toast.error("请输入风格名称");
      return;
    }
    const card: StyleCard = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      thumb: styleTarget.results?.length
        ? imageUrl(styleTarget.results[0])
        : "",
      hint: (styleTarget.prompt ?? "").slice(0, 500),
    };
    setStyleCards((prev) => {
      const next = [card, ...prev.filter((c) => c.name !== name)];
      persistStyleCards(next);
      return next;
    });
    toast.success(`风格「${name}」已保存`);
    setStyleTarget(null);
  };

  // 注入风格:写入优化提示词管线读取的 localStorage 键
  const applyStyleCard = (card: StyleCard) => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STYLE_HINT_KEY, card.hint);
      } catch {
        /* localStorage 不可用时静默忽略 */
      }
    }
    toast.success("风格已注入,到工作台点优化生效");
  };

  const deleteStyleCard = (card: StyleCard) => {
    setStyleCards((prev) => {
      const next = prev.filter((c) => c.id !== card.id);
      persistStyleCards(next);
      return next;
    });
    toast.info(`风格「${card.name}」已删除`);
  };

  const isEmpty = !loading && !error && filtered.length === 0;
  const skeletonCount = 8;

  return (
    <div className="single-view library-view">
      <header className="page-header lib-header">
        <div className="page-header-text">
          <h1 className="page-header-title">作品库</h1>
          <p className="page-header-desc">
            悬停卡片查看提示词,点击沉浸预览 · 支持图像 / 视频 / 音频 / 3D
          </p>
        </div>
        <div className="page-header-actions">
          <span className="lib-count-pill">
            {loading
              ? "加载中…"
              : error
                ? "加载失败"
                : `${filtered.length} 件作品`}
          </span>
        </div>
      </header>

      {/* 类型筛选独立工具行:从页头拆出,给段控单独的横向节奏 */}
      <div className="lib-toolbar">
        <div className="lib-filters">
          <Tabs
            items={filterTabs}
            current={filter}
            onChange={(key) => {
              setFilter(key as FilterKey);
              setVisibleCount(PAGE_SIZE);
            }}
            ariaLabel="作品类型筛选"
          />
        </div>
      </div>

      {/* 风格库横条(WS4):空态 StyleBar 内部返回 null,不渲染整条 */}
      <StyleBar
        cards={styleCards}
        onApply={applyStyleCard}
        onDelete={deleteStyleCard}
      />

      <div className="lib-body">
        {error && !loading && (
          <div className="lib-error">
            <Icon name="error" size={36} strokeWidth={1.4} />
            <div className="lib-error-msg">{error}</div>
            <Button size="sm" onClick={load} icon={<Icon name="refresh" size={14} />}>
              重试
            </Button>
          </div>
        )}

        {!error && loading && (
          <div className="lib-grid">
            {Array.from({ length: skeletonCount }).map((_, i) => (
              <div key={i} className="lib-card lib-skeleton" aria-hidden="true">
                <div className="lib-thumb-skel" />
                <div className="lib-foot-skel">
                  <div className="skel-line skel-w-1" />
                  <div className="skel-line skel-w-2" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!error && !loading && isEmpty && (
          <div className="lib-empty">
            <div className="lib-empty-icon" aria-hidden="true">
              <Icon name="image" size={30} strokeWidth={1.4} />
            </div>
            <h2 className="lib-empty-display">这里还空空如也</h2>
            <p className="lib-empty-desc">去图片 / 视频 / 音频工作台生成第一件作品,完成后会自动收录到这里。</p>
          </div>
        )}

        {!error && !loading && !isEmpty && (
          <>
            <div className="lib-grid">
              {visibleJobs.map((job) => {
              // 后端作业状态枚举为 queued/running/done/error;done 表示成功且有产物
              const hasResult = job.status === "done" && job.results?.length > 0;
              const isVideo = isVideoKind(job.kind);
              // 失败占位卡:thumb 加修饰类,CSS 收敛为固定矮条(样式见 app/styles/library.css)
              const isErrorPlaceholder = !hasResult && job.status === "error";
              return (
                <article
                  key={job.id}
                  className={`lib-card ${deletingId === job.id ? "is-deleting" : ""}`}
                >
                  <div className={`lib-thumb ${isErrorPlaceholder ? "lib-thumb--error" : ""}`}>
                    {/* 预览触发区用真实 <button>,与删除按钮平级,避免嵌套交互控件(WCAG nested-interactive) */}
                    <button
                      type="button"
                      className="lib-thumb-hit"
                      aria-label={`预览作品: ${job.prompt || "无提示词"}`}
                      onClick={() => openLightbox(job)}
                    >
                    {hasResult ? (
                      isVideo ? (
                        <video
                          src={imageUrl(job.results[0])}
                          muted
                          loop
                          playsInline
                          preload="metadata"
                        />
                      ) : (
                        <ImageThumb job={job} />
                      )
                    ) : (
                      <ThumbPlaceholder job={job} />
                    )}

                    <div className="lib-overlay" aria-hidden="true">
                      <div className="lib-overlay-prompt">
                        {job.prompt || "（无提示词）"}
                      </div>
                    </div>
                    </button>

                    {/* 快捷操作浮层(WS4):底部渐显玻璃条,三键 = 查看大图 / 存为风格 / 复用提示词 */}
                    <div
                      className="lib-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="lib-action-btn"
                        title="查看大图"
                        aria-label="查看大图"
                        onClick={(e) => {
                          e.stopPropagation();
                          openLightbox(job);
                        }}
                      >
                        <Icon name="zoom-in" size={14} />
                      </button>
                      <button
                        type="button"
                        className="lib-action-btn"
                        title="存为风格"
                        aria-label="存为风格"
                        onClick={(e) => {
                          e.stopPropagation();
                          openStylePopover(job, e.currentTarget);
                        }}
                      >
                        <Icon name="palette" size={14} />
                      </button>
                      <button
                        type="button"
                        className="lib-action-btn"
                        title="复用提示词"
                        aria-label="复用提示词"
                        onClick={(e) => {
                          e.stopPropagation();
                          reusePrompt(job);
                        }}
                      >
                        <Icon name="link" size={14} />
                      </button>
                    </div>

                    <button
                      type="button"
                      className="lib-delete"
                      title="删除作品"
                      aria-label="删除作品"
                      disabled={deletingId === job.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(job);
                      }}
                    >
                      <Icon
                        name={deletingId === job.id ? "loading" : "delete"}
                        size={14}
                      />
                    </button>

                    {isVideo && hasResult && (
                      <div className="lib-video-badge" aria-hidden="true">
                        <Icon name="playing" size={11} />
                        视频
                      </div>
                    )}
                  </div>

                  <div className="lib-foot">
                    <div className="lib-foot-row">
                      <Badge
                        tone="accent"
                        dot={false}
                        className="lib-kind-badge"
                        title={kindLabel(job.kind)}
                      >
                        <span className="lib-kind-badge-text">{kindLabel(job.kind)}</span>
                      </Badge>
                      <span className="lib-time">{formatTime(job.created_at)}</span>
                    </div>
                    <div className="lib-seed" title={`seed · ${job.seed}`}>
                      seed · {job.seed}
                    </div>
                  </div>
                </article>
              );
            })}
            </div>
            {hasMore && (
              <div className="lib-load-more">
                <Button
                  variant="secondary"
                  className="lib-load-more-btn"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                >
                  加载更多(已显示 {visibleJobs.length} / {filtered.length})
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 沉浸查看器(批 3):全出血灯箱 + 玻璃工具条 + ←/→ 穿梭 + 快捷操作 */}
      {lightboxIdx !== null && filtered[lightboxIdx] && (
        <LibraryLightbox
          jobs={filtered}
          index={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onIndex={setLightboxIdx}
          onSaveStyle={openStylePopover}
          onReuse={reusePromptAsDraft}
          onDelete={handleDelete}
          deletingId={deletingId}
          dialogsOpen={!!styleTarget || !!confirmDelete}
        />
      )}

      {/* 存为风格 Popover(WS4):锚定到触发按钮,命名后写入 toiv_style_cards */}
      <Popover
        open={!!styleTarget}
        anchorRef={styleAnchorRef}
        onClose={() => setStyleTarget(null)}
        width={260}
        className="lib-style-pop"
        role="dialog"
        ariaLabel="存为风格"
        /* 灯箱(z-modal)内触发时弹层须压过灯箱背板 */
        zIndex="calc(var(--z-modal) + 1)"
      >
        <span className="lib-style-pop-title">存为风格</span>
        <div className="lib-style-pop-row">
          <Input
            value={styleName}
            placeholder="风格名称(同名覆盖)"
            maxLength={30}
            autoFocus
            onChange={(e) => setStyleName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveStyleCard();
            }}
          />
          <Button size="sm" onClick={saveStyleCard}>
            保存
          </Button>
        </div>
      </Popover>

      {/* 删除确认对话框(Modal 基座,替代原生 window.confirm) */}
      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="删除作品"
        danger
        preventClose={deletingId !== null}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={deletingId !== null}
              onClick={() => setConfirmDelete(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={deletingId !== null}
              icon={<Icon name="delete" size={14} />}
              onClick={handleConfirmDelete}
            >
              {deletingId ? "删除中…" : "确认删除"}
            </Button>
          </>
        }
      >
        <div className="lib-confirm-body">
          <div className="lib-confirm-warn">
            确定删除这件作品?此操作不可撤销,作品的所有数据将被永久移除。
          </div>
          {confirmDelete?.prompt && (
            <div className="lib-confirm-prompt">
              {confirmDelete.prompt.length > 80
                ? confirmDelete.prompt.slice(0, 80) + "…"
                : confirmDelete.prompt}
            </div>
          )}
          {deleteError && (
            <div className="lib-confirm-error">
              <Icon name="error" size={13} /> {deleteError}
            </div>
          )}
        </div>
      </Modal>

    </div>
  );
}


// ────────────────────────────────────────────────────────────────
// LibraryLightbox:作品沉浸查看器(批 3)
// 全出血媒体舞台 + 顶部/底部玻璃工具条;←/→ 键盘与按钮穿梭;
// 操作复用 LibraryView 现有逻辑:下载(anchor download,同 ImageEdit/Audio 模式)、
// 存为风格(openStylePopover 锚点 Popover)、复用提示词(引擎草稿 + 跳工作台)、
// 删除(handleDelete → 既有确认 Modal)。
// ────────────────────────────────────────────────────────────────

interface LibraryLightboxProps {
  /** 当前筛选列表(穿梭范围) */
  jobs: JobItem[];
  index: number;
  onClose: () => void;
  onIndex: (idx: number) => void;
  /** 存为风格:复用 LibraryView.openStylePopover(锚定到灯箱工具条按钮) */
  onSaveStyle: (job: JobItem, anchor: HTMLButtonElement) => void;
  /** 复用提示词:复用 LibraryView.reusePromptAsDraft(写草稿 + 跳工作台) */
  onReuse: (job: JobItem) => void;
  /** 删除:复用 LibraryView.handleDelete(打开既有确认 Modal) */
  onDelete: (job: JobItem) => void;
  deletingId: string | null;
  /** 存风格 Popover / 删除 Modal 打开时,灯箱让出 Esc/方向键(避免一按两关) */
  dialogsOpen: boolean;
}

function LibraryLightbox({
  jobs,
  index,
  onClose,
  onIndex,
  onSaveStyle,
  onReuse,
  onDelete,
  deletingId,
  dialogsOpen,
}: LibraryLightboxProps) {
  const job = jobs[index];
  const hasResult = job.status === "done" && job.results?.length > 0;
  const isVideo = isVideoKind(job.kind);
  const isAudio = kindToFilter(job.kind) === "audio";
  const mediaUrl = hasResult ? imageUrl(job.results[0]) : "";

  // 打开期间锁定 body 滚动(与 ui/Modal 同一模式;overscroll-behavior 在 CSS 侧拦截滚轮链)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // 键盘:Esc 关闭,←/→ 穿梭;存风格/删除对话框打开时让出按键
  useEffect(() => {
    if (dialogsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < jobs.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogsOpen, index, jobs.length, onClose, onIndex]);

  return (
    <div
      className="lib-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`作品查看器: ${job.prompt || "无提示词"}`}
      onClick={onClose}
    >
      {/* 顶部玻璃工具条:作品类型 + 位置计数 + 关闭(时间下沉到底部元信息行) */}
      <div className="lib-lb-top" onClick={(e) => e.stopPropagation()}>
        <div className="lib-lb-top-meta">
          <Badge tone="accent" dot={false}>
            {kindLabel(job.kind)}
          </Badge>
          <span className="lib-lb-counter">
            {index + 1} / {jobs.length}
          </span>
        </div>
        <button
          type="button"
          className="lib-lb-icon-btn"
          aria-label="关闭预览"
          title="关闭(Esc)"
          onClick={onClose}
        >
          <Icon name="close" size={18} />
        </button>
      </div>

      {/* 左右穿梭按钮(键盘 ←/→ 同效) */}
      {index > 0 && (
        <button
          type="button"
          className="lib-lb-nav lib-lb-nav-prev"
          aria-label="上一作品"
          title="上一作品(←)"
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index - 1);
          }}
        >
          <Icon name="chevron-left" size={20} />
        </button>
      )}
      {index < jobs.length - 1 && (
        <button
          type="button"
          className="lib-lb-nav lib-lb-nav-next"
          aria-label="下一作品"
          title="下一作品(→)"
          onClick={(e) => {
            e.stopPropagation();
            onIndex(index + 1);
          }}
        >
          <Icon name="chevron-right" size={20} />
        </button>
      )}

      {/* 媒体舞台:全出血 contain;失败/音频作品显示对应占位 */}
      <div className="lib-lb-stage" onClick={(e) => e.stopPropagation()}>
        {hasResult ? (
          isVideo ? (
            <video
              key={mediaUrl}
              className="lib-lb-media"
              src={mediaUrl}
              controls
              autoPlay
              loop
            />
          ) : isAudio ? (
            <div className="lib-lb-audio">
              <div className="lib-lb-audio-icon">
                <Icon name="audio" size={40} strokeWidth={1.4} />
              </div>
              <audio src={mediaUrl} controls autoPlay />
            </div>
          ) : (
            <img className="lib-lb-media" src={mediaUrl} alt={job.prompt} />
          )
        ) : (
          <div className="lib-lb-placeholder">
            <ThumbPlaceholder job={job} />
          </div>
        )}
      </div>

      {/* 底部玻璃工具条:信息区(提示词主行 + seed/时间元信息行) + 快捷操作 */}
      <div className="lib-lb-bottom" onClick={(e) => e.stopPropagation()}>
        <div className="lib-lb-info">
          <div className="lib-lb-prompt" title={job.prompt}>
            {job.prompt || "(无提示词)"}
          </div>
          <div className="lib-lb-meta">
            seed · {job.seed} · {formatTime(job.created_at)}
          </div>
        </div>
        <div className="lib-lb-actions">
          {hasResult && (
            <a
              className="lib-lb-icon-btn"
              href={mediaUrl}
              download
              aria-label="下载作品"
              title="下载"
            >
              <Icon name="download" size={16} />
            </a>
          )}
          <button
            type="button"
            className="lib-lb-icon-btn"
            aria-label="存为风格"
            title="存为风格"
            onClick={(e) => onSaveStyle(job, e.currentTarget)}
          >
            <Icon name="palette" size={16} />
          </button>
          <button
            type="button"
            className="lib-lb-icon-btn"
            aria-label="复用提示词"
            title="复用提示词(到生成工作台)"
            onClick={() => onReuse(job)}
          >
            <Icon name="link" size={16} />
          </button>
          <button
            type="button"
            className="lib-lb-icon-btn lib-lb-icon-btn--danger"
            aria-label="删除作品"
            title="删除"
            disabled={deletingId === job.id}
            onClick={() => onDelete(job)}
          >
            <Icon name={deletingId === job.id ? "loading" : "delete"} size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

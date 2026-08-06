"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deleteJob, imageUrl, invalidateJobs, listJobs } from "@/lib/api";
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

interface PreviewState {
  url: string;
  isVideo: boolean;
  prompt: string;
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

export function LibraryView() {
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
  const [preview, setPreview] = useState<PreviewState | null>(null);
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

  // Esc 关闭灯箱
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  const filtered = useMemo(() => {
    if (!jobs) return [];
    if (filter === "all") return jobs;
    return jobs.filter((j) => kindToFilter(j.kind) === filter);
  }, [jobs, filter]);

  const visibleJobs = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const hasMore = filtered.length > visibleCount;

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, image: 0, video: 0, audio: 0, "3d": 0 };
    if (jobs) {
      c.all = jobs.length;
      for (const j of jobs) {
        // 未识别 kind 不计入任何分类桶,只算进「全部」
        const key = kindToFilter(j.kind);
        if (key) c[key]++;
      }
    }
    return c;
  }, [jobs]);

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

  const openPreview = (job: JobItem) => {
    if (!job.results?.length) return;
    setPreview({
      url: imageUrl(job.results[0]),
      isVideo: isVideoKind(job.kind),
      prompt: job.prompt,
    });
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
      <header className="lib-header">
        <div className="lib-header-left">
          <h1 className="lib-title">作品库</h1>
          <span className="lib-count">
            {loading
              ? "加载中…"
              : error
                ? "加载失败"
                : `${filtered.length} 件作品`}
          </span>
        </div>
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
      </header>

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
            <span className="lib-empty-kicker">作品库</span>
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
              // 失败占位卡:thumb 加修饰类,CSS 收敛为固定矮条(:has 复合选择器在 styled-jsx 下不可靠)
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
                      onClick={() => openPreview(job)}
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
                          openPreview(job);
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

      {/* 灯箱:全屏媒体查看器(深色遮罩,Esc/点击关闭) */}
      {preview && (
        <div
          className="lib-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
        >
          <button
            type="button"
            className="lib-lightbox-close"
            aria-label="关闭预览"
            onClick={() => setPreview(null)}
          >
            <Icon name="close" size={20} />
          </button>
          <div
            className="lib-lightbox-body"
            onClick={(e) => e.stopPropagation()}
          >
            {preview.isVideo ? (
              <video src={preview.url} controls autoPlay loop />
            ) : (
              <img src={preview.url} alt={preview.prompt} />
            )}
          </div>
          {preview.prompt && (
            <div className="lib-lightbox-prompt">{preview.prompt}</div>
          )}
        </div>
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

      <style jsx>{`
        .library-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }

        .lib-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: var(--space-4);
          flex-wrap: wrap;
          padding-bottom: var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
        }
        .lib-header-left {
          display: flex;
          align-items: baseline;
          gap: var(--space-3);
          min-width: 0;
        }
        .lib-title {
          margin: 0;
          font-size: var(--text-title);
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          line-height: 1.3;
        }
        .lib-count {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
          /* 预留宽度:"加载中…" → "N 件作品" 文本切换不挤动相邻元素(CLS 加固) */
          display: inline-block;
          min-width: 5em;
        }

        /* 窄屏段控可能溢出,横向滚动 + 触摸惯性 */
        .lib-filters {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
        }
        .lib-filters::-webkit-scrollbar {
          display: none;
        }

        .lib-body {
          min-height: 200px;
        }

        .lib-empty {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--space-3);
          padding: var(--space-6) var(--space-2);
        }
        .lib-empty-kicker {
          font-size: var(--text-label);
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: var(--accent);
        }
        .lib-empty-display {
          margin: 0;
          font-size: 32px;
          font-weight: 650;
          letter-spacing: -0.02em;
          color: var(--text-primary);
        }
        .lib-empty-desc {
          margin: 0;
          font-size: var(--text-sm);
          color: var(--text-muted);
          max-width: 420px;
          line-height: 1.6;
        }

        .lib-grid {
          /* Studio Slate 版型:masonry 混排(CSS 多列,卡片自然高度) */
          display: block;
          columns: 240px;
          column-gap: var(--space-4);
        }
        .lib-grid > * {
          break-inside: avoid;
          margin-bottom: var(--space-4);
        }
        @media (max-width: 480px) {
          .lib-grid {
            columns: 160px;
            column-gap: var(--space-3);
          }
          .lib-grid > * {
            margin-bottom: var(--space-3);
          }
        }

        .lib-load-more {
          display: flex;
          justify-content: center;
          margin-top: var(--space-4);
        }
        .lib-load-more-btn {
          font-variant-numeric: tabular-nums;
        }

        .lib-card {
          position: relative;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          overflow: hidden;
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .lib-card:hover,
        .lib-card:focus-visible {
          background: var(--bg-surface-2);
          border-color: var(--border-strong);
          box-shadow: var(--shadow-sm);
          outline: none;
        }
        .lib-card.is-deleting {
          opacity: 0.4;
          pointer-events: none;
        }

        .lib-thumb {
          position: relative;
          background: var(--bg-surface-2);
          overflow: hidden;
        }
        /* 占位卡(生成中/音频等无产物)保持方形,有产物的卡片走自然比例 */
        .lib-thumb:has(.lib-thumb-placeholder) {
          aspect-ratio: 1 / 1;
        }
        /* 失败卡收敛为固定矮条,避免整页 1:1 黑墙(修饰类挂在 .lib-thumb 上,见 TSX) */
        .lib-thumb.lib-thumb--error {
          aspect-ratio: auto;
          height: 120px;
        }
        /* 占位卡的触发按钮撑满 .lib-thumb:按钮内只有绝对定位子元素,
           不撑高会导致占位图标/hover 提示词全部叠到顶部 */
        .lib-thumb:has(.lib-thumb-placeholder) .lib-thumb-hit {
          height: 100%;
        }
        /* 预览触发按钮:包裹媒体走自然流(高度由 img/video 自然比例撑开),重置 button 默认样式 */
        .lib-thumb-hit {
          position: relative;
          width: 100%;
          padding: 0;
          border: 0;
          background: none;
          cursor: pointer;
          display: block;
          text-align: left;
          color: inherit;
          font: inherit;
        }
        .lib-thumb-hit:focus-visible {
          outline: 1px solid var(--accent);
          outline-offset: -2px;
        }
        .lib-thumb img,
        .lib-thumb video {
          width: 100%;
          height: auto;
          display: block;
        }
        /* 注:WS4 起 hover 缩放收敛为卡片级 scale(1.03)(styles/library.css),
           不再做缩略图内部二次缩放 */

        /* 注:.lib-thumb-placeholder / .lib-thumb-status 的样式在 app/styles/library.css。
           ThumbPlaceholder 是独立组件,styled-jsx 的 hash 作用域类挂不到它的
           元素上,写在这里的规则会是死规则(本次修复的占位卡塌顶根因)。 */

        .lib-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: flex-end;
          padding: var(--space-3);
          background: linear-gradient(
            to top,
            color-mix(in oklab, var(--bg-canvas) 85%, transparent),
            transparent 60%
          );
          opacity: 0;
          transition: opacity var(--duration-base) var(--ease-standard);
          pointer-events: none;
        }
        .lib-card:hover .lib-overlay,
        .lib-card:focus-within .lib-overlay {
          opacity: 1;
        }
        .lib-overlay-prompt {
          font-size: var(--text-aux);
          line-height: 1.45;
          color: var(--text-primary);
          display: -webkit-box;
          -webkit-line-clamp: 4;
          -webkit-box-orient: vertical;
          overflow: hidden;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
        }

        .lib-delete {
          position: absolute;
          top: 8px;
          right: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          padding: 0;
          background: var(--overlay-light);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-secondary);
          cursor: pointer;
          opacity: 0;
          transform: translateY(-2px);
          transition: opacity var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
          z-index: 2;
        }
        .lib-card:hover .lib-delete,
        .lib-card:focus-within .lib-delete {
          opacity: 1;
          transform: translateY(0);
        }
        .lib-delete:hover {
          background: var(--err-soft);
          border-color: var(--err);
          color: var(--err);
        }
        .lib-delete:disabled {
          cursor: not-allowed;
        }

        .lib-video-badge {
          position: absolute;
          top: 8px;
          left: 8px;
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: 2px var(--space-2);
          background: var(--overlay-light);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          font-size: var(--text-label);
          color: var(--text-secondary);
          letter-spacing: 0.02em;
          z-index: 1;
        }

        .lib-foot {
          padding: 10px var(--space-3) var(--space-3);
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .lib-foot-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
          min-width: 0;
        }
        /* kind 徽标:映射短名 + 超长截断,不再把日期挤出卡片 */
        .lib-kind-badge {
          max-width: 8.5em;
          min-width: 0;
        }
        .lib-kind-badge-text {
          display: block;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .lib-time {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .lib-seed {
          font-size: var(--text-label);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.02em;
          /* 超长 seed 单行省略,不再折成两行 */
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .lib-skeleton {
          pointer-events: none;
        }
        .lib-thumb-skel {
          aspect-ratio: 1 / 1;
          background: linear-gradient(
            90deg,
            var(--bg-surface-2) 0%,
            var(--bg-surface-3) 50%,
            var(--bg-surface-2) 100%
          );
          background-size: 200% 100%;
          animation: skel-shimmer 1.6s ease-in-out infinite;
        }
        @keyframes skel-shimmer {
          0% {
            background-position: 100% 0;
          }
          100% {
            background-position: -100% 0;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .lib-thumb-skel {
            animation: none;
          }
        }
        .lib-foot-skel {
          padding: 10px var(--space-3) var(--space-3);
          display: flex;
          flex-direction: column;
          gap: 7px;
        }
        .skel-line {
          /* 高度对齐真实 .lib-foot 行高(kind 徽标 / seed 行),
             骨架 → 真实卡片替换时行高一致,卡片底部不跳动(CLS 加固) */
          height: 14px;
          border-radius: var(--radius-xs);
          background: var(--bg-surface-2);
        }
        .skel-w-1 {
          width: 50%;
        }
        .skel-w-2 {
          width: 70%;
        }

        .lib-error {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-6);
          color: var(--text-muted);
        }
        .lib-error-msg {
          font-size: var(--text-base);
          color: var(--text-secondary);
        }

        /* ── 灯箱(全屏媒体查看器,深色) ── */
        .lib-lightbox {
          position: fixed;
          inset: 0;
          z-index: var(--z-modal);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-3);
          padding: var(--space-5);
          background: var(--overlay-light);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          animation: lb-fade var(--duration-base) var(--ease-standard);
        }
        @keyframes lb-fade {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .lib-lightbox {
            animation: none;
          }
        }
        .lib-lightbox-close {
          position: absolute;
          top: var(--space-4);
          right: var(--space-4);
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          padding: 0;
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          color: var(--text-secondary);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .lib-lightbox-close:hover {
          background: var(--bg-surface-3);
          color: var(--text-primary);
        }
        .lib-lightbox-body {
          max-width: 90vw;
          max-height: 80vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lib-lightbox-body img,
        .lib-lightbox-body video {
          max-width: 90vw;
          max-height: 80vh;
          border-radius: var(--radius-panel);
          box-shadow: var(--shadow-float);
        }
        .lib-lightbox-prompt {
          max-width: 80vw;
          font-size: var(--text-sm);
          color: var(--text-secondary);
          text-align: center;
          line-height: 1.55;
          padding: 0 var(--space-4);
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        /* ── 删除确认对话框内容(容器为 Modal 基座) ── */
        .lib-confirm-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .lib-confirm-warn {
          font-size: var(--text-base);
          color: var(--text-secondary);
          line-height: 1.55;
        }
        .lib-confirm-prompt {
          font-size: var(--text-aux);
          color: var(--text-primary);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          padding: var(--space-2) var(--space-3);
          line-height: 1.5;
          word-break: break-word;
        }
        .lib-confirm-error {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: var(--space-2) var(--space-3);
          background: var(--err-soft);
          border: 1px solid var(--err);
          border-radius: var(--radius-control);
          color: var(--err);
          font-size: var(--text-aux);
        }

        @media (max-width: 768px) {
          .lib-header {
            flex-direction: column;
            align-items: stretch;
          }
        }
      `}</style>
    </div>
  );
}

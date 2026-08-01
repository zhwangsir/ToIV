"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { deleteJob, imageUrl, invalidateJobs, listJobs } from "@/lib/api";
import type { JobItem } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";

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
    kinds: ["txt2img", "img2img", "controlnet", "upscale", "facedetailer", "inpaint", "removebg", "kenburns"],
  },
  { key: "video", label: "视频", kinds: ["video", "txt2video", "img2video", "lipsync"] },
  { key: "audio", label: "音频", kinds: ["audio"] },
  { key: "3d", label: "3D", kinds: ["3d", "model3d"] },
];

/** 分页大小:每页 60 条,点击「加载更多」追加,避免全量渲染大图列表。 */
const PAGE_SIZE = 60;

function kindToFilter(kind: string): FilterKey {
  for (const f of FILTERS) {
    if (f.kinds.includes(kind)) return f.key;
  }
  return "image";
}

function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    txt2img: "文生图",
    img2img: "图生图",
    controlnet: "ControlNet",
    upscale: "放大",
    facedetailer: "脸部修复",
    inpaint: "局部重绘",
    removebg: "抠图",
    video: "图生视频",
    txt2video: "文生视频",
    img2video: "图生视频",
    lipsync: "对口型",
    audio: "音频",
    "3d": "3D",
    model3d: "3D",
    kenburns: "运镜",
  };
  return map[kind] ?? kind;
}

function isVideoKind(kind: string): boolean {
  return ["video", "txt2video", "img2video", "lipsync", "kenburns"].includes(kind);
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
  return (
    <div className="lib-thumb-placeholder">
      <Icon
        name={
          job.status === "running"
            ? "loading"
            : job.status === "error"
              ? "error"
              : "image"
        }
        size={28}
        strokeWidth={1.4}
      />
      {job.status === "running" && (
        <span className="lib-thumb-status">生成中…</span>
      )}
      {job.status === "error" && (
        <span className="lib-thumb-status">生成失败</span>
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

  // Esc 关闭灯箱
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  // Esc 关闭删除确认对话框(删除中不响应,避免误触)
  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deletingId) setConfirmDelete(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete, deletingId]);

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
      for (const j of jobs) c[kindToFilter(j.kind)]++;
    }
    return c;
  }, [jobs]);

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
        <div className="lib-filters" role="tablist" aria-label="作品类型筛选">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={`lib-filter ${filter === f.key ? "is-active" : ""}`}
              onClick={() => {
                setFilter(f.key);
                setVisibleCount(PAGE_SIZE);
              }}
            >
              <span>{f.label}</span>
              {/* 始终渲染预留宽度(visibility 控制),避免计数出现后按钮宽度跳动(CLS 加固) */}
              <span
                className="lib-filter-count"
                style={{ visibility: counts[f.key] > 0 ? "visible" : "hidden" }}
              >
                {counts[f.key]}
              </span>
            </button>
          ))}
        </div>
      </header>

      <div className="lib-body">
        {error && !loading && (
          <div className="lib-error">
            <Icon name="error" size={36} strokeWidth={1.4} />
            <div className="lib-error-msg">{error}</div>
            <button type="button" className="btn btn-sm" onClick={load}>
              <Icon name="refresh" size={14} />
              重试
            </button>
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
          <div className="empty-state lib-empty">
            <div className="empty-state-icon">
              <Icon name="library" size={56} strokeWidth={1.1} />
            </div>
            <div className="empty-state-title">还没有作品</div>
            <div className="empty-state-desc">去创作页面生成第一件作品</div>
          </div>
        )}

        {!error && !loading && !isEmpty && (
          <>
            <div className="lib-grid">
              {visibleJobs.map((job) => {
              const hasResult = job.status === "success" && job.results?.length > 0;
              const isVideo = isVideoKind(job.kind);
              return (
                <article
                  key={job.id}
                  className={`lib-card ${deletingId === job.id ? "is-deleting" : ""}`}
                >
                  <div className="lib-thumb">
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
                      <span className="lib-kind">{kindLabel(job.kind)}</span>
                      <span className="lib-time">{formatTime(job.created_at)}</span>
                    </div>
                    <div className="lib-seed">seed · {job.seed}</div>
                  </div>
                </article>
              );
            })}
            </div>
            {hasMore && (
              <div className="lib-load-more">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                >
                  加载更多(已显示 {visibleJobs.length} / {filtered.length})
                </button>
              </div>
            )}
          </>
        )}
      </div>

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

      {/* 删除确认对话框(替代原生 window.confirm,样式参考 AdminView) */}
      {confirmDelete && (
        <div
          className="lib-confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="确认删除作品"
          onClick={() => {
            if (!deletingId) setConfirmDelete(null);
          }}
        >
          <div
            className="lib-confirm-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lib-confirm-head">
              <div>
                <div className="lib-confirm-title">
                  <Icon name="delete" size={16} />
                  删除作品
                </div>
                <div className="lib-confirm-sub">此操作不可撤销</div>
              </div>
              <button
                type="button"
                className="lib-confirm-close"
                aria-label="关闭"
                disabled={deletingId !== null}
                onClick={() => setConfirmDelete(null)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="lib-confirm-body">
              <div className="lib-confirm-warn">
                确定删除这件作品?该操作不可撤销,作品的所有数据将被永久移除。
              </div>
              {confirmDelete.prompt && (
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
              <div className="lib-confirm-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={deletingId !== null}
                  onClick={() => setConfirmDelete(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn lib-confirm-delete"
                  disabled={deletingId !== null}
                  onClick={handleConfirmDelete}
                >
                  <Icon name={deletingId ? "loading" : "delete"} size={14} />
                  {deletingId ? "删除中…" : "确认删除"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
          border-bottom: 1px solid var(--hairline);
        }
        .lib-header-left {
          display: flex;
          align-items: baseline;
          gap: var(--space-3);
          min-width: 0;
        }
        .lib-title {
          margin: 0;
          font-family: var(--font-display);
          font-size: 1.5rem;
          font-weight: 500;
          letter-spacing: -0.02em;
          color: var(--ink);
          line-height: 1.2;
        }
        .lib-count {
          font-size: 0.78rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
          /* 预留宽度:"加载中…" → "N 件作品" 文本切换不挤动相邻元素(CLS 加固) */
          display: inline-block;
          min-width: 5em;
        }

        .lib-filters {
          display: inline-flex;
          gap: 2px;
          padding: 3px;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          /* 窄屏 5 个 filter 可能溢出,横向滚动 + 触摸惯性 */
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
        }
        .lib-filters::-webkit-scrollbar {
          display: none;
        }
        .lib-filter {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.35rem 0.7rem;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-xs);
          color: var(--ink-soft);
          font-size: 0.82rem;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: background-color var(--dur) var(--ease),
            color var(--dur) var(--ease), border-color var(--dur) var(--ease);
        }
        .lib-filter:hover {
          color: var(--ink);
          background: var(--bg-2);
        }
        .lib-filter.is-active {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .lib-filter-count {
          font-size: 0.68rem;
          /* 取消 opacity 0.7:激活态 accent-soft 文本经透明度衰减后对比度不达 WCAG AA */
          font-family: var(--font-mono);
          /* 预留宽度:计数从隐藏到显示不改变按钮宽度(CLS 加固) */
          display: inline-block;
          min-width: 1.1em;
          text-align: right;
        }

        .lib-body {
          min-height: 200px;
        }

        .lib-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: var(--space-4);
        }

        .lib-load-more {
          display: flex;
          justify-content: center;
          margin-top: var(--space-4);
        }

        .lib-card {
          position: relative;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          overflow: hidden;
          cursor: pointer;
          transition: border-color var(--dur-2) var(--ease),
            transform var(--dur-2) var(--ease),
            box-shadow var(--dur-2) var(--ease);
        }
        .lib-card:hover,
        .lib-card:focus-visible {
          border-color: var(--accent-line);
          box-shadow: 0 4px 24px -8px oklch(55% 0.20 265 / 0.25);
          outline: none;
        }
        .lib-card.is-deleting {
          opacity: 0.5;
          pointer-events: none;
        }

        .lib-thumb {
          position: relative;
          aspect-ratio: 1 / 1;
          background: var(--bg-2);
          overflow: hidden;
        }
        /* 预览触发按钮:铺满缩略区,重置 button 默认样式 */
        .lib-thumb-hit {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
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
          outline: 2px solid var(--accent);
          outline-offset: -2px;
        }
        .lib-thumb img,
        .lib-thumb video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          transition: transform var(--dur-2) var(--ease);
        }
        .lib-card:hover .lib-thumb img,
        .lib-card:hover .lib-thumb video {
          transform: scale(1.02);
        }

        .lib-thumb-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          color: var(--ink-faint);
          background: radial-gradient(
            circle at 50% 50%,
            var(--accent-wash),
            transparent 70%
          ),
          var(--bg-2);
        }
        .lib-thumb-status {
          font-size: 0.72rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
        }

        .lib-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: flex-end;
          padding: var(--space-3);
          background: linear-gradient(
            to top,
            oklch(3% 0.004 265 / 0.85),
            transparent 60%
          );
          opacity: 0;
          transition: opacity var(--dur-2) var(--ease);
          pointer-events: none;
        }
        .lib-card:hover .lib-overlay,
        .lib-card:focus-within .lib-overlay {
          opacity: 1;
        }
        .lib-overlay-prompt {
          font-size: 0.78rem;
          line-height: 1.45;
          color: var(--ink);
          display: -webkit-box;
          -webkit-line-clamp: 4;
          -webkit-box-orient: vertical;
          overflow: hidden;
          text-shadow: 0 1px 2px oklch(3% 0.004 265 / 0.6);
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
          background: oklch(3% 0.004 265 / 0.7);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-xs);
          color: var(--ink-soft);
          cursor: pointer;
          opacity: 0;
          transform: translateY(-2px);
          transition: opacity var(--dur-2) var(--ease),
            transform var(--dur-2) var(--ease),
            background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease),
            color var(--dur) var(--ease);
          z-index: 2;
        }
        .lib-card:hover .lib-delete,
        .lib-card:focus-within .lib-delete {
          opacity: 1;
          transform: translateY(0);
        }
        .lib-delete:hover {
          background: var(--danger-quiet);
          border-color: var(--danger);
          color: var(--danger);
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
          gap: 0.25rem;
          padding: 0.2rem 0.5rem;
          background: oklch(3% 0.004 265 / 0.7);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-full);
          font-size: 0.68rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          z-index: 1;
        }

        .lib-foot {
          padding: 0.6rem 0.75rem 0.7rem;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .lib-foot-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          min-width: 0;
        }
        .lib-kind {
          display: inline-flex;
          align-items: center;
          padding: 0.1rem 0.45rem;
          background: var(--accent-quiet);
          border: 1px solid var(--accent-line);
          border-radius: var(--radius-xs);
          font-size: 0.7rem;
          color: var(--accent-soft);
          font-weight: 500;
          white-space: nowrap;
        }
        .lib-time {
          font-size: 0.72rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          white-space: nowrap;
        }
        .lib-seed {
          font-size: 0.7rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
        }

        .lib-skeleton {
          pointer-events: none;
        }
        .lib-thumb-skel {
          aspect-ratio: 1 / 1;
          background: linear-gradient(
            90deg,
            var(--bg-2) 0%,
            var(--bg-3) 50%,
            var(--bg-2) 100%
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
          padding: 0.6rem 0.75rem 0.7rem;
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
        }
        .skel-line {
          /* 高度对齐真实 .lib-foot 行高(kind 徽标 ≈1.1rem / seed ≈0.97rem),
             骨架 → 真实卡片替换时行高一致,卡片底部不跳动(CLS 加固) */
          height: 0.85rem;
          border-radius: 4px;
          background: var(--bg-2);
        }
        .skel-w-1 {
          width: 50%;
        }
        .skel-w-2 {
          width: 70%;
        }

        .lib-empty {
          padding: var(--space-7) var(--space-4);
        }

        .lib-error {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-6);
          color: var(--ink-faint);
        }
        .lib-error-msg {
          font-size: 0.88rem;
          color: var(--ink-soft);
        }

        .lib-lightbox {
          position: fixed;
          inset: 0;
          z-index: 100;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-3);
          padding: var(--space-5);
          /* 背景基于 --bg-0 派生(随主题切换 / 颜色变更自动跟随) */
          background: color-mix(in oklch, var(--bg-0) 92%, black);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          animation: lb-fade var(--dur-2) var(--ease);
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
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-full);
          color: var(--ink-soft);
          cursor: pointer;
          transition: background-color var(--dur) var(--ease),
            color var(--dur) var(--ease);
        }
        .lib-lightbox-close:hover {
          background: var(--bg-3);
          color: var(--ink);
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
          border-radius: var(--radius);
          box-shadow: var(--shadow-lg);
        }
        .lib-lightbox-prompt {
          max-width: 80vw;
          font-size: 0.85rem;
          color: var(--ink-soft);
          text-align: center;
          line-height: 1.55;
          padding: 0 var(--space-4);
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        /* ── 删除确认对话框(替代原生 window.confirm,参考 AdminView)── */
        .lib-confirm-overlay {
          position: fixed;
          inset: 0;
          z-index: 100;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-4);
          background: oklch(3% 0.004 265 / 0.7);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          animation: lib-confirm-fade var(--dur-2) var(--ease);
        }
        @keyframes lib-confirm-fade {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .lib-confirm-overlay {
            animation: none;
          }
        }

        .lib-confirm-card {
          width: 100%;
          max-width: 420px;
          background: var(--bg-1);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-lg);
          overflow: hidden;
          animation: lib-confirm-pop var(--dur-2) var(--ease);
        }
        @keyframes lib-confirm-pop {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .lib-confirm-card {
            animation: none;
          }
        }

        .lib-confirm-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-4) var(--space-4) var(--space-3);
          border-bottom: 1px solid var(--hairline);
        }
        .lib-confirm-title {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-family: var(--font-display);
          font-size: 1.1rem;
          font-weight: 500;
          color: var(--danger);
          letter-spacing: -0.01em;
          line-height: 1.3;
        }
        .lib-confirm-sub {
          margin-top: 0.2rem;
          font-size: 0.78rem;
          color: var(--ink-faint);
        }
        .lib-confirm-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 0;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-xs);
          color: var(--ink-faint);
          cursor: pointer;
          transition: background-color var(--dur) var(--ease),
            color var(--dur) var(--ease);
        }
        .lib-confirm-close:hover {
          background: var(--bg-2);
          color: var(--ink);
        }
        .lib-confirm-close:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }

        .lib-confirm-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
        }
        .lib-confirm-warn {
          font-size: 0.88rem;
          color: var(--ink-soft);
          line-height: 1.55;
        }
        .lib-confirm-prompt {
          font-size: 0.78rem;
          color: var(--ink);
          font-family: var(--font-mono);
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          padding: 0.4rem 0.55rem;
          line-height: 1.5;
          word-break: break-word;
        }
        .lib-confirm-error {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.4rem 0.55rem;
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          border-radius: var(--radius-xs);
          color: var(--danger);
          font-size: 0.78rem;
        }
        .lib-confirm-actions {
          display: flex;
          justify-content: flex-end;
          gap: 0.4rem;
        }
        .lib-confirm-delete {
          background: var(--danger);
          border-color: var(--danger);
          color: var(--bg-0);
          min-width: 120px;
          justify-content: center;
        }
        .lib-confirm-delete:hover:not(:disabled) {
          filter: brightness(1.12);
        }
        .lib-confirm-delete:disabled {
          opacity: 0.6;
          cursor: not-allowed;
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

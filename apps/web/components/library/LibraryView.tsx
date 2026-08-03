"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { deleteJob, imageUrl, invalidateJobs, listJobs } from "@/lib/api";
import type { JobItem } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { Modal } from "@/components/ui/Modal";
import { Tabs } from "@/components/ui/Tabs";

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
          <Empty
            icon="library"
            title="还没有作品"
            desc="去创作页面生成第一件作品"
          />
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
                      <Badge tone="accent" dot={false}>{kindLabel(job.kind)}</Badge>
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

        .lib-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: var(--space-4);
        }
        @media (max-width: 480px) {
          .lib-grid {
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: var(--space-3);
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
          aspect-ratio: 1 / 1;
          background: var(--bg-surface-2);
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
          outline: 1px solid var(--accent);
          outline-offset: -2px;
        }
        .lib-thumb img,
        .lib-thumb video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          transition: transform var(--duration-base) var(--ease-standard);
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
          gap: var(--space-2);
          color: var(--text-muted);
          background: var(--bg-surface-2);
        }
        .lib-thumb-status {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .lib-thumb-status.is-running {
          color: var(--run);
        }
        .lib-thumb-status.is-error {
          color: var(--err);
        }

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

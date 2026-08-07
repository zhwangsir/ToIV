"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchBacklotDetail, imageUrl, listBacklot } from "@/lib/api";
import type {
  BacklotCard,
  BacklotDetail,
  BacklotProgress,
  BacklotShot,
  BacklotStage,
} from "@/lib/api";
import { Icon, type IconName } from "@/components/ui/Icon";

// ── 阶段元数据:徽章色调由 CSS data-stage → canonical 状态色映射 ──
const STAGE_META: Record<
  BacklotStage,
  { label: string; desc: string }
> = {
  drafting: { label: "草稿", desc: "剧本创作中" },
  imaging: { label: "分镜", desc: "画面生成中" },
  filming: { label: "拍摄", desc: "视频生成中" },
  voicing: { label: "配音", desc: "对白合成中" },
  done: { label: "完成", desc: "项目已交付" },
};

function formatTime(iso: string): string {
  if (!iso) return "—";
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

function shotStatusMeta(status: string): {
  icon: IconName;
  color: string;
  label: string;
} {
  const s = (status ?? "").toLowerCase();
  if (["done", "completed", "finished", "ready", "ok"].includes(s))
    return { icon: "success", color: "var(--ok)", label: "完成" };
  if (["running", "in_progress", "processing", "rendering", "busy"].includes(s))
    return { icon: "loading", color: "var(--run)", label: "进行中" };
  if (["error", "failed", "fail"].includes(s))
    return { icon: "error", color: "var(--err)", label: "失败" };
  return { icon: "queued", color: "var(--text-muted)", label: "待处理" };
}

function pct(value: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

// ── 子组件:阶段徽章(用 data-stage 驱动 CSS,避免 inline 样式覆盖问题) ──
function StageBadge({ stage }: { stage: BacklotStage }) {
  return (
    <span className="bl-stage" data-stage={stage}>
      <span className="bl-stage-dot" />
      {STAGE_META[stage].label}
    </span>
  );
}

// ── 子组件:三联进度条(图像/视频/配音) ──
function ProgressTriple({
  progress,
}: {
  progress: BacklotProgress;
}) {
  const total = progress?.total ?? 0;
  const items: { label: string; value: number; icon: IconName }[] = [
    { label: "图像", value: progress?.image_done ?? 0, icon: "image" },
    { label: "视频", value: progress?.video_done ?? 0, icon: "video" },
    { label: "配音", value: progress?.voiced ?? 0, icon: "audio" },
  ];
  return (
    <div className="bl-progress">
      {items.map((it) => {
        const p = pct(it.value, total);
        return (
          <div key={it.label} className="bl-progress-item">
            <div className="bl-progress-head">
              <span className="bl-progress-label">
                <Icon name={it.icon} size={11} strokeWidth={1.8} />
                {it.label}
              </span>
              <span className="bl-progress-count">
                {it.value}
                <span className="bl-progress-sep">/</span>
                {total}
              </span>
            </div>
            <div
              className="bl-progress-bar"
              role="progressbar"
              aria-label={`${it.label}进度`}
              aria-valuenow={p}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="bl-progress-fill" style={{ width: `${p}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 子组件:分镜行(序号 + 描述 + 状态图标 + 缩略图) ──
function ShotRow({ shot }: { shot: BacklotShot }) {
  const meta = shotStatusMeta(shot.status);
  const desc = shot.scene || `分镜 ${shot.idx}`;
  return (
    <li className="bl-shot">
      <div className="bl-shot-thumb">
        {shot.image_url ? (
          <img
            src={imageUrl(shot.image_url)}
            alt={desc}
            loading="lazy"
          />
        ) : (
          <div className="bl-shot-thumb-placeholder">
            <Icon name="image" size={14} strokeWidth={1.4} />
          </div>
        )}
        <span className="bl-shot-idx">#{shot.idx}</span>
      </div>

      <div className="bl-shot-info">
        <div className="bl-shot-scene" title={desc}>
          {desc}
        </div>
        {shot.dialogue && (
          <p className="bl-shot-dialogue">&ldquo;{shot.dialogue}&rdquo;</p>
        )}
        <div className="bl-shot-tags">
          {shot.camera && <span className="bl-shot-tag">{shot.camera}</span>}
          {shot.speaker && (
            <span className="bl-shot-tag bl-shot-tag-speaker">
              <Icon name="audio" size={10} />
              {shot.speaker}
            </span>
          )}
          {shot.duration_sec > 0 && (
            <span className="bl-shot-tag bl-shot-tag-dur">
              {shot.duration_sec}s
            </span>
          )}
        </div>
      </div>

      <div className="bl-shot-status" title={meta.label}>
        <Icon
          name={meta.icon}
          size={16}
          strokeWidth={1.8}
          className={meta.icon === "loading" ? "bl-spin" : undefined}
        />
        <span className="bl-shot-status-label" style={{ color: meta.color }}>
          {meta.label}
        </span>
      </div>
    </li>
  );
}

// ── 主组件 ──
export function BacklotView() {
  const [cards, setCards] = useState<BacklotCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BacklotDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // 任务 3:openDetail 竞态保护——快速切换项目时取消旧 in-flight 请求,
  // 避免旧响应 resolve 后覆盖新详情。
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listBacklot()
      .then(setCards)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载看板失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = useCallback((projectId: string) => {
    // 取消上一个 in-flight 请求,避免快速切换时旧响应覆盖新详情
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setActiveProjectId(projectId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    fetchBacklotDetail(projectId, ctrl.signal)
      .then((d) => {
        // 保险:resolve 期间若已被新请求覆盖则丢弃
        if (ctrl !== abortRef.current) return;
        setDetail(d);
      })
      .catch((err) => {
        // 被取消 / 已被新请求覆盖 → 静默忽略,不污染新状态
        if (ctrl !== abortRef.current) return;
        if (ctrl.signal.aborted) return;
        setDetailError(
          err instanceof Error ? err.message : "加载项目详情失败",
        );
      })
      .finally(() => {
        // 仅当仍是当前活跃请求时才复位 loading
        if (ctrl !== abortRef.current) return;
        setDetailLoading(false);
      });
  }, []);

  const closeDetail = useCallback(() => {
    // 关闭面板时取消当前 in-flight 请求,避免 resolve 后误触发 setDetail
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveProjectId(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  // 卸载时兜底取消 in-flight 请求,避免 setState on unmounted
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Esc 关闭面板 + 锁滚动
  useEffect(() => {
    if (!activeProjectId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [activeProjectId, closeDetail]);

  const activeCard =
    activeProjectId && cards
      ? (cards.find((c) => c.id === activeProjectId) ?? null)
      : null;

  const isEmpty = !loading && !error && (cards?.length ?? 0) === 0;
  const count = cards?.length ?? 0;

  return (
    <div className="single-view backlot-view">
      <header className="bl-header">
        <div className="bl-header-left">
          <div className="bl-titles">
            <h1 className="bl-title">看板</h1>
            <span className="bl-subtitle">项目仪表盘</span>
          </div>
          <span className="bl-count" aria-live="polite">
            {loading ? "加载中" : error ? "—" : `${count} 个项目`}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-sm bl-refresh"
          onClick={load}
          disabled={loading}
        >
          <Icon
            name="refresh"
            size={14}
            className={loading ? "bl-spin" : undefined}
          />
          刷新
        </button>
      </header>

      <div className="bl-body">
        {error && !loading && (
          <div className="bl-error">
            <Icon name="error" size={36} strokeWidth={1.4} />
            <div className="bl-error-msg">{error}</div>
            <button type="button" className="btn btn-sm" onClick={load}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        )}

        {!error && loading && (
          <div className="bl-loading">
            <div className="loading-spinner">
              <Icon name="loading" size={18} className="bl-spin" />
              <span>正在加载看板…</span>
            </div>
          </div>
        )}

        {!error && !loading && isEmpty && (
          <div className="empty-state bl-empty">
            <div className="empty-state-icon">
              <Icon name="backlot" size={48} strokeWidth={1.2} />
            </div>
            <div className="empty-state-title">还没有项目</div>
            <div className="empty-state-desc">
              项目仪表盘为空 · 创建第一个项目开始创作
            </div>
          </div>
        )}

        {!error && !loading && cards && cards.length > 0 && (
          <div className="bl-grid">
            {cards.map((card) => (
              <article
                key={card.id}
                className="bl-card"
                tabIndex={0}
                role="button"
                aria-label={`查看项目 ${card.title}`}
                onClick={() => openDetail(card.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDetail(card.id);
                  }
                }}
              >
                <div className="bl-thumb">
                  {card.thumbnail ? (
                    <img
                      src={imageUrl(card.thumbnail)}
                      alt={card.title}
                      loading="lazy"
                    />
                  ) : (
                    <div className="bl-thumb-placeholder">
                      <Icon name="backlot" size={32} strokeWidth={1.3} />
                    </div>
                  )}
                </div>

                <div className="bl-card-body">
                  <div className="bl-card-head">
                    <h3 className="bl-card-title" title={card.title}>
                      {card.title}
                    </h3>
                    <StageBadge stage={card.stage} />
                  </div>

                  {card.premise && (
                    <p className="bl-card-premise">{card.premise}</p>
                  )}

                  <ProgressTriple progress={card.progress} />

                  <div className="bl-card-foot">
                    <span className="bl-meta">
                      <Icon name="backlot" size={12} />
                      {card.shot_count ?? 0} 镜
                    </span>
                    <span className="bl-time">
                      {formatTime(card.updated_at)}
                    </span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Slide-over 详情面板(从右侧滑入) */}
      {activeProjectId && (
        <div
          className="bl-overlay"
          onClick={closeDetail}
          role="presentation"
        >
          <div
            className="bl-panel"
            role="dialog"
            aria-modal="true"
            aria-label="项目详情"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="bl-panel-head">
              <div className="bl-panel-titles">
                <h2 className="bl-panel-title">
                  {detail?.project.title ?? activeCard?.title ?? "项目详情"}
                </h2>
                {(detail?.project.premise || activeCard?.premise) && (
                  <p className="bl-panel-premise">
                    {detail?.project.premise ?? activeCard?.premise}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="bl-panel-close"
                aria-label="关闭详情"
                onClick={closeDetail}
              >
                <Icon name="close" size={18} />
              </button>
            </header>

            <div className="bl-panel-body">
              {/* 阶段 */}
              <div className="bl-panel-stage">
                <StageBadge
                  stage={detail?.stage ?? activeCard?.stage ?? "drafting"}
                />
                <span className="bl-panel-stage-desc">
                  {STAGE_META[detail?.stage ?? activeCard?.stage ?? "drafting"]
                    .desc}
                </span>
              </div>

              {/* 进度统计 */}
              <section className="bl-panel-section">
                <div className="bl-panel-section-title">进度</div>
                {detail ? (
                  <ProgressTriple progress={detail.progress} />
                ) : activeCard ? (
                  <ProgressTriple progress={activeCard.progress} />
                ) : null}
              </section>

              {/* 分镜列表 */}
              <section className="bl-panel-section">
                <div className="bl-panel-section-title">
                  分镜
                  {detail?.shots?.length ? (
                    <span className="bl-panel-section-count">
                      {detail.shots.length}
                    </span>
                  ) : null}
                </div>

                {detailLoading && !detail && (
                  <div className="loading-spinner bl-panel-loading">
                    <Icon name="loading" size={16} className="bl-spin" />
                    <span>加载分镜…</span>
                  </div>
                )}

                {detailError && (
                  <div className="bl-panel-error">
                    <Icon name="error" size={20} />
                    <span>{detailError}</span>
                    {activeProjectId && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => openDetail(activeProjectId)}
                      >
                        <Icon name="refresh" size={12} />
                        重试
                      </button>
                    )}
                  </div>
                )}

                {detail &&
                  (!detail.shots || detail.shots.length === 0) && (
                    <div className="bl-panel-empty-shots">
                      <Icon name="backlot" size={28} strokeWidth={1.3} />
                      <span>暂无分镜</span>
                    </div>
                  )}

                {detail && detail.shots && detail.shots.length > 0 && (
                  <ul className="bl-shots">
                    {detail.shots.map((shot) => (
                      <ShotRow key={shot.id} shot={shot} />
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </div>
      )}

      {/* 子组件(ProgressTriple/ShotRow)外置,scoped styled-jsx 不跨组件边界,须 global(bl- 前缀不泄漏) */}
      <style jsx global>{`
        .backlot-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }

        /* ── 顶部 ── */
        .bl-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: var(--space-4);
          flex-wrap: wrap;
          padding-bottom: var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
        }
        .bl-header-left {
          display: flex;
          align-items: baseline;
          gap: var(--space-3);
          min-width: 0;
        }
        .bl-titles {
          display: flex;
          flex-direction: column;
          gap: 0.05rem;
          min-width: 0;
        }
        .bl-title {
          margin: 0;
          font-family: var(--font-sans);
          font-size: var(--text-title);
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          line-height: 1.3;
        }
        .bl-subtitle {
          font-size: 0.72rem;
          color: var(--text-muted);
          line-height: 1.3;
        }
        .bl-count {
          font-size: 0.78rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.01em;
        }
        .bl-refresh :global(svg) {
          transition: transform var(--duration-fast) var(--ease-standard);
        }

        /* ── 主体 ── */
        .bl-body {
          min-height: 200px;
        }
        .bl-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-6) var(--space-4);
        }
        .bl-error {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-6);
          color: var(--text-muted);
        }
        .bl-error-msg {
          font-size: 0.88rem;
          color: var(--text-secondary);
        }

        /* ── 卡片网格 ── */
        .bl-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: var(--space-4);
        }

        .bl-card {
          display: flex;
          flex-direction: column;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          overflow: hidden;
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .bl-card:hover {
          border-color: var(--border-strong);
        }
        .bl-card:focus-visible {
          border-color: var(--border-strong);
          outline: 1px solid var(--accent);
          outline-offset: 2px;
        }

        /* 缩略图 16:9 */
        .bl-thumb {
          position: relative;
          aspect-ratio: 16 / 9;
          background: var(--bg-surface-2);
          overflow: hidden;
        }
        .bl-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          transition: transform var(--duration-base) var(--ease-standard);
        }
        .bl-card:hover .bl-thumb img {
          transform: scale(1.04);
        }
        .bl-thumb-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
          background: radial-gradient(
              circle at 50% 50%,
              var(--accent-soft),
              transparent 70%
            ),
            var(--bg-surface-2);
        }

        /* 卡片正文 */
        .bl-card-body {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          padding: 0.75rem 0.85rem 0.7rem;
        }
        .bl-card-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          min-width: 0;
        }
        .bl-card-title {
          margin: 0;
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--text-primary);
          line-height: 1.3;
          letter-spacing: -0.01em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
          flex: 1;
        }
        .bl-card-premise {
          margin: 0;
          font-size: 0.78rem;
          color: var(--text-muted);
          line-height: 1.45;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .bl-card-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          padding-top: 0.5rem;
          border-top: 1px solid var(--border-subtle);
          margin-top: 0.1rem;
        }
        .bl-meta {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          font-size: 0.72rem;
          color: var(--text-secondary);
        }
        .bl-time {
          font-size: 0.7rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
        }

        /* ── 阶段徽章(5 种色调,用 data-stage 驱动 --stage-color) ── */
        .bl-stage {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.18rem 0.55rem;
          border: 1px solid;
          border-radius: var(--radius-full);
          font-size: 0.68rem;
          font-weight: 500;
          letter-spacing: 0.01em;
          white-space: nowrap;
          flex-shrink: 0;
          color: var(--stage-color);
          background: color-mix(in oklch, var(--stage-color) 14%, transparent);
          border-color: color-mix(in oklch, var(--stage-color) 40%, transparent);
        }
        .bl-stage-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
          background: var(--stage-color);
        }
        /* 5 阶段色调 → --stage-color 映射(直连 canonical 状态色 token) */
        .bl-stage[data-stage="drafting"] { --stage-color: var(--warn); }
        .bl-stage[data-stage="imaging"] { --stage-color: var(--run); }
        .bl-stage[data-stage="filming"] { --stage-color: var(--accent); }
        .bl-stage[data-stage="voicing"] { --stage-color: var(--accent); }
        .bl-stage[data-stage="done"] { --stage-color: var(--ok); }

        /* ── 三联进度条 ── */
        .bl-progress {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .bl-progress-item {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .bl-progress-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .bl-progress-label {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          font-size: 0.72rem;
          color: var(--text-secondary);
        }
        .bl-progress-count {
          font-size: 0.7rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.02em;
        }
        .bl-progress-sep {
          opacity: 0.5;
          margin: 0 0.05rem;
        }
        .bl-progress-bar {
          position: relative;
          height: 4px;
          background: var(--bg-surface-3);
          border-radius: 2px;
          overflow: hidden;
        }
        .bl-progress-fill {
          position: absolute;
          top: 0;
          left: 0;
          bottom: 0;
          background: var(--accent);
          border-radius: 2px;
          transition: width var(--duration-base) var(--ease-standard);
        }

        /* ── Slide-over 详情面板 ── */
        .bl-overlay {
          position: fixed;
          inset: 0;
          z-index: 90;
          background: var(--overlay-strong);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          animation: bl-fade-in var(--duration-base) var(--ease-standard);
        }
        @keyframes bl-fade-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        .bl-panel {
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          width: min(480px, 100vw);
          display: flex;
          flex-direction: column;
          background: var(--bg-surface-1);
          border-left: 1px solid var(--border-strong);
          box-shadow: var(--shadow-xl);
          animation: bl-slide-in var(--duration-base) var(--ease-standard);
        }
        @keyframes bl-slide-in {
          from {
            transform: translateX(100%);
          }
          to {
            transform: translateX(0);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .bl-overlay,
          .bl-panel {
            animation: none;
          }
        }

        .bl-panel-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
          flex-shrink: 0;
        }
        .bl-panel-titles {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          min-width: 0;
          flex: 1;
        }
        .bl-panel-title {
          margin: 0;
          font-family: var(--font-sans);
          font-size: var(--text-section);
          font-weight: 600;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          line-height: 1.25;
          word-break: break-word;
        }
        .bl-panel-premise {
          margin: 0;
          font-size: 0.8rem;
          color: var(--text-muted);
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .bl-panel-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 0;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-xs);
          color: var(--text-secondary);
          cursor: pointer;
          flex-shrink: 0;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .bl-panel-close:hover {
          background: var(--bg-surface-2);
          border-color: var(--border-strong);
          color: var(--text-primary);
        }
        .bl-panel-close:focus-visible {
          outline: 1px solid var(--accent);
          outline-offset: 2px;
        }

        .bl-panel-body {
          flex: 1;
          overflow-y: auto;
          padding: var(--space-4);
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }

        .bl-panel-stage {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          flex-wrap: wrap;
        }
        .bl-panel-stage-desc {
          font-size: 0.78rem;
          color: var(--text-muted);
        }

        .bl-panel-section {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
        }
        .bl-panel-section-title {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.72rem;
          font-weight: 600;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .bl-panel-section-count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 20px;
          height: 18px;
          padding: 0 0.4rem;
          background: var(--bg-surface-3);
          border-radius: var(--radius-full);
          font-size: 0.68rem;
          color: var(--text-secondary);
          font-family: var(--font-mono);
          letter-spacing: 0;
        }

        .bl-panel-loading {
          padding: var(--space-3) 0;
        }
        .bl-panel-error {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          padding: var(--space-4);
          color: var(--text-muted);
          font-size: 0.85rem;
          text-align: center;
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .bl-panel-empty-shots {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          padding: var(--space-5) var(--space-3);
          color: var(--text-muted);
          font-size: 0.82rem;
          text-align: center;
          background: var(--bg-surface-2);
          border: 1px dashed var(--border-strong);
          border-radius: var(--radius-control);
        }

        /* ── 分镜列表 ── */
        .bl-shots {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .bl-shot {
          display: flex;
          align-items: stretch;
          gap: 0.65rem;
          padding: 0.5rem;
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .bl-shot:hover {
          border-color: var(--border-strong);
          background: var(--bg-surface-3);
        }

        .bl-shot-thumb {
          position: relative;
          width: 56px;
          height: 56px;
          flex-shrink: 0;
          background: var(--bg-surface-3);
          border-radius: var(--radius-xs);
          overflow: hidden;
        }
        .bl-shot-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .bl-shot-thumb-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
        }
        .bl-shot-idx {
          position: absolute;
          bottom: 2px;
          left: 2px;
          padding: 0 0.3rem;
          background: var(--overlay-strong);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          border-radius: 3px;
          font-size: 0.6rem;
          color: var(--text-secondary);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          line-height: 1.4;
        }

        .bl-shot-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
        }
        .bl-shot-scene {
          font-size: 0.82rem;
          color: var(--text-primary);
          line-height: 1.4;
          font-weight: 500;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .bl-shot-dialogue {
          margin: 0;
          font-size: 0.74rem;
          color: var(--text-muted);
          font-style: italic;
          line-height: 1.4;
          display: -webkit-box;
          -webkit-line-clamp: 1;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .bl-shot-tags {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          flex-wrap: wrap;
          margin-top: 0.15rem;
        }
        .bl-shot-tag {
          display: inline-flex;
          align-items: center;
          gap: 0.2rem;
          padding: 0.05rem 0.4rem;
          background: var(--bg-surface-3);
          border-radius: var(--radius-xs);
          font-size: 0.66rem;
          color: var(--text-secondary);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
        }
        .bl-shot-tag-speaker {
          color: var(--accent);
          background: var(--accent-soft);
        }
        .bl-shot-tag-dur {
          color: var(--text-muted);
        }

        .bl-shot-status {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.15rem;
          flex-shrink: 0;
          padding: 0 0.2rem;
          min-width: 44px;
        }
        .bl-shot-status-label {
          font-size: 0.62rem;
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
        }

        /* ── 旋转动画(loading / refresh) ── */
        .bl-spin {
          animation: bl-spin 1s linear infinite;
        }
        @keyframes bl-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .bl-spin {
            animation: none;
          }
        }

        /* ── 空态内边距 ── */
        .bl-empty {
          padding: var(--space-7) var(--space-4);
        }

        /* ── 移动端 ── */
        @media (max-width: 768px) {
          .bl-header {
            flex-direction: column;
            align-items: stretch;
            gap: var(--space-3);
          }
          .bl-header-left {
            justify-content: space-between;
          }
          .bl-grid {
            grid-template-columns: 1fr;
            gap: var(--space-3);
          }
          .bl-panel {
            width: 100vw;
          }
        }
      `}</style>
    </div>
  );
}

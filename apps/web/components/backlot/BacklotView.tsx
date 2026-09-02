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
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";

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
            decoding="async"
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
export function BacklotView({
  onCreateProject,
}: {
  /** 空态 CTA:跳转工作室创建项目(2026-08-30 批 D,空态不再死胡同) */
  onCreateProject?: () => void;
} = {}) {
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
      {/* 页头移除(2026-09-02 W3):项目计数 + 刷新收进窄工具行 */}
      <div className="bl-mode-row">
        <span className="bl-count" aria-live="polite">
          {loading ? "加载中" : error ? "—" : `${count} 个项目`}
        </span>
        <button
          type="button"
          className="at-btn at-btn--ghost bl-refresh"
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
      </div>

      <div className="bl-body">
        {error && !loading && (
          <ErrorBar message={error} onClose={load} />
        )}

        {!error && loading && (
          <div className="bl-grid bl-skeleton" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="bl-skel-card">
                <div className="bl-skel bl-skel-thumb" />
                <div className="bl-skel-body">
                  <div className="bl-skel bl-skel-line bl-skel-line-lg" />
                  <div className="bl-skel bl-skel-line" />
                  <div className="bl-skel bl-skel-line bl-skel-line-sm" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!error && !loading && isEmpty && (
          /* 批 D:私造空态收编 ui/Empty + 补「前往工作室创建」CTA(原空态死胡同) */
          <Empty
            icon="backlot"
            title="还没有项目"
            desc="项目仪表盘为空 · 创建第一个项目开始创作"
            action={
              onCreateProject ? (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Icon name="plus" size={14} />}
                  onClick={onCreateProject}
                >
                  前往工作室创建
                </Button>
              ) : undefined
            }
          />
        )}

        {!error && !loading && cards && cards.length > 0 && (
          <div className="bl-grid">
            {cards.map((card) => (
              <article
                key={card.id}
                className="bl-card"
                data-stage={card.stage}
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
                      decoding="async"
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
                  /* 加载态(UI-A LoadingBlock):行骨架替代原文字+转圈 */
                  <div className="bl-panel-loading" role="status" aria-label="加载分镜中">
                    <LoadingBlock variant="line" count={2} />
                  </div>
                )}

                {detailError && (
                  <div className="bl-panel-error">
                    {/* 错误态(UI-A ErrorBar):role=alert + 可关闭;重试保留在条外 */}
                    <ErrorBar message={detailError} onClose={() => setDetailError(null)} />
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
          gap: var(--section-gap);
        }

        /* ── 工具行(2026-09-02 W3 页头移除):项目计数在左,刷新在右 ── */
        .bl-mode-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
          padding: 0 0 var(--space-3);
        }
        .bl-count {
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.01em;
          color: var(--text-secondary);
        }
        .bl-refresh :global(svg) {
          transition: transform var(--duration-fast) var(--ease-standard);
        }

        /* ── 主体 ── */
        .bl-body {
          min-height: 200px;
        }
        .bl-error {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-4);
          padding: var(--space-10) var(--space-6);
          color: var(--text-muted);
        }
        .bl-error-msg {
          font-size: var(--text-body);
          color: var(--text-secondary);
        }

        /* ── 卡片网格(2026-08-24 排版统一:间距消费 --section-gap) ── */
        .bl-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: var(--section-gap);
        }

        .bl-card {
          position: relative;
          display: flex;
          flex-direction: column;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          overflow: hidden;
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-base) var(--ease-standard),
            transform var(--duration-base) var(--ease-standard);
        }
        /* 阶段状态色条(左缘,随 data-stage 变色) */
        .bl-card::before {
          content: "";
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 3px;
          background: var(--stage-color, var(--border-subtle));
          z-index: 1;
        }
        .bl-card:hover {
          border-color: var(--border-strong);
          box-shadow: var(--shadow-lg);
          transform: translateY(-3px);
        }
        .bl-card:focus-visible {
          border-color: var(--border-strong);
          outline: 2px solid var(--accent);
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
          transform: scale(1.05);
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

        /* 卡片正文(2026-08-24 排版统一:卡内 padding 回 16 档) */
        .bl-card-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
          flex: 1;
        }
        .bl-card-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          min-width: 0;
        }
        .bl-card-title {
          margin: 0;
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          line-height: 1.35;
          letter-spacing: -0.01em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
          flex: 1;
        }
        .bl-card-premise {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.6;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .bl-card-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
          margin-top: auto;
          padding-top: var(--space-3);
          border-top: 1px solid var(--border-subtle);
        }
        .bl-meta {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-aux);
          color: var(--text-secondary);
        }
        .bl-time {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
        }

        /* ── 阶段徽章(5 种色调,用 data-stage 驱动 --stage-color) ── */
        .bl-stage {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: 2px var(--space-2);
          border: 1px solid;
          border-radius: var(--radius-badge);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
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
        /* 5 阶段色调 → --stage-color 映射(直连 canonical 状态色 token;卡片色条与徽章共用) */
        .bl-stage[data-stage="drafting"], .bl-card[data-stage="drafting"] { --stage-color: var(--warn); }
        .bl-stage[data-stage="imaging"], .bl-card[data-stage="imaging"] { --stage-color: var(--run); }
        .bl-stage[data-stage="filming"], .bl-card[data-stage="filming"] { --stage-color: var(--accent); }
        .bl-stage[data-stage="voicing"], .bl-card[data-stage="voicing"] { --stage-color: var(--accent); }
        .bl-stage[data-stage="done"], .bl-card[data-stage="done"] { --stage-color: var(--ok); }

        /* ── 三联进度条 ── */
        .bl-progress {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .bl-progress-item {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .bl-progress-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .bl-progress-label {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          color: var(--text-secondary);
        }
        .bl-progress-count {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.02em;
        }
        .bl-progress-sep {
          opacity: 0.5;
          margin: 0 1px;
        }
        .bl-progress-bar {
          position: relative;
          height: 6px;
          background: var(--bg-surface-3);
          border-radius: var(--radius-xs);
          overflow: hidden;
        }
        .bl-progress-fill {
          position: absolute;
          top: 0;
          left: 0;
          bottom: 0;
          background: var(--accent);
          border-radius: var(--radius-xs);
          transition: width var(--duration-base) var(--ease-standard);
        }

        /* ── Slide-over 详情面板 ── */
        .bl-overlay {
          position: fixed;
          inset: 0;
          /* 右滑详情抽屉:归入全局 z-index 语义档 --z-drawer(200),原裸值 90 */
          z-index: var(--z-drawer);
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
          width: min(560px, 100vw);
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
          gap: var(--space-4);
          padding: var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
          flex-shrink: 0;
        }
        .bl-panel-titles {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          min-width: 0;
          flex: 1;
        }
        .bl-panel-title {
          margin: 0;
          font-family: var(--font-sans);
          font-size: var(--text-title);
          font-weight: var(--font-bold);
          letter-spacing: -0.02em;
          color: var(--text-primary);
          line-height: 1.25;
          word-break: break-word;
        }
        .bl-panel-premise {
          margin: 0;
          font-size: var(--text-body);
          color: var(--text-muted);
          line-height: 1.6;
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
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .bl-panel-stage-desc {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }

        .bl-panel-section {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .bl-panel-section-title {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--text-label);
          font-weight: var(--font-semibold);
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
          padding: 0 var(--space-1);
          background: var(--bg-surface-3);
          border-radius: var(--radius-badge);
          font-size: var(--text-label);
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
          gap: var(--space-2);
          padding: var(--space-4);
          color: var(--text-muted);
          font-size: var(--text-body);
          text-align: center;
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .bl-panel-empty-shots {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-5) var(--space-3);
          color: var(--text-muted);
          font-size: var(--text-aux);
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
          gap: var(--space-2);
        }
        .bl-shot {
          display: flex;
          align-items: stretch;
          gap: var(--space-3);
          padding: var(--space-2);
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
          padding: 0 var(--space-1);
          background: var(--overlay-strong);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          border-radius: var(--radius-xs);
          font-size: var(--text-label);
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
          gap: var(--space-1);
        }
        .bl-shot-scene {
          font-size: var(--text-body);
          color: var(--text-primary);
          line-height: 1.4;
          font-weight: var(--font-medium);
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .bl-shot-dialogue {
          margin: 0;
          font-size: var(--text-aux);
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
          gap: var(--space-1);
          flex-wrap: wrap;
        }
        .bl-shot-tag {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: 1px var(--space-2);
          background: var(--bg-surface-3);
          border-radius: var(--radius-xs);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
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
          gap: var(--space-1);
          flex-shrink: 0;
          padding: 0 var(--space-1);
          min-width: 44px;
        }
        .bl-shot-status-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
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

        /* ── 移动端 ── */
        @media (max-width: 767px) {
          .bl-grid {
            grid-template-columns: 1fr;
            gap: var(--space-3);
          }
          .bl-panel {
            width: 100vw;
          }
          /* 触控目标 ≥44px */
          .bl-panel-close {
            width: 44px;
            height: 44px;
          }
          .bl-refresh {
            min-height: 44px;
          }
        }
      `}</style>
    </div>
  );
}

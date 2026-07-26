"use client";

import { AgentBar } from "@/components/studio/AgentBar";
import { StoryboardGrid } from "@/components/studio/StoryboardGrid";
import { ShotInspector } from "@/components/studio/ShotInspector";
import { TimelineBar } from "@/components/studio/TimelineBar";
import { Icon } from "@/components/ui/Icon";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface StudioSpaceViewProps {
  project: UseDramaProjectReturn;
}

/**
 * Film Atelier · 项目空间总装(LibTV 工作室视图)。
 * 顶部 Agent 命令条 + 中部故事板 + 右侧镜头检查器 + 底部时间轴,
 * 取代旧 Tab 分阶段界面;<1080px 主区分栏上下堆叠。
 */
export function StudioSpaceView({ project }: StudioSpaceViewProps) {
  const { current, shots, doneCount, loading, error, reload } = project;

  // ── 加载中(首屏尚无详情)──
  if (loading && !current) {
    return (
      <div className="fa-space-state" aria-busy="true">
        <Icon name="loading" size={20} className="fa-spin" />
        <span>正在进入项目空间…</span>
        <style jsx>{`
          .fa-space-state {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 96px 20px;
            color: var(--fa-ink3);
            font-size: 12.5px;
          }
          .fa-spin {
            animation: fa-spin 1s linear infinite;
            color: var(--fa-amber);
          }
          @keyframes fa-spin {
            to {
              transform: rotate(360deg);
            }
          }
          @media (prefers-reduced-motion: reduce) {
            .fa-spin {
              animation: none;
            }
          }
        `}</style>
      </div>
    );
  }

  // ── 加载失败(详情未拿到)──
  if (error && !current) {
    return (
      <div className="fa-space-state fa-space-state-err">
        <Icon name="error" size={18} />
        <span>{error}</span>
        <button
          type="button"
          className="fa-space-retry"
          onClick={() => reload()}
        >
          <Icon name="refresh" size={12} />
          重试
        </button>
        <style jsx>{`
          .fa-space-state {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 96px 20px;
            color: var(--fa-ink3);
            font-size: 12.5px;
          }
          .fa-space-state-err {
            color: var(--fa-red);
          }
          .fa-space-retry {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 5px 12px;
            border-radius: 6px;
            font-size: 11px;
            background: transparent;
            color: var(--fa-ink2);
            border: 1px solid var(--fa-line-hi);
            cursor: pointer;
            transition: all 0.2s ease;
          }
          .fa-space-retry:hover {
            color: var(--fa-ink);
            border-color: var(--fa-ink3);
          }
        `}</style>
      </div>
    );
  }

  if (!current) return null;

  const total = shots.length;
  const statusText =
    current.status === "ready"
      ? "已成片"
      : total > 0
        ? `故事板 ${doneCount}/${total}`
        : "草稿 · 待拆解";

  return (
    <div className="fa-space">
      {/* ── 顶栏:项目名 + 状态 ── */}
      <header className="fa-topbar">
        <div className="fa-proj">
          <h2 className="fa-proj-name">{current.title || "未命名项目"}</h2>
          <span className="fa-proj-status">
            <i aria-hidden="true" />
            项目空间 · {statusText}
          </span>
        </div>
        <div className="fa-proj-spec">
          {current.width}×{current.height} · {current.fps}fps
        </div>
      </header>

      {/* ── 顶部:Agent 命令条 ── */}
      <AgentBar project={project} />

      {/* ── 中部:故事板 + 右侧镜头检查器 ── */}
      <div className="fa-work">
        <div className="fa-canvas">
          <StoryboardGrid project={project} />
        </div>
        <ShotInspector project={project} />
      </div>

      {/* ── 底部:时间轴 ── */}
      <TimelineBar project={project} />

      <style jsx>{`
        .fa-space {
          display: flex;
          flex-direction: column;
          gap: 14px;
          min-width: 0;
        }

        /* ── 顶栏 ── */
        .fa-topbar {
          display: flex;
          align-items: center;
          gap: 16px;
        }
        .fa-proj {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }
        .fa-proj-name {
          margin: 0;
          font-family: var(--fa-serif);
          font-size: 17px;
          font-weight: 600;
          color: var(--fa-ink);
          line-height: 1.25;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fa-proj-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-family: var(--fa-mono);
          font-size: 10px;
          letter-spacing: 0.1em;
          color: var(--fa-amber);
        }
        .fa-proj-status i {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--fa-amber);
          animation: fa-breathe 4s ease-in-out infinite;
        }
        .fa-proj-spec {
          margin-left: auto;
          flex-shrink: 0;
          font-family: var(--fa-mono);
          font-size: 10px;
          letter-spacing: 0.06em;
          color: var(--fa-ink3);
          border: 1px solid var(--fa-line);
          border-radius: 20px;
          padding: 4px 12px;
        }

        /* ── 主区:故事板 1fr + 检查器 320px ── */
        .fa-work {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 320px;
          gap: 14px;
          align-items: start;
        }
        .fa-canvas {
          min-width: 0;
        }
        /* 检查器吸附顶部,滚动故事板时保持可见 */
        .fa-work :global(.fa-panel) {
          position: sticky;
          top: 14px;
          max-height: calc(100vh - 28px);
        }

        @keyframes fa-breathe {
          0%,
          100% {
            opacity: 0.35;
          }
          50% {
            opacity: 1;
          }
        }

        /* ── 响应式:<1080px 主区上下堆叠 ── */
        @media (max-width: 1080px) {
          .fa-work {
            grid-template-columns: 1fr;
          }
          .fa-work :global(.fa-panel) {
            position: static;
            max-height: none;
          }
        }
        @media (max-width: 720px) {
          .fa-proj-spec {
            display: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .fa-proj-status i {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

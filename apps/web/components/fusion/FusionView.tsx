"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";

interface FusionApp {
  /** 打开目标:视图 key,可带查询串(如漫剧走短剧工作室的 manju 模式) */
  target: string;
  icon: IconName;
  name: string;
  desc: string;
  /** 能力标签,用于卡片底部 chips */
  tags: string[];
  /** 主视觉渐变(与全局 accent 协调的低饱和双色) */
  gradient: string;
}

const FUSION_APPS: FusionApp[] = [
  {
    target: "studio",
    icon: "clapperboard",
    name: "创作工作室",
    desc: "剧本 → 角色 → 分镜 → 成片:每个分镜独立选择视频生成或图像运镜,一站式创作。",
    tags: ["AI 拆解", "分镜混排", "配音合成"],
    gradient: "linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(139,92,246,0.04) 100%)",
  },
  {
    target: "avatartalk",
    icon: "user",
    name: "数字人",
    desc: "实时对话数字人:语音交互、口型驱动,面对面交流。",
    tags: ["实时对话", "口型驱动", "WebRTC"],
    gradient: "linear-gradient(135deg, rgba(236,72,153,0.08) 0%, rgba(244,114,182,0.04) 100%)",
  },
  {
    target: "dub",
    icon: "dub",
    name: "译制",
    desc: "视频听写、翻译、克隆配音、对口型,一站式多语言译制。",
    tags: ["语音克隆", "多语言", "对口型"],
    gradient: "linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(96,165,250,0.04) 100%)",
  },
];

/**
 * 融合应用聚合页(M3/M4):应用卡点击「进入」跳转对应视图(不重写子应用)。
 * M4-studio:短剧/漫剧双卡合并为「创作工作室」(studio 模块,分镜级混合生成)。
 *
 * M4 和谐化:统一卡片网格节奏、微交互动效、与全局 Film Atelier 语言对齐。
 */
export function FusionView({ onNavigate }: { onNavigate: (target: string) => void }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const cards = gridRef.current?.querySelectorAll(".fusion-card");
    if (!cards) return;
    cards.forEach((card) => {
      const rect = card.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      (card as HTMLElement).style.setProperty("--mouse-x", `${x}%`);
      (card as HTMLElement).style.setProperty("--mouse-y", `${y}%`);
    });
  }, []);

  return (
    <div className="fusion-view" onMouseMove={handleMouseMove}>
      {/* ── 头部 ── */}
      <header className="fusion-header">
        <div className="fusion-header-main">
          <h1 className="fusion-title">融合应用</h1>
          <p className="fusion-subtitle">多能力组合的创作入口</p>
        </div>
        <div className="fusion-header-meta">
          <span className="fusion-count">{FUSION_APPS.length} 个应用</span>
        </div>
      </header>

      {/* ── 应用卡片网格 ── */}
      <div className="fusion-grid" ref={gridRef}>
        {FUSION_APPS.map((app, idx) => (
          <Card
            key={app.name}
            hoverable
            className={`fusion-card${mounted ? " is-mounted" : ""}`}
            style={{
              "--card-gradient": app.gradient,
              "--delay": `${idx * 60}ms`,
            } as React.CSSProperties}
            onMouseEnter={() => setHoveredIndex(idx)}
            onMouseLeave={() => setHoveredIndex(null)}
            onClick={() => onNavigate(app.target)}
          >
            {/* 背景光晕 */}
            <div className="fusion-card-glow" aria-hidden="true" />

            {/* 图标 + 名称 */}
            <div className="fusion-card-head">
              <div className="fusion-card-icon-wrap">
                <Icon name={app.icon} size={22} />
              </div>
              <div className="fusion-card-title-group">
                <h3 className="fusion-card-name">{app.name}</h3>
                <div className="fusion-card-arrow" aria-hidden="true">
                  <Icon name="chevron-right" size={16} />
                </div>
              </div>
            </div>

            {/* 描述 */}
            <p className="fusion-card-desc">{app.desc}</p>

            {/* 能力标签 */}
            <div className="fusion-card-tags">
              {app.tags.map((tag) => (
                <span key={tag} className="fusion-tag">
                  {tag}
                </span>
              ))}
            </div>

            {/* 底部操作区 */}
            <div className="fusion-card-footer">
              <span className="fusion-card-cta">
                进入应用
                <Icon name="chevron-right" size={14} />
              </span>
            </div>
          </Card>
        ))}
      </div>

      <style jsx>{`
        .fusion-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-6);
          height: 100%;
          overflow-y: auto;
          padding: var(--space-6);
        }

        /* ── 头部 ── */
        .fusion-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: var(--space-4);
          flex-shrink: 0;
          padding-bottom: var(--space-2);
          border-bottom: 1px solid var(--border-subtle);
        }
        .fusion-header-main {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .fusion-title {
          font-size: var(--text-title);
          font-weight: 600;
          color: var(--text-primary);
          letter-spacing: -0.02em;
          line-height: 1.2;
        }
        .fusion-subtitle {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .fusion-header-meta {
          flex-shrink: 0;
        }
        .fusion-count {
          font-size: var(--text-label);
          color: var(--text-muted);
          background: var(--bg-surface-2);
          padding: var(--space-1) var(--space-2);
          border-radius: var(--radius-full);
        }

        /* ── 网格 ── */
        .fusion-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: var(--space-4);
          max-width: 960px;
        }
        @media (max-width: 720px) {
          .fusion-grid {
            grid-template-columns: 1fr;
          }
        }

        /* ── 卡片 ── */
        .fusion-view :global(.fusion-card) {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          padding: var(--space-5);
          cursor: pointer;
          overflow: hidden;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          transition:
            transform var(--duration-base) var(--ease-standard),
            border-color var(--duration-base) var(--ease-standard),
            box-shadow var(--duration-base) var(--ease-standard);
          opacity: 0;
          transform: translateY(12px);
        }
        .fusion-view :global(.fusion-card.is-mounted) {
          opacity: 1;
          transform: translateY(0);
          transition:
            opacity var(--duration-base) var(--ease-standard) var(--delay),
            transform var(--duration-base) var(--ease-standard) var(--delay),
            border-color var(--duration-base) var(--ease-standard),
            box-shadow var(--duration-base) var(--ease-standard);
        }
        .fusion-view :global(.fusion-card:hover) {
          transform: translateY(-2px);
          border-color: var(--border-strong);
          box-shadow: var(--shadow-lg);
        }

        /* 背景光晕(跟随鼠标) */
        .fusion-card-glow {
          position: absolute;
          inset: 0;
          background: radial-gradient(
            600px circle at var(--mouse-x, 50%) var(--mouse-y, 50%),
            var(--card-gradient),
            transparent 40%
          );
          opacity: 0;
          transition: opacity var(--duration-base) var(--ease-standard);
          pointer-events: none;
        }
        .fusion-view :global(.fusion-card:hover) .fusion-card-glow {
          opacity: 1;
        }

        /* 图标 + 名称 */
        .fusion-card-head {
          display: flex;
          align-items: flex-start;
          gap: var(--space-3);
        }
        .fusion-card-icon-wrap {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 44px;
          border-radius: var(--radius-control);
          background: var(--accent-soft);
          color: var(--accent);
          flex-shrink: 0;
          transition: transform var(--duration-base) var(--ease-standard);
        }
        .fusion-view :global(.fusion-card:hover) .fusion-card-icon-wrap {
          transform: scale(1.05);
        }
        .fusion-card-title-group {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex: 1;
          min-width: 0;
          padding-top: var(--space-1);
        }
        .fusion-card-name {
          font-size: var(--text-section);
          font-weight: 600;
          color: var(--text-primary);
          letter-spacing: -0.01em;
        }
        .fusion-card-arrow {
          color: var(--text-muted);
          opacity: 0;
          transform: translateX(-4px);
          transition:
            opacity var(--duration-base) var(--ease-standard),
            transform var(--duration-base) var(--ease-standard);
        }
        .fusion-view :global(.fusion-card:hover) .fusion-card-arrow {
          opacity: 1;
          transform: translateX(0);
          color: var(--accent);
        }

        /* 描述 */
        .fusion-card-desc {
          flex: 1;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          line-height: 1.65;
        }

        /* 标签 */
        .fusion-card-tags {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-1);
        }
        .fusion-tag {
          font-size: var(--text-label);
          color: var(--text-muted);
          background: var(--bg-surface-2);
          padding: 2px var(--space-2);
          border-radius: var(--radius-full);
          transition:
            background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .fusion-view :global(.fusion-card:hover) .fusion-tag {
          background: var(--accent-soft);
          color: var(--accent);
        }

        /* 底部 CTA */
        .fusion-card-footer {
          display: flex;
          justify-content: flex-end;
          padding-top: var(--space-2);
          border-top: 1px solid var(--border-subtle);
        }
        .fusion-card-cta {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-aux);
          font-weight: 500;
          color: var(--accent);
          transition: gap var(--duration-fast) var(--ease-standard);
        }
        .fusion-view :global(.fusion-card:hover) .fusion-card-cta {
          gap: var(--space-2);
        }

        /* 滚动条 */
        .fusion-view::-webkit-scrollbar {
          width: 6px;
        }
        .fusion-view::-webkit-scrollbar-thumb {
          background: var(--bg-surface-3);
          border-radius: 3px;
        }

        /* 动效偏好 */
        @media (prefers-reduced-motion: reduce) {
          .fusion-view :global(.fusion-card),
          .fusion-view :global(.fusion-card.is-mounted) {
            opacity: 1;
            transform: none;
            transition: none;
          }
          .fusion-card-glow,
          .fusion-card-arrow,
          .fusion-card-icon-wrap {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}

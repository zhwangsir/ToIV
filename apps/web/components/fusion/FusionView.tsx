"use client";

import { useEffect, useState } from "react";

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
  /** 旗舰卡:bento 网格中通栏展示(更大的信息容量) */
  flagship?: boolean;
}

const FUSION_APPS: FusionApp[] = [
  {
    target: "studio",
    icon: "clapperboard",
    name: "创作工作室",
    desc: "剧本 → 角色 → 分镜 → 成片:每个分镜独立选择视频生成或图像运镜,一站式创作。",
    tags: ["AI 拆解", "分镜混排", "配音合成"],
    flagship: true,
  },
  {
    target: "avatartalk",
    icon: "user",
    name: "数字人",
    desc: "实时对话数字人:语音交互、口型驱动,面对面交流。",
    tags: ["实时对话", "口型驱动", "WebRTC"],
  },
  {
    target: "dub",
    icon: "dub",
    name: "译制",
    desc: "视频听写、翻译、克隆配音、对口型,一站式多语言译制。",
    tags: ["语音克隆", "多语言", "对口型"],
  },
];

/**
 * 融合应用聚合页(Studio Slate W2 重做):
 * - bento 不对称网格:旗舰「创作工作室」通栏大卡 + 两个半宽卡;
 * - 去掉鼠标跟随光晕与彩色渐变(装饰性动效,违反 Studio Slate 功能动效原则);
 * - 交互只剩功能性:hover 升面 + 箭头揭示,入场错峰(遵守 reduced-motion)。
 */
export function FusionView({ onNavigate }: { onNavigate: (target: string) => void }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="fusion-view">
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

      {/* ── bento 应用卡网格 ── */}
      <div className="fusion-grid">
        {FUSION_APPS.map((app, idx) => (
          <Card
            key={app.name}
            hoverable
            className={`fusion-card${app.flagship ? " is-flagship" : ""}${mounted ? " is-mounted" : ""}`}
            style={{ "--delay": `${idx * 60}ms` } as React.CSSProperties}
            onClick={() => onNavigate(app.target)}
          >
            {/* 图标 + 名称 */}
            <div className="fusion-card-head">
              <div className="fusion-card-icon-wrap">
                <Icon name={app.icon} size={app.flagship ? 26 : 22} />
              </div>
              <div className="fusion-card-title-group">
                <h2 className="fusion-card-name">{app.name}</h2>
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

        /* ── bento 网格:旗舰卡通栏,其余半宽 ── */
        .fusion-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: var(--space-4);
          width: 100%;
          max-width: 1200px;
          margin: 0 auto;
        }
        .fusion-view :global(.fusion-card.is-flagship) {
          grid-column: 1 / -1;
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
          opacity: 0;
          transform: translateY(12px);
          transition:
            opacity var(--duration-base) var(--ease-standard) var(--delay),
            transform var(--duration-base) var(--ease-standard) var(--delay),
            border-color var(--duration-base) var(--ease-standard),
            box-shadow var(--duration-base) var(--ease-standard);
        }
        .fusion-view :global(.fusion-card.is-mounted) {
          opacity: 1;
          transform: translateY(0);
        }
        .fusion-view :global(.fusion-card:hover) {
          transform: translateY(-2px);
          border-color: var(--accent-glow);
          box-shadow: var(--shadow-lg), var(--glass-highlight);
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
        }
        .fusion-view :global(.fusion-card.is-flagship) .fusion-card-icon-wrap {
          width: 52px;
          height: 52px;
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
        .fusion-view :global(.fusion-card.is-flagship) .fusion-card-name {
          font-size: 17px;
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
          color: var(--accent);
          background: var(--accent-soft);
          padding: 2px var(--space-2);
          border-radius: var(--radius-full);
          transition:
            background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .fusion-view :global(.fusion-card:hover) .fusion-tag {
          background: var(--accent-glow);
          box-shadow: var(--accent-glow-shadow);
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
          .fusion-view :global(.fusion-card) {
            opacity: 1;
            transform: none;
            transition: none;
          }
          .fusion-card-arrow {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}

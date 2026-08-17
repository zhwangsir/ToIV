"use client";

import { useEffect, useState } from "react";

import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import "@/app/styles/fusion.css";

interface FusionApp {
  /** 打开目标:视图 key,可带查询串(如漫剧走短剧工作室的 manju 模式) */
  target: string;
  icon: IconName;
  name: string;
  /** 一句话价值描述(bento 卡主文案,数据驱动) */
  desc: string;
  /** 能力标签,用于卡片底部 chips */
  tags: string[];
  /** 旗舰卡:bento 网格中跨两列做 hero(更大的信息容量) */
  flagship?: boolean;
  /** 旗舰卡辅助信息(2026-08-16 视图批 1):流程步骤行,填补 hero 上半部留白 */
  flow?: string[];
}

const FUSION_APPS: FusionApp[] = [
  {
    target: "studio",
    icon: "clapperboard",
    name: "创作工作室",
    desc: "剧本 → 角色 → 分镜 → 成片:每个分镜独立选择视频生成或图像运镜,一站式创作。",
    tags: ["AI 拆解", "分镜混排", "配音合成"],
    flagship: true,
    flow: ["剧本", "角色", "分镜", "成片"],
  },
  {
    target: "avatartalk",
    icon: "user",
    name: "数字人",
    desc: "实时对话数字人 + 人像音频驱动说话视频(LongCat-Avatar),对话与成片双模式。",
    tags: ["实时对话", "说话视频", "口型驱动"],
  },
  {
    target: "dub",
    icon: "dub",
    name: "译制",
    desc: "视频听写、翻译、克隆配音、对口型,一站式多语言译制。",
    tags: ["语音克隆", "多语言", "对口型"],
  },
  {
    target: "imageEdit",
    icon: "crop",
    name: "图片编辑",
    desc: "局部重绘、扩图、高清修复,把生成结果改到位。",
    tags: ["局部重绘", "扩图", "修复"],
  },
  {
    target: "videoEdit",
    icon: "scissors",
    name: "视频剪辑",
    desc: "裁剪、拼接、补帧与运镜,素材到成片的最后一公里。",
    tags: ["裁剪拼接", "补帧", "运镜"],
  },
];

/**
 * 融合应用聚合页(批 3 bento 化):
 * - bento 网格:首卡「创作工作室」跨两列做 hero,其余能力一张大卡
 *   (图标 + 名称 + 一句话价值描述 + 进入箭头),内容全部数据驱动;
 * - 交互:hover surface 升档 + 箭头位移微动效(≤200ms),入场错峰;
 * - 样式全部在 app/styles/fusion.css(styled-jsx 已清零)。
 */
export function FusionView({ onNavigate }: { onNavigate: (target: string) => void }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="fusion-view">
      {/* ── 头部:统一 PageHeader(Atelier masthead:kicker + Fraunces 标题 + 编辑双线)── */}
      <PageHeader
        className="fusion-header"
        kicker="FUSION ATELIER"
        title="融合应用"
        desc="多能力组合的创作入口:剧本、数字人、译制、图片与视频,一站式完成"
        actions={<span className="fusion-count">{FUSION_APPS.length} 个应用</span>}
      />

      {/* ── bento 应用卡网格 ── */}
      <div className="fusion-grid">
        {FUSION_APPS.map((app, idx) => (
          <Card
            key={app.name}
            className={`at-card at-card--lift fusion-card${app.flagship ? " is-flagship" : ""}${mounted ? " is-mounted" : ""}`}
            style={{ "--delay": `${idx * 60}ms` } as React.CSSProperties}
            onClick={() => onNavigate(app.target)}
            /* 键盘可操作(UI-B:focus 态补齐的前提):div 卡片获得焦点组语义,
               Enter/Space 触发与点击一致的跳转;样式侧 focus-visible 与 hover 同档(fusion.css) */
            tabIndex={0}
            role="button"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onNavigate(app.target);
              }
            }}
          >
            {/* 旗舰卡装饰:右侧细线水印图标,填补 hero 右半留白(纯装饰,不响应事件) */}
            {app.flagship && (
              <div className="fusion-card-deco" aria-hidden="true">
                <Icon name={app.icon} size={168} strokeWidth={0.5} />
              </div>
            )}

            {/* 图标 + 名称 + 旗舰徽标 + 进入箭头 */}
            <div className="fusion-card-head">
              <div className="fusion-card-icon-wrap">
                <Icon name={app.icon} size={app.flagship ? 30 : 24} />
              </div>
              <div className="fusion-card-title-group">
                <h2 className="fusion-card-name">{app.name}</h2>
                {app.flagship && <span className="at-badge at-badge--accent fusion-card-badge">旗舰</span>}
                <div className="fusion-card-arrow" aria-hidden="true">
                  <Icon name="chevron-right" size={16} />
                </div>
              </div>
            </div>

            {/* 一句话价值描述 */}
            <p className="fusion-card-desc">{app.desc}</p>

            {/* 旗舰卡辅助信息:流程步骤行(2026-08-16 视图批 1,填补 hero 上半部留白) */}
            {app.flow && (
              <ol className="fusion-card-flow" aria-label={`${app.name}流程`}>
                {app.flow.map((step, i) => (
                  <li key={step} className="fusion-card-flow-step">
                    <span className="fusion-card-flow-num">{String(i + 1).padStart(2, "0")}</span>
                    {step}
                  </li>
                ))}
              </ol>
            )}

            {/* 能力标签(编辑徽章 hairline 语言) */}
            <div className="fusion-card-tags">
              {app.tags.map((tag) => (
                <span key={tag} className="at-badge fusion-tag">
                  {tag}
                </span>
              ))}
            </div>

            {/* 底部操作区(墨丸主钮) */}
            <div className="fusion-card-footer">
              <span className="at-btn at-btn--primary fusion-card-cta">
                进入应用
                <Icon name="chevron-right" size={14} />
              </span>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

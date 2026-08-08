"use client";

import { useEffect, useState } from "react";

import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";

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
            {/* 图标 + 名称 + 进入箭头 */}
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

            {/* 一句话价值描述 */}
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
    </div>
  );
}

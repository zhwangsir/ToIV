"use client";

import { Icon, type IconName } from "@/components/ui/Icon";
import { Empty } from "@/components/ui/Empty";
import "@/app/styles/fusion.css";

interface FusionApp {
  /** 打开目标:视图 key,可带查询串(如漫剧走短剧工作室的 manju 模式) */
  target: string;
  icon: IconName;
  name: string;
  /** 一句话价值描述(列表行副文案,数据驱动) */
  desc: string;
  /** 能力标签,行尾「·」分隔弱展示 */
  tags: string[];
}

const FUSION_APPS: FusionApp[] = [
  {
    target: "studio",
    icon: "clapperboard",
    name: "创作工作室",
    desc: "剧本 → 角色 → 分镜 → 成片:每个分镜独立选择视频生成或图像运镜,一站式创作。",
    tags: ["AI 拆解", "分镜混排", "配音合成"],
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
 * 融合应用聚合页(Studio Console W3,2026-09-02):
 * bento 卡网格(渐变洗光/水印大图标/旗舰徽标/墨丸 CTA/错峰入场)退役,
 * 改 hairline 分行紧凑列表——图标 + 名称/描述 + 标签 + 进入箭头,原生 button 全键盘可达。
 * 样式全部在 app/styles/fusion.css。
 */
export function FusionView({ onNavigate }: { onNavigate: (target: string) => void }) {
  return (
    <div className="fusion-view">
      {FUSION_APPS.length === 0 ? (
        /* 空态(2026-09-04 W2B):接 at-empty--section;当前列表为静态数据,此分支是兜底 */
        <Empty size="section" icon="package" title="暂无融合应用" desc="融合应用上架后会出现在这里" />
      ) : (
      <ul className="fusion-list">
        {FUSION_APPS.map((app) => (
          <li key={app.name}>
            <button
              type="button"
              className="fusion-row"
              onClick={() => onNavigate(app.target)}
            >
              <span className="fusion-row-icon" aria-hidden="true">
                <Icon name={app.icon} size={17} strokeWidth={1.7} />
              </span>
              <span className="fusion-row-main">
                <span className="fusion-row-name">{app.name}</span>
                <span className="fusion-row-desc">{app.desc}</span>
              </span>
              <span className="fusion-row-tags" aria-hidden="true">
                {app.tags.join(" · ")}
              </span>
              <span className="fusion-row-arrow" aria-hidden="true">
                <Icon name="chevron-right" size={15} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      )}
    </div>
  );
}

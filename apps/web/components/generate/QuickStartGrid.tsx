"use client";

import { Icon, type IconName } from "@/components/ui/Icon";
import type { EngineInfo, EngineKind } from "@/lib/engines";

/** 快速开始卡定义:静态策划的推荐起点(写死,不调 API),engineId 指向注册表引擎。 */
export interface QuickStartDef {
  engineId: string;
  title: string;
  desc: string;
  icon: IconName;
}

/**
 * 空态「快速开始」卡策划(T3,2026-08-17):每个 kind 一组推荐起点。
 * 点击 = 选中对应引擎 + 聚焦提示词框(由 GenerateView.onQuickStart 承载)。
 * 可用性动态判定:引擎不在当前可见列表(如 R18 上下文过滤)→ 卡不渲染;
 * 在列表但不可用 → 卡禁用并透出原因。
 */
export const QUICK_START_DEFS: Record<EngineKind, QuickStartDef[]> = {
  video: [
    { engineId: "h3-t2v", title: "MiniMax H3", desc: "音画直出,剧情连续性强", icon: "zap" },
    { engineId: "longcat-t2v", title: "LongCat 长镜头", desc: "单镜头最长 60s 连贯画面", icon: "video" },
  ],
  image: [
    { engineId: "txt2img", title: "文生图", desc: "一句话出图,支持风格预设", icon: "image" },
    { engineId: "img2img", title: "图生图", desc: "上传参考图,按强度重绘", icon: "brush" },
  ],
  audio: [
    { engineId: "ace-music", title: "ACE 文生音乐", desc: "风格标签加歌词,最快 30s 出样", icon: "audio" },
  ],
};

interface QuickStartGridProps {
  /** 当前板块 kind(决定渲染哪组策划卡)。 */
  kind: EngineKind;
  /** 当前 kind 全部引擎(可用性判定数据源;null = 列表加载中,整区不渲染避免闪现)。 */
  engines: EngineInfo[] | null;
  /** 点击卡:选中对应引擎(引擎 id 透传给 GenerateView)。 */
  onPick: (engineId: string) => void;
}

/** 快速开始卡栅格:无 hooks,单测可直接调用取元素树做点击回调断言。 */
export function QuickStartGrid({ kind, engines, onPick }: QuickStartGridProps) {
  if (!engines) return null;
  const cards = QUICK_START_DEFS[kind]
    .map((def) => ({ def, engine: engines.find((e) => e.id === def.engineId) }))
    .filter((x): x is { def: QuickStartDef; engine: EngineInfo } => x.engine !== undefined);
  if (cards.length === 0) return null;
  return (
    <div className="quick-start">
      <h3 className="quick-start-title">快速开始</h3>
      <div className="quick-start-grid">
        {cards.map(({ def, engine }) => (
          <button
            key={def.engineId}
            type="button"
            className="quick-start-card at-card at-card--lift"
            disabled={!engine.available}
            title={engine.available ? def.desc : `当前不可用:${engine.unavailable_reason ?? "未知原因"}`}
            onClick={() => onPick(def.engineId)}
          >
            <span className="quick-start-icon">
              <Icon name={def.icon} size={16} />
            </span>
            <span className="quick-start-name">{def.title}</span>
            <span className="quick-start-desc">{def.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

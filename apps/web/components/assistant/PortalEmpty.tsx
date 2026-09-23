"use client";

/**
 * 助手门户空态模块(2026-09-22 A3 组件工程化;2026-09-23 P0 对话 chips;
 * 2026-09-23 cinematic 空态):
 * 自 AssistantView.tsx 拆出——门户入口数据(SKILL_ENTRIES/OFFLINE_ENTRIES/filterPortalEntries)
 * 与空态组件(页形态门户 PortalEmpty / popup 极简空态 PopupEmpty)。
 * P0: SKILL_ENTRIES 为 Composer「@」技能面板对话内 prompt chips(门户在线空态不再渲染场景宫格);
 * 离线 OFFLINE_ENTRIES 仍为工作台导航(离线降级 OK)。
 * 在线空态 = 居中问候(Fraunces) + portal composer + ambient 辉光/入场动效;
 * 最近作品轨组件文件保留供他处引用；门户在线空态不再挂载该轨。
 */
import { type ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

// ───── @ 技能面板入口数据(2026-09-23 P0:对话内 prompt chips;非门户宫格) ─────

export interface PortalEntry {
  view: string;
  icon: IconName;
  label: string;
  desc: string;
  /** 对话内预填句;有则点击填 composer 留在智能体(生成类默认) */
  prompt?: string;
  /** 浏览类仍可 goView(如作品库);与 prompt 互斥优先 navigate */
  navigate?: boolean;
  /** r18 = 仅 R18 模式渲染(drama 视图受 page.tsx 全局门控);sfwOnly = 仅 SFW 模式补位 */
  r18?: boolean;
  sfwOnly?: boolean;
}

/** @ 技能面板 = 对话内 prompt chips(可执行意图,非工作台跳转;门户在线空态不渲染此列表)。 */
export const SKILL_ENTRIES: PortalEntry[] = [
  {
    view: "drama",
    icon: "clapperboard",
    label: "短剧",
    desc: "分镜工具做短剧",
    prompt: "帮我用分镜工具做短剧：",
    r18: true,
  },
  {
    view: "image",
    icon: "image",
    label: "图像",
    desc: "文生图 / 图生图",
    prompt: "帮我用市场应用或内置能力生成一张图：",
  },
  {
    view: "video",
    icon: "video",
    label: "视频",
    desc: "图生 / 文生视频",
    prompt: "帮我用市场应用做一个图生/文生视频：",
  },
  {
    view: "audio",
    icon: "audio",
    label: "音频",
    desc: "音乐 / 配音",
    prompt: "帮我生成一段音乐/配音：",
  },
  {
    view: "avatartalk",
    icon: "user",
    label: "数字人",
    desc: "照片说话",
    prompt: "帮我做一段照片说话的数字人视频：",
  },
  {
    view: "library",
    icon: "library",
    label: "作品库",
    desc: "全部生成产物",
    navigate: true,
  },
];

/** W5 助手离线降级(2026-08-31):对话不可用时,门户展开全量工作台导航(替代对话框)。
 *  覆盖 L1 工作台层全部高频页,顺序与导航分组一致;drama 走 studio 直达(旧管线已退役)。 */
export const OFFLINE_ENTRIES: PortalEntry[] = [
  { view: "image", icon: "image", label: "图像", desc: "文生图 · 图生图" },
  { view: "video", icon: "video", label: "视频", desc: "H3 · LongCat" },
  { view: "audio", icon: "audio", label: "音频", desc: "音乐 · 配音" },
  { view: "studio", icon: "clapperboard", label: "工作室", desc: "短剧全流程" },
  { view: "avatartalk", icon: "user", label: "数字人", desc: "说话视频" },
  { view: "dub", icon: "mic", label: "译制", desc: "听写 · 配音" },
  { view: "imageEdit", icon: "palette", label: "图片编辑", desc: "重绘 · 扩图" },
  { view: "videoEdit", icon: "film", label: "视频剪辑", desc: "裁剪 · 补帧" },
  { view: "canvas", icon: "grid", label: "画布", desc: "专家工作流" },
  { view: "library", icon: "library", label: "作品库", desc: "全部产物" },
  { view: "entities", icon: "users", label: "主体库", desc: "角色 · 场景" },
  { view: "market", icon: "package", label: "市场", desc: "应用 · 技能" },
];

/** 按 R18 模式过滤门户入口(纯函数,单测锚点)。 */
export function filterPortalEntries(
  entries: readonly PortalEntry[],
  r18: boolean,
): PortalEntry[] {
  return entries.filter((e) => (e.r18 ? r18 : true) && (e.sfwOnly ? !r18 : true));
}

/** 门户问候语按时段切换(纯展示,无业务含义)。 */
export function portalGreeting(hour: number): string {
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export interface PortalEmptyProps {
  /** W5:探活失败即离线——对话框让位「离线提示 + 全量工作台导航」 */
  llmOffline: boolean;
  /** 门户问候语(主壳挂载时按时段取一次,跨空态往返保持稳定) */
  greeting: string;
  /** 离线工作台 chip 导航(在线 cinematic 空态不用) */
  goView: (view: string) => void;
  /** 门户 C 位输入框槽位(主壳 renderComposer(true) 注入,与底部输入框同源) */
  composer: ReactNode;
}

/* 门户空态(2026-09-23 cinematic):Fraunces 问候 + portal composer + ambient;
   场景宫格与最近作品轨已撤离门户(技能 chips 仅 Composer @ 面板);
   离线仍保留 alert + OFFLINE_ENTRIES 工作台 chips */
export function PortalEmpty({
  llmOffline,
  greeting,
  goView,
  composer,
}: PortalEmptyProps) {
  return (
    <div className="av-empty av-portal av-portal--console av-portal--cinematic">
      <div className="av-portal-ambient" aria-hidden />
      {llmOffline ? (
        /* W5 助手离线降级:对话框让位「离线提示 + 全量工作台导航」 */
        <>
          <div className="av-offline" role="alert">
            <Icon name="warning" size={16} strokeWidth={1.8} />
            <span className="av-offline-title">助手暂时离线</span>
            <span className="av-offline-desc">对话能力暂不可用,可直接使用下方工作台继续创作。</span>
          </div>
          <div className="av-scene-row av-scene-row--offline">
            {OFFLINE_ENTRIES.map((c) => (
              <button
                key={c.view}
                type="button"
                className="av-scene-chip"
                title={c.desc}
                onClick={() => goView(c.view)}
              >
                <Icon name={c.icon} size={14} strokeWidth={1.8} />
                <span>{c.label}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="av-portal-hero av-portal-in">
            <h2 className="av-portal-greeting">
              {greeting},想创作点什么?
            </h2>
            <div className="av-portal-hero-rule" aria-hidden />
          </div>
          <div className="av-portal-composer av-portal-in av-portal-in--late">{composer}</div>
        </>
      )}
    </div>
  );
}

/* 弹窗极简空态:标题 + 操作提示,输入框由底部 renderComposer 承担
   (Studio Console v1 起拉丁 kicker 铭牌退役,用户:文字太多) */
export function PopupEmpty({ isMobileMq }: { isMobileMq: boolean }) {
  return (
    <div className="av-empty av-popup-empty">
      <div className="av-empty-title">有什么可以帮你?</div>
      <div className="av-empty-desc">输入内容开始对话 · Esc 或点击遮罩关闭</div>
      {/* 快捷键提示仅桌面端:移动端无 Shift+Enter 物理键,按断点隐藏(A0) */}
      {!isMobileMq && (
        <div className="av-popup-empty-hint">Shift+Enter 随时唤起/关闭</div>
      )}
    </div>
  );
}

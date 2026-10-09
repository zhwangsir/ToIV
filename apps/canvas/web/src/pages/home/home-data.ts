import {
    AudioLines,
    Bot,
    Box,
    Brush,
    Clapperboard,
    Film,
    History,
    Image,
    Layers3,
    Library,
    ListChecks,
    Maximize2,
    Mic,
    Package,
    Palette,
    Pencil,
    Play,
    Scissors,
    Sparkles,
    Store,
    User,
    Video,
    type LucideIcon,
} from "lucide-react";

import { HOME_INTENT_ENTRIES, type HomeIntentMarketLink } from "@/services/toiv/local-capability-surface";

/** 首页核心模块卡（画布 / ToIV 路由）；意图 keepers 另见 homeIntentBarItems。 */
export const beefTVCapabilityItems = [
    { id: "canvas", label: "自由画布", detail: "组织镜头与素材", to: "/canvas?mode=new", icon: Layers3, disabled: false, external: false },
    { id: "video", label: "视频生成", detail: "在画布中创建视频节点", to: "/canvas?mode=new&add=video", icon: Video, disabled: false, external: false },
    { id: "image", label: "图片生成", detail: "在画布中创建图片节点", to: "/canvas?mode=new&add=image", icon: Image, disabled: false, external: false },
    // Audio generation is a creation entry, not an asset filter. Start a
    // local canvas and let the canvas insert the correctly configured node.
    { id: "audio", label: "音频生成", detail: "配音与声音素材", to: "/canvas?mode=new&add=audio", icon: AudioLines, disabled: false, external: false },
    // ToIV 模块：SPA 原生路由（零整页跳转；旧 classic 外链已退役）
    { id: "drama", label: "短剧工作台", detail: "分镜 · 设定卡 · 成片", to: "/toiv/drama", icon: Clapperboard, disabled: false, external: false },
    { id: "agent", label: "智能体对话", detail: "对话驱动创作", to: "/toiv/agent", icon: Bot, disabled: false, external: false },
    { id: "market", label: "工具箱", detail: "本地·云应用一站浏览（/toiv/market）", to: "/toiv/market", icon: Store, disabled: false, external: false },
    { id: "library", label: "作品库", detail: "成片与分镜作品", to: "/library?source=works", icon: Library, disabled: false, external: false },
    { id: "tasks", label: "任务中心", detail: "作业进度统一查看", to: "/toiv/tasks", icon: ListChecks, disabled: false, external: false },
] as const;

/** intentMap icon → lucide（BeefTV 首页意图条）。 */
const INTENT_ICONS: Record<string, LucideIcon> = {
    outfit: Layers3,
    bg: Image,
    i2v: Video,
    t2v: Film,
    lipsync: Mic,
    avatar: User,
    voice: AudioLines,
    cutout: Scissors,
    upscale: Maximize2,
    vfi: Play,
    line: Pencil,
    vace: Clapperboard,
    music: AudioLines,
    t2i: Sparkles,
    restore: History,
    inpaint: Brush,
    portrait: User,
    product: Package,
    edit: Palette,
    style: Brush,
    "3d": Box,
};

export type HomeIntentBarItem = HomeIntentMarketLink & { icon: LucideIcon };

/** 首页意图条：完整 keepers → `/toiv/market?app=`（与 intentMap / HOME_INTENT_ENTRIES 对齐）。 */
export const homeIntentBarItems: readonly HomeIntentBarItem[] = HOME_INTENT_ENTRIES.map((entry) => ({
    ...entry,
    icon: INTENT_ICONS[entry.id] ?? Store,
}));

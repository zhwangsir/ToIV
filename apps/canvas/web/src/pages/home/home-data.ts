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

/** W1 capability 单行：创作台优先；画布降专家次入口。意图墙不得铺首页。 */
export const beefTVCapabilityItems = [
    { id: "agent", label: "创作台", detail: "对话驱动创作（默认主意图）", to: "/create", icon: Bot, disabled: false, external: false },
    { id: "drama", label: "短剧工作台", detail: "分镜 · 设定卡 · 成片", to: "/toiv/drama", icon: Clapperboard, disabled: false, external: false },
    { id: "market", label: "工具箱", detail: "本地与云端应用一站浏览", to: "/toiv/market", icon: Store, disabled: false, external: false },
    { id: "tasks", label: "任务中心", detail: "作业进度统一查看", to: "/tasks", icon: ListChecks, disabled: false, external: false },
    { id: "library", label: "作品库", detail: "成片与分镜作品", to: "/library?source=works", icon: Library, disabled: false, external: false },
    { id: "canvas", label: "自由画布", detail: "专家面 · 组织镜头与素材", to: "/canvas?mode=new", icon: Layers3, disabled: false, external: false },
    { id: "video", label: "视频生成", detail: "在画布中创建视频节点", to: "/canvas?mode=new&add=video", icon: Video, disabled: false, external: false },
    { id: "image", label: "图片生成", detail: "在画布中创建图片节点", to: "/canvas?mode=new&add=image", icon: Image, disabled: false, external: false },
    { id: "audio", label: "音频生成", detail: "配音与声音素材", to: "/canvas?mode=new&add=audio", icon: AudioLines, disabled: false, external: false },
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

/** 意图条 export：BF1 挂工具台 ToolsIntentGrid；BF0 首页禁止整墙铺 homeIntentBarItems。 */
export const homeIntentBarItems: readonly HomeIntentBarItem[] = HOME_INTENT_ENTRIES.map((entry) => ({
    ...entry,
    icon: INTENT_ICONS[entry.id] ?? Store,
}));

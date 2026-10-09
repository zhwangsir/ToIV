import { AudioLines, Bot, Clapperboard, Image, Layers3, Library, ListChecks, Store, Video } from "lucide-react";

import { HOME_INTENT_MARKET_LINKS } from "@/services/toiv/local-capability-surface";

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
    { id: "market", label: "应用市场", detail: "创作应用一站浏览", to: "/toiv/market", icon: Store, disabled: false, external: false },
    { id: "library", label: "作品库", detail: "成片与分镜作品", to: "/toiv/library", icon: Library, disabled: false, external: false },
    { id: "tasks", label: "任务中心", detail: "作业进度统一查看", to: "/toiv/tasks", icon: ListChecks, disabled: false, external: false },
    // 意图条：深链市场 keeper（不再落空壳 Video+Audio / Image+Text）
    {
        id: "lipsync",
        label: HOME_INTENT_MARKET_LINKS.lipsync.label,
        detail: HOME_INTENT_MARKET_LINKS.lipsync.detail,
        to: HOME_INTENT_MARKET_LINKS.lipsync.to,
        icon: AudioLines,
        disabled: false,
        external: false,
    },
    {
        id: "inpaint",
        label: HOME_INTENT_MARKET_LINKS.inpaint.label,
        detail: HOME_INTENT_MARKET_LINKS.inpaint.detail,
        to: HOME_INTENT_MARKET_LINKS.inpaint.to,
        icon: Image,
        disabled: false,
        external: false,
    },
    {
        id: "dub",
        label: HOME_INTENT_MARKET_LINKS.dub.label,
        detail: HOME_INTENT_MARKET_LINKS.dub.detail,
        to: HOME_INTENT_MARKET_LINKS.dub.to,
        icon: AudioLines,
        disabled: false,
        external: false,
    },
] as const;

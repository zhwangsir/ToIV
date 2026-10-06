import { AudioLines, Bot, Clapperboard, Image, Layers3, Video } from "lucide-react";

export const beefTVCapabilityItems = [
    { id: "canvas", label: "自由画布", detail: "组织镜头与素材", to: "/canvas?mode=new", icon: Layers3, disabled: false, external: false },
    { id: "video", label: "视频生成", detail: "在画布中创建视频节点", to: "/canvas?mode=new&add=video", icon: Video, disabled: false, external: false },
    { id: "image", label: "图片生成", detail: "在画布中创建图片节点", to: "/canvas?mode=new&add=image", icon: Image, disabled: false, external: false },
    // Audio generation is a creation entry, not an asset filter. Start a
    // local canvas and let the canvas insert the correctly configured node.
    { id: "audio", label: "音频生成", detail: "配音与声音素材", to: "/canvas?mode=new&add=audio", icon: AudioLines, disabled: false, external: false },
    // ToIV 本土化(2026-10-06):两张占位卡换成 ToIV 实模块,external=整页跳转到旧版视图
    { id: "drama", label: "短剧工作台", detail: "分镜 · 设定卡 · 成片", to: "/?view=studio&classic=1", icon: Clapperboard, disabled: false, external: true },
    { id: "agent", label: "智能体对话", detail: "对话驱动创作", to: "/?view=home&classic=1", icon: Bot, disabled: false, external: true },
    { id: "lipsync", label: "对口型(模板)", detail: "视频+音频组合节点", to: "/canvas?mode=new&add=lipsync", icon: AudioLines, disabled: false, external: false },
] as const;

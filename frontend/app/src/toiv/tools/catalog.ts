export type PrimeToolId = "t2i" | "t2v";

export type PrimeTool = {
    id: string;
    title: string;
    blurb: string;
    kind: "image" | "video" | "tool";
    available: boolean;
};

export const PRIME_TOOLS: readonly PrimeTool[] = [
    { id: "t2i", title: "文生图", blurb: "一句提示词出静帧，支持 1:1 / 16:9 / 9:16。", kind: "image", available: true },
    { id: "t2v", title: "文生视频", blurb: "短镜头直出，可选 3 秒或 6 秒。", kind: "video", available: true },
    { id: "i2i", title: "图生图", blurb: "以现有画面为底图重绘风格与细节。", kind: "image", available: false },
    { id: "i2v", title: "图生视频", blurb: "让一张定稿静帧动起来。", kind: "video", available: false },
    { id: "v2v", title: "视频生视频", blurb: "重绘、延长或补帧现有镜头。", kind: "video", available: false },
    { id: "commerce", title: "电商工具", blurb: "商品图与短视频批量产出。", kind: "tool", available: false },
];

const ALIASES: Record<string, PrimeToolId> = {
    image: "t2i",
    t2i: "t2i",
    video: "t2v",
    t2v: "t2v",
};

export function resolveToolId(raw: string | undefined): PrimeToolId | undefined {
    return raw ? ALIASES[raw] : undefined;
}

export function findTool(id: string | undefined): PrimeTool | undefined {
    return PRIME_TOOLS.find((tool) => tool.id === id);
}

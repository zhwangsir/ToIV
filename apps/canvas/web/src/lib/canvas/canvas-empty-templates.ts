/**
 * Wave P3.5：空画布模板入口（≥3）与一键整理文案。
 * 模板只描述入口语义；真正落节点由画布页 handlers 执行。
 */
export type CanvasEmptyTemplateId = "short-drama" | "image-to-video" | "blank";

export type CanvasEmptyTemplate = {
    id: CanvasEmptyTemplateId;
    label: string;
    description: string;
    action: string;
};

/** 产品面固定三模板（短剧分镜条 / 图生视频 / 空白）。 */
export const CANVAS_EMPTY_TEMPLATES: readonly CanvasEmptyTemplate[] = [
    {
        id: "short-drama",
        label: "短剧分镜条",
        description: "画风 + 故事 + 分镜脚本骨架，对齐短剧主路。",
        action: "从分镜模板开始",
    },
    {
        id: "image-to-video",
        label: "图生视频",
        description: "一张参考图接到视频节点，适合单镜试生成。",
        action: "创建图生视频",
    },
    {
        id: "blank",
        label: "空白画布",
        description: "不预设流程，自由添加文本、图像和视频。",
        action: "从空白开始",
    },
] as const;

export const CANVAS_TIDY_LAYOUT_LABEL = "一键整理";

export function canvasEmptyTemplateById(id: CanvasEmptyTemplateId): CanvasEmptyTemplate {
    const hit = CANVAS_EMPTY_TEMPLATES.find((t) => t.id === id);
    if (!hit) throw new Error(`unknown empty template: ${id}`);
    return hit;
}

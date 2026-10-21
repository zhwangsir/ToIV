/**
 * Wave P3.6：画布端口悬停业务名（禁止裸 in_0 / :8264 作为产品面提示）。
 */
import { CanvasNodeType, type CanvasNodeTypeId } from "@/types/canvas";

export type CanvasPortSide = "source" | "target" | "left" | "right";

/** 通用连接点业务名。 */
export function canvasPortBusinessLabel(
    side: CanvasPortSide,
    nodeType?: CanvasNodeTypeId | string | null,
    handleId?: string | null,
): string {
    const hid = String(handleId || "").toLowerCase();
    if (hid.includes("start") || hid.includes("first") || hid === "in_0" || hid.includes("keyframe-first")) return "首帧";
    if (hid.includes("end") || hid.includes("last") || hid === "in_1" || hid.includes("keyframe-last")) return "尾帧";
    if (hid.includes("audio") || hid.includes("voice")) return side === "source" || side === "right" ? "音频输出" : "音频输入";
    if (hid.includes("ref") || hid.includes("reference") || hid.includes("context")) return "参考";
    if (hid.includes("storyboard")) return "分镜";

    const type = String(nodeType || "");
    const isOut = side === "source" || side === "right";
    if (type === CanvasNodeType.Image || type === "image") return isOut ? "图像输出" : "图像输入";
    if (type === CanvasNodeType.Video || type === "video") return isOut ? "视频输出" : "参考/首帧";
    if (type === CanvasNodeType.Audio || type === "audio") return isOut ? "音频输出" : "音频输入";
    if (type === CanvasNodeType.Text || type === "text") return isOut ? "文本输出" : "文本输入";
    if (type === CanvasNodeType.Script || type === "script") return isOut ? "分镜输出" : "设定输入";
    return isOut ? "输出" : "输入";
}

export function canvasPortHoverTitle(
    side: CanvasPortSide,
    nodeType?: CanvasNodeTypeId | string | null,
    handleId?: string | null,
): string {
    return `${canvasPortBusinessLabel(side, nodeType, handleId)}连接点`;
}

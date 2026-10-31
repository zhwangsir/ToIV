/**
 * Wave P3.5：图生视频空画布模板（图像 → 视频，默认绑短剧主路 H3）。
 */
import { nanoid } from "nanoid";

import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { defaultLocalVideoPreset } from "@/services/toiv/local-capability-surface";
import { CanvasNodeType, type CanvasConnection, type Position } from "@/types/canvas";

export function createImageToVideoTemplate(center: Position) {
    const preset = defaultLocalVideoPreset();
    const imageNode = createCanvasNode(CanvasNodeType.Image, { x: center.x - 280, y: center.y }, {
        status: "idle",
        workflowTitle: "参考图",
    });
    imageNode.title = "参考图";
    imageNode.width = 320;
    imageNode.height = 320;

    const videoNode = createCanvasNode(CanvasNodeType.Video, { x: center.x + 220, y: center.y }, {
        status: "idle",
        model: preset.modelRef,
        workflowTitle: "图生视频",
    });
    videoNode.title = "视频 · 短剧主路";
    videoNode.width = 360;
    videoNode.height = 240;

    const connections: CanvasConnection[] = [
        { id: nanoid(), fromNodeId: imageNode.id, toNodeId: videoNode.id },
    ];
    return { nodes: [imageNode, videoNode], connections, imageNodeId: imageNode.id, videoNodeId: videoNode.id };
}

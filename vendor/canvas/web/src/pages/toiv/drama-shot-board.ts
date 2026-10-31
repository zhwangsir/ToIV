/**
 * Wave P3 / D2-A：短剧镜头「列表 ↔ 看板」投影辅助（同源字段，非第二真源）。
 * 看板=生成进度分列（AIComicBuilder 低成本档）；竖排=文→帧→视频流水线投影（LocalMiniDrama）。
 */
import type { ToivDramaShot } from "@/services/toiv/client";

export type DramaShotViewMode = "list" | "board" | "pipeline";

export type DramaBoardColumnId =
    | "pending"
    | "generating"
    | "rendered"
    | "audio"
    | "done"
    | "failed";

export type DramaBoardColumn = {
    id: DramaBoardColumnId;
    label: string;
};

export const DRAMA_BOARD_COLUMNS: readonly DramaBoardColumn[] = [
    { id: "pending", label: "待生成" },
    { id: "generating", label: "生成中" },
    { id: "rendered", label: "已出视频" },
    { id: "audio", label: "配音/口型" },
    { id: "done", label: "完成" },
    { id: "failed", label: "失败" },
] as const;

const FAILED = new Set(["error", "failed"]);
const GENERATING = new Set(["rendering", "generating", "queued"]);
const DONE = new Set(["done"]);
const AUDIO = new Set(["voiced", "lipsynced", "lipsyncing"]);
const RENDERED = new Set(["rendered"]);

/** 按镜头进度落入看板列（投影规则；业务数据仍以 shots[] 为准）。 */
export function dramaShotBoardColumn(shot: Pick<ToivDramaShot, "status" | "voice_url" | "final_clip_url">): DramaBoardColumnId {
    const status = String(shot.status || "").trim();
    if (FAILED.has(status)) return "failed";
    if (DONE.has(status) || Boolean(shot.final_clip_url)) return "done";
    if (GENERATING.has(status)) return "generating";
    if (AUDIO.has(status) || Boolean(shot.voice_url)) return "audio";
    if (RENDERED.has(status)) return "rendered";
    return "pending";
}

export function groupShotsByBoardColumn<T extends Pick<ToivDramaShot, "id" | "status" | "voice_url" | "final_clip_url">>(
    shots: readonly T[],
): Record<DramaBoardColumnId, T[]> {
    const out: Record<DramaBoardColumnId, T[]> = {
        pending: [],
        generating: [],
        rendered: [],
        audio: [],
        done: [],
        failed: [],
    };
    for (const shot of shots) {
        out[dramaShotBoardColumn(shot)].push(shot);
    }
    return out;
}

/** 同源投影字段（列表/看板/检视器共用键名，便于验收）。 */
export type DramaShotProjectionFields = {
    shotId: string;
    idx: string | number;
    status: string;
    prompt?: string;
    scene?: string;
    dialogue?: string;
    imageUrl?: string;
    videoUrl?: string;
    voiceUrl?: string;
    finalClipUrl?: string;
    pipeline?: string;
};

export function toDramaShotProjection(
    shot: ToivDramaShot,
    pipeline?: string,
): DramaShotProjectionFields {
    return {
        shotId: shot.id,
        idx: shot.idx,
        status: shot.status,
        prompt: shot.prompt,
        scene: shot.scene,
        dialogue: shot.dialogue,
        imageUrl: shot.image_url,
        videoUrl: shot.video_url,
        voiceUrl: shot.voice_url,
        finalClipUrl: shot.final_clip_url,
        pipeline,
    };
}

/** Wave P3 残余：竖排流水线阶段（同源投影，非第二真源）。 */
export type DramaPipelineStageId = "text" | "frame" | "video" | "voice" | "lipsync";

export type DramaPipelineStage = {
    id: DramaPipelineStageId;
    label: string;
};

export const DRAMA_PIPELINE_STAGES: readonly DramaPipelineStage[] = [
    { id: "text", label: "文本" },
    { id: "frame", label: "首/尾帧" },
    { id: "video", label: "视频" },
    { id: "voice", label: "配音" },
    { id: "lipsync", label: "口型" },
] as const;

export type DramaPipelineCellState = "empty" | "ready" | "busy" | "failed" | "skipped";

type PipelineShotPick = Pick<
    ToivDramaShot,
    "status" | "prompt" | "scene" | "dialogue" | "image_url" | "video_url" | "voice_url" | "final_clip_url"
>;

function shotHasDialogueText(dialogue?: string | null): boolean {
    return Boolean(String(dialogue || "").trim());
}

/** 竖排单格状态：列表/看板共用 shots[] 推演，禁止双写。 */
export function dramaPipelineCellState(shot: PipelineShotPick, stage: DramaPipelineStageId): DramaPipelineCellState {
    const status = String(shot.status || "").trim();
    if (FAILED.has(status) && (stage === "video" || stage === "frame" || stage === "text")) return "failed";
    if (GENERATING.has(status) && (stage === "video" || stage === "frame")) return "busy";
    if (status === "lipsyncing" && stage === "lipsync") return "busy";

    switch (stage) {
        case "text": {
            const hasText = Boolean(String(shot.prompt || shot.scene || shot.dialogue || "").trim());
            return hasText ? "ready" : "empty";
        }
        case "frame":
            return shot.image_url ? "ready" : GENERATING.has(status) ? "busy" : "empty";
        case "video":
            if (shot.video_url || RENDERED.has(status) || DONE.has(status) || Boolean(shot.final_clip_url)) return "ready";
            if (GENERATING.has(status)) return "busy";
            if (FAILED.has(status)) return "failed";
            return "empty";
        case "voice": {
            if (!shotHasDialogueText(shot.dialogue)) return "skipped";
            if (shot.voice_url || AUDIO.has(status) || DONE.has(status)) return "ready";
            if (status === "rendering" || status === "queued") return "empty";
            return shot.video_url || RENDERED.has(status) ? "empty" : "empty";
        }
        case "lipsync": {
            if (!shotHasDialogueText(shot.dialogue)) return "skipped";
            if (status === "lipsynced" || Boolean(shot.final_clip_url) || DONE.has(status)) return "ready";
            if (status === "lipsyncing") return "busy";
            return shot.voice_url ? "empty" : "empty";
        }
        default:
            return "empty";
    }
}

export type DramaPipelineRow = {
    shotId: string;
    idx: string | number;
    cells: Record<DramaPipelineStageId, DramaPipelineCellState>;
    projection: DramaShotProjectionFields;
};

/** 从 shots[] 生成竖排行（切换视图不改业务数据）。 */
export function toDramaPipelineRows(
    shots: readonly ToivDramaShot[],
    pipeline?: string,
): DramaPipelineRow[] {
    return shots.map((shot) => {
        const cells = {} as Record<DramaPipelineStageId, DramaPipelineCellState>;
        for (const stage of DRAMA_PIPELINE_STAGES) {
            cells[stage.id] = dramaPipelineCellState(shot, stage.id);
        }
        return {
            shotId: shot.id,
            idx: shot.idx,
            cells,
            projection: toDramaShotProjection(shot, pipeline),
        };
    });
}

export function dramaPipelineCellLabel(state: DramaPipelineCellState): string {
    switch (state) {
        case "ready":
            return "有";
        case "busy":
            return "生成中";
        case "failed":
            return "失败";
        case "skipped":
            return "跳过";
        default:
            return "空";
    }
}


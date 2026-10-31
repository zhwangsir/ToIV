/**
 * F1 / P4：控片台就绪灯（wind-comic 范式）。
 * 同源投影自 shots[] + 定妆计数 + 可选依赖态；非第二真源。
 */
import {
    dramaPipelineCellState,
    type DramaPipelineCellState,
} from "@/pages/toiv/drama-shot-board";
import type { ToivDramaShot } from "@/services/toiv/client";

export type ControlLampId =
    | "makeup"
    | "frame"
    | "video"
    | "voice"
    | "lipsync"
    | "assemble";

export type ControlLampState = "off" | "ready" | "busy" | "failed" | "blocked" | "partial";

export type ControlLamp = {
    id: ControlLampId;
    label: string;
    state: ControlLampState;
    detail: string;
};

export const CONTROL_LAMP_ORDER: readonly ControlLampId[] = [
    "makeup",
    "frame",
    "video",
    "voice",
    "lipsync",
    "assemble",
] as const;

const LAMP_LABEL: Record<ControlLampId, string> = {
    makeup: "定妆",
    frame: "关键帧",
    video: "视频",
    voice: "配音",
    lipsync: "口型",
    assemble: "合成",
};

function aggregatePipelineStage(
    shots: readonly ToivDramaShot[],
    stage: "frame" | "video" | "voice" | "lipsync",
): ControlLampState {
    if (shots.length === 0) return "off";
    const states = shots.map((s) => dramaPipelineCellState(s, stage));
    if (states.every((x) => x === "skipped")) return "ready";
    const active = states.filter((x) => x !== "skipped");
    if (active.length === 0) return "off";
    if (active.some((x) => x === "failed")) return "failed";
    if (active.some((x) => x === "busy")) return "busy";
    if (active.every((x) => x === "ready")) return "ready";
    if (active.some((x) => x === "ready")) return "partial";
    return "off";
}

function lampDetail(state: ControlLampState, ready: number, total: number, extra = ""): string {
    const base =
        state === "ready"
            ? `已就绪 ${ready}/${total}`
            : state === "partial"
              ? `部分就绪 ${ready}/${total}`
              : state === "busy"
                ? "进行中"
                : state === "failed"
                  ? "有失败项"
                  : state === "blocked"
                    ? "被依赖拦住"
                    : total === 0
                      ? "暂无镜头"
                      : `未就绪 ${ready}/${total}`;
    return extra ? `${base} · ${extra}` : base;
}

function countReady(
    shots: readonly ToivDramaShot[],
    stage: "frame" | "video" | "voice" | "lipsync",
): { ready: number; total: number } {
    let ready = 0;
    let total = 0;
    for (const s of shots) {
        const st = dramaPipelineCellState(s, stage);
        if (st === "skipped") continue;
        total += 1;
        if (st === "ready") ready += 1;
    }
    return { ready, total };
}

export type ControlReadinessInput = {
    shots: readonly ToivDramaShot[];
    charactersWithMakeup: number;
    characterCount: number;
    /** 依赖不可用时挡合成/视频等（可选） */
    videoBlocked?: boolean;
    assembleBlocked?: boolean;
};

/** 项目级控片就绪灯（六灯）。 */
export function projectControlReadinessLamps(input: ControlReadinessInput): ControlLamp[] {
    const { shots, charactersWithMakeup, characterCount, videoBlocked, assembleBlocked } = input;
    const makeupTotal = Math.max(characterCount, 0);
    const makeupReady = Math.min(Math.max(charactersWithMakeup, 0), makeupTotal || charactersWithMakeup);
    let makeupState: ControlLampState = "off";
    if (makeupTotal === 0) makeupState = "off";
    else if (makeupReady >= makeupTotal) makeupState = "ready";
    else if (makeupReady > 0) makeupState = "partial";
    else makeupState = "blocked";

    const frameAgg = aggregatePipelineStage(shots, "frame");
    const videoAgg = videoBlocked ? "blocked" : aggregatePipelineStage(shots, "video");
    const voiceAgg = aggregatePipelineStage(shots, "voice");
    const lipsyncAgg = aggregatePipelineStage(shots, "lipsync");

    const assembleReady = shots.filter((s) => Boolean(s.final_clip_url)).length;
    let assembleState: ControlLampState = "off";
    if (shots.length === 0) assembleState = "off";
    else if (assembleBlocked) assembleState = "blocked";
    else if (assembleReady >= shots.length) assembleState = "ready";
    else if (assembleReady > 0) assembleState = "partial";
    else assembleState = "off";

    const frameC = countReady(shots, "frame");
    const videoC = countReady(shots, "video");
    const voiceC = countReady(shots, "voice");
    const lipsyncC = countReady(shots, "lipsync");

    const lamps: ControlLamp[] = [
        {
            id: "makeup",
            label: LAMP_LABEL.makeup,
            state: makeupState,
            detail: lampDetail(
                makeupState,
                makeupReady,
                makeupTotal || 0,
                makeupState === "blocked" ? "请先定妆选角" : "",
            ),
        },
        {
            id: "frame",
            label: LAMP_LABEL.frame,
            state: frameAgg,
            detail: lampDetail(frameAgg, frameC.ready, frameC.total),
        },
        {
            id: "video",
            label: LAMP_LABEL.video,
            state: videoAgg,
            detail: lampDetail(
                videoAgg,
                videoC.ready,
                videoC.total,
                videoBlocked ? "视频引擎不可用" : "",
            ),
        },
        {
            id: "voice",
            label: LAMP_LABEL.voice,
            state: voiceAgg,
            detail: lampDetail(voiceAgg, voiceC.ready, voiceC.total),
        },
        {
            id: "lipsync",
            label: LAMP_LABEL.lipsync,
            state: lipsyncAgg,
            detail: lampDetail(lipsyncAgg, lipsyncC.ready, lipsyncC.total),
        },
        {
            id: "assemble",
            label: LAMP_LABEL.assemble,
            state: assembleState,
            detail: lampDetail(
                assembleState,
                assembleReady,
                shots.length,
                assembleBlocked ? "请先完成镜头成片段" : "",
            ),
        },
    ];
    return lamps;
}

export function controlLampTone(
    state: ControlLampState,
): "neutral" | "success" | "warning" | "error" {
    switch (state) {
        case "ready":
            return "success";
        case "partial":
        case "busy":
            return "warning";
        case "failed":
        case "blocked":
            return "error";
        default:
            return "neutral";
    }
}

export function controlLampStateLabel(state: ControlLampState): string {
    switch (state) {
        case "ready":
            return "亮";
        case "partial":
            return "半亮";
        case "busy":
            return "闪";
        case "failed":
            return "故障";
        case "blocked":
            return "拦";
        default:
            return "灭";
    }
}

/** 供测试/调试：把 pipeline cell 映射到灯态（单镜）。 */
export function cellStateToLampState(cell: DramaPipelineCellState): ControlLampState {
    switch (cell) {
        case "ready":
        case "skipped":
            return "ready";
        case "busy":
            return "busy";
        case "failed":
            return "failed";
        default:
            return "off";
    }
}

/**
 * C1c 六阶段进度纯函数:阶段定义/旧数据回退/导航映射/阻断推导/动作可用性/409 提取/load 防串号。
 * 只消费后端 stage_states 真值;旧服务端无该字段时由组件回退四阶段,这里只负责可判定逻辑。
 */
import type {
    ToivDramaDetail,
    ToivStageId,
    ToivStageState,
    ToivStageStateValue,
} from "@/services/toiv/client";

/** 实际 SECTIONS 键(script/assets/storyboard/shots/timeline/final)的子集 */
export type StudioNavSection = "script" | "assets" | "storyboard" | "shots" | "timeline" | "final";

export type StudioStageDef = {
    id: ToivStageId;
    index: string;
    label: string;
    hint: string;
    /** 阶段导航目标区段(voice→shots 生成区段;timeline→timeline 时间线区段) */
    navSection: StudioNavSection;
};

export const STUDIO_STAGES: readonly StudioStageDef[] = [
    { id: "script", index: "01", label: "剧本", hint: "先定故事与分场", navSection: "script" },
    { id: "assets", index: "02", label: "资产", hint: "锁角色/场景再进镜头", navSection: "assets" },
    { id: "storyboard", index: "03", label: "分镜", hint: "镜头网格与首尾帧", navSection: "storyboard" },
    { id: "generate", index: "04", label: "生成", hint: "选模 → 参数 → 出片", navSection: "shots" },
    { id: "voice", index: "05", label: "配音", hint: "台词转语音与对齐", navSection: "shots" },
    { id: "timeline", index: "06", label: "合成", hint: "时间线组装出成片", navSection: "timeline" },
];

export function stageNavSection(stage: ToivStageId): StudioNavSection {
    return STUDIO_STAGES.find((s) => s.id === stage)?.navSection ?? "shots";
}

export function parseStudioStage(value: string | null): ToivStageId | null {
    return STUDIO_STAGES.some((stage) => stage.id === value) ? value as ToivStageId : null;
}

/** 旧服务端/无项目:stage_states 六段字段齐全才启用,否则安全回旧四阶段 */
export function hasStageStates(detail: Pick<ToivDramaDetail, "stage_states"> | null | undefined): boolean {
    const states = detail?.stage_states;
    if (!states || typeof states !== "object") return false;
    return STUDIO_STAGES.every((s) => {
        const v = (states as Record<string, unknown>)[s.id];
        return Boolean(v && typeof v === "object" && typeof (v as { state?: unknown }).state === "string");
    });
}

export function stageStateOf(detail: Pick<ToivDramaDetail, "stage_states"> | null | undefined, stage: ToivStageId): ToivStageState | undefined {
    return detail?.stage_states?.[stage];
}

export const STAGE_STATE_META: Record<ToivStageStateValue, { label: string; tone: "muted" | "info" | "success" | "warning" | "danger" | "accent" }> = {
    draft: { label: "未开始", tone: "muted" },
    pending_confirmation: { label: "待确认", tone: "info" },
    confirmed: { label: "已确认", tone: "success" },
    generating: { label: "进行中", tone: "accent" },
    failed: { label: "失败", tone: "danger" },
    needs_review: { label: "需复核", tone: "warning" },
    skipped: { label: "已跳过", tone: "muted" },
};

export type StageActions = {
    canConfirm: boolean;
    canSkip: boolean;
    canReopen: boolean;
    confirmLabel: string;
};

/** 确认/跳过/重开可用性(由服务端状态推导;needs_review 必须先重开再确认) */
export function stageActionsFor(state: ToivStageStateValue | undefined): StageActions {
    switch (state) {
        case "pending_confirmation":
            return { canConfirm: true, canSkip: true, canReopen: false, confirmLabel: "确认" };
        case "needs_review":
            return { canConfirm: false, canSkip: true, canReopen: true, confirmLabel: "重开再确认" };
        case "confirmed":
        case "skipped":
            return { canConfirm: false, canSkip: false, canReopen: true, confirmLabel: "确认" };
        case "failed":
            // 后端 reopen 对 failed 实际是 no-op,前端不提供该入口
            return { canConfirm: false, canSkip: false, canReopen: false, confirmLabel: "确认" };
        case "generating":
            return { canConfirm: false, canSkip: false, canReopen: false, confirmLabel: "确认" };
        default:
            // draft / 未知(旧数据缺段):允许跳过,不允许无据确认
            return { canConfirm: false, canSkip: true, canReopen: false, confirmLabel: "确认" };
    }
}

/**
 * 最早阻断阶段:第一个状态非 confirmed/skipped 的已存在阶段。
 * 批量 render / assemble 被 409 拦截时,用它给出「定位到相应阶段」的可执行入口;
 * 无 stage_states(旧服务端)返回 null,不误导导航。
 */
export function firstBlockingStage(detail: Pick<ToivDramaDetail, "stage_states"> | null | undefined): ToivStageId | null {
    if (!hasStageStates(detail)) return null;
    for (const stage of STUDIO_STAGES) {
        const s = detail?.stage_states?.[stage.id];
        if (!s) continue;
        if (s.state !== "confirmed" && s.state !== "skipped") return stage.id;
    }
    return null;
}

/** 409 阶段冲突 → 后端 detail;非 409 → null(交由常规错误处理) */
export function stageTransitionConflictMessage(e: unknown): string | null {
    const resp = (e as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
    if (resp?.status !== 409) return null;
    const detail = resp.data?.detail;
    return typeof detail === "string" && detail.trim() ? detail : "阶段操作冲突:已被其他操作更新,请刷新后重试";
}

/**
 * load() 序号闸:项目切换/组件卸载后,旧请求返回不得覆盖新项目投影。
 * drama-workspace 每次 load 先 begin() 取号,写状态前 isCurrent(seq) 判定。
 */
export function createLoadSeqGuard(): { begin: () => number; isCurrent: (seq: number) => boolean } {
    let current = 0;
    return {
        begin: () => {
            current += 1;
            return current;
        },
        isCurrent: (seq: number) => seq === current,
    };
}

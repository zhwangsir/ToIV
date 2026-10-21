/**
 * F1 / P4：关键帧驱动为分镜默认（BigBanana / LMD / Dralo）。
 *
 * 默认 keyframe：先有镜头关键帧（image_url / 配景采用）再开拍视频。
 * direct：专家旁路，跳过关键帧软闸（仍受定妆等人闸约束）。
 * 项目级 preferred_drive_mode 可持久化；缺省 = keyframe。
 */

export type StoryboardDriveMode = "keyframe" | "direct";

export const DEFAULT_STORYBOARD_DRIVE_MODE: StoryboardDriveMode = "keyframe";

export const STORYBOARD_DRIVE_OPTIONS: ReadonlyArray<{
    value: StoryboardDriveMode;
    label: string;
    note: string;
    expert?: boolean;
}> = [
    {
        value: "keyframe",
        label: "关键帧驱动（推荐）",
        note: "先帧后视频：配景/关键帧就绪后再开拍",
    },
    {
        value: "direct",
        label: "直接出视频",
        note: "跳过关键帧软闸（专家）",
        expert: true,
    },
] as const;

export function normalizeStoryboardDriveMode(raw: unknown): StoryboardDriveMode {
    const v = String(raw || "").trim().toLowerCase();
    return v === "direct" ? "direct" : DEFAULT_STORYBOARD_DRIVE_MODE;
}

export function isKeyframeDriveMode(mode: StoryboardDriveMode | string | null | undefined): boolean {
    return normalizeStoryboardDriveMode(mode) === "keyframe";
}

/** 镜头是否已有关键帧底座（竖排「帧」格同源：image_url）。 */
export function shotHasKeyframe(shot: { image_url?: string | null } | null | undefined): boolean {
    return Boolean(String(shot?.image_url || "").trim());
}

export type VideoRenderGate = {
    allowed: boolean;
    /** 与 studio-qa-failure 失败码表对齐 */
    code: "KEYFRAME_REQUIRED" | null;
    hint: string;
};

/**
 * 关键帧模式下：无 image_url 则拦住视频开拍（软闸，可切 direct 或采用配景）。
 * 已出视频/渲染中的镜不重复拦截。
 */
export function videoRenderGate(
    shot: { image_url?: string | null; status?: string | null; video_url?: string | null },
    mode: StoryboardDriveMode | string | null | undefined,
): VideoRenderGate {
    if (!isKeyframeDriveMode(mode)) {
        return { allowed: true, code: null, hint: "" };
    }
    const status = String(shot?.status || "").trim();
    if (shot?.video_url || ["rendered", "voiced", "lipsynced", "done", "rendering", "queued"].includes(status)) {
        return { allowed: true, code: null, hint: "" };
    }
    if (shotHasKeyframe(shot)) {
        return { allowed: true, code: null, hint: "" };
    }
    return {
        allowed: false,
        code: "KEYFRAME_REQUIRED",
        hint: "关键帧驱动：请先在分镜「AI 配景」生成并采用关键帧，再开拍视频；或将驱动模式改为「直接出视频（专家）」。",
    };
}

/** 关键帧默认时，镜头视图优先「流水线」以露出 文→帧→视频。 */
export function defaultShotViewModeForDrive(
    mode: StoryboardDriveMode | string | null | undefined,
): "list" | "board" | "pipeline" {
    return isKeyframeDriveMode(mode) ? "pipeline" : "list";
}

export const KEYFRAME_DRIVE_BADGE = "分镜默认：关键帧驱动（先帧后视频）";

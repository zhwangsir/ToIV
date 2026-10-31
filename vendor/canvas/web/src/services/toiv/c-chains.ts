/** 管线 C c-chains 纯函数与类型（无 axios，便于单测）。 */

export type ToivCChainStart = {
    type: "makeup" | "video" | "job";
    video_url?: string;
    job_id?: string;
};

export type ToivCChainSegmentIn = {
    prompt: string;
    duration_sec?: number;
    dialogue?: string;
    speaker?: string;
    camera?: string;
    scene?: string;
    characters?: string[];
    scene_images?: string[];
    outfit_desc?: string;
    num_candidates?: number;
};

export type ToivCChainCreateBody = {
    pipeline?: "ref2va" | "c" | "c_hybrid";
    project_id?: string;
    start?: ToivCChainStart;
    character_ids?: string[];
    style?: string;
    aspect_ratio?: "9:16";
    resolution?: { width?: number; height?: number };
    keep_audio?: boolean;
    num_candidates?: number;
    seed?: number;
    ref_images?: string[];
    scene_images?: string[];
    outfit_desc?: string;
    auto_assemble?: boolean;
    worker_url?: string;
    segments: ToivCChainSegmentIn[];
};

export type ToivCChainJobAck = {
    job_id: string;
    chain_id: string;
    status: string;
    prompt_id?: string;
    segments?: Array<{ index?: number; segment_id?: string; status?: string }>;
};

export type ToivCChainCandidate = {
    id: string;
    url?: string;
    status?: string;
    is_picked?: boolean;
    first_frame?: string;
    seed?: number;
};

export type ToivCChainSegmentOut = {
    index: number;
    segment_id: string;
    status: string;
    shot_status?: string;
    prompt?: string;
    duration_sec?: number;
    clip_url?: string;
    error?: string;
    candidates?: ToivCChainCandidate[];
};

export type ToivCChainDetail = {
    chain_id: string;
    jobs: string[];
    active_job_id?: string | null;
    final_url?: string;
    keep_audio?: boolean;
    segments: ToivCChainSegmentOut[];
};

/** 首版硬限制：非 makeup 在组包阶段拒绝 */
export function assertCChainMakeupOnly(start?: ToivCChainStart): void {
    const startType = start?.type ?? "makeup";
    if (startType !== "makeup") {
        throw new Error("首版 c-chains 仅支持 start.type=makeup");
    }
}

export type DramaLikeForCChain = {
    id: string;
    width?: number;
    height?: number;
    characters?: Array<{ id: string }>;
    shots?: Array<{
        prompt?: string;
        scene?: string;
        duration_sec?: number;
        dialogue?: string;
        speaker?: string;
        camera?: string;
    }>;
};

/** 从短剧分镜拼 makeup 链 body */
export function buildMakeupCChainFromDrama(
    project: DramaLikeForCChain,
    opts?: { num_candidates?: number; auto_assemble?: boolean },
): ToivCChainCreateBody {
    const shots = project.shots ?? [];
    const segments: ToivCChainSegmentIn[] = [];
    for (const s of shots) {
        const prompt = (s.prompt || s.scene || "").trim();
        if (!prompt) continue;
        segments.push({
            prompt,
            duration_sec: Math.min(15, Math.max(1, Number(s.duration_sec) || 6)),
            dialogue: s.dialogue || "",
            speaker: s.speaker || "",
            camera: s.camera || "",
            scene: s.scene || "",
        });
    }
    if (!segments.length) {
        throw new Error("没有可用分镜文案，无法启动 c-chains");
    }
    return {
        pipeline: "c_hybrid",
        project_id: project.id,
        start: { type: "makeup" },
        aspect_ratio: "9:16",
        style: undefined,
        resolution:
            project.width && project.height
                ? { width: project.width, height: project.height }
                : undefined,
        character_ids: (project.characters ?? []).map((c) => c.id).filter(Boolean),
        num_candidates: opts?.num_candidates ?? 2,
        auto_assemble: opts?.auto_assemble ?? true,
        segments,
    };
}

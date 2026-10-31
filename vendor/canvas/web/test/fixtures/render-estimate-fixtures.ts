import type { ToivRenderEstimate } from "../src/services/toiv/client";

export function batchEstimate(overrides: Partial<ToivRenderEstimate> = {}): ToivRenderEstimate {
    return {
        schema: "toiv_render_estimate_v1",
        scope: "batch",
        project_id: "p1",
        allowed: true,
        blockers: [],
        warnings: [],
        input_fingerprint: "batch-fp-1",
        work: {
            shot_count: 3,
            candidate_upper_bound: 6,
            requested_duration_sec: 18,
            requested_frame_count: 432,
            pixel_frame_upper_bound: 447897600,
            image_motion_count: 0,
        },
        items: [
            { shot_id: "s1", idx: 1, engine: "h3", pipeline: "ref2va", render_mode: "video", candidates: 2, duration_sec: 6, frames: 144, pixel_frames_upper_bound: 149299200 },
            { shot_id: "s2", idx: 2, engine: "h3", pipeline: "ref2va", render_mode: "video", candidates: 2, duration_sec: 6, frames: 144, pixel_frames_upper_bound: 149299200 },
            { shot_id: "s3", idx: 3, engine: "h3", pipeline: "ref2va", render_mode: "video", candidates: 2, duration_sec: 6, frames: 144, pixel_frames_upper_bound: 149299200 },
        ],
        pricing: { status: "unpriced", currency: null, total: null, rate_source: "none", unknowns: ["h3.rate"] },
        budget: { status: "disabled", limit: null, currency: null },
        ...overrides,
    };
}

export function shotEstimate(overrides: Partial<ToivRenderEstimate> = {}): ToivRenderEstimate {
    const batch = batchEstimate();
    return {
        ...batch,
        scope: "shot",
        shot_id: "shot-1",
        input_fingerprint: "shot-fp-1",
        work: { ...batch.work, shot_count: 1, candidate_upper_bound: 2, requested_duration_sec: 6, requested_frame_count: 144, pixel_frame_upper_bound: 149299200 },
        items: [batch.items[0]],
        ...overrides,
    };
}

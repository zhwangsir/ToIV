import { authHeaders, studioDetailText, studioRequest } from "./studioHttp";
import { parsePrimeShotCard, primeShotWriteInput, type PrimeShotCard, type PrimeShotInput, type PrimeMediaStatus } from "./storyboard";
import { parsePrimeStageProjection, type PrimeStageProjection } from "./stages";

export const EDIT_TRACKS = ["v1", "a1", "s1", "a2"] as const;
export type PrimeEditTrack = (typeof EDIT_TRACKS)[number];
export type PrimeEditKind = "video" | "image" | "audio" | null;

export type PrimeEditClip = {
    id: string; shotId: string; track: PrimeEditTrack; label: string;
    startSec: number; durationSec: number; src: string; text?: string; kind: PrimeEditKind;
};
export type PrimeEditShot = {
    id: string; idx: number; label: string; prompt: string; scene: string; camera: string;
    durationSec: number; minSec: number; maxSec: number;
    dialogue: string; speaker: string;
    status: PrimeShotCard["status"]; error: string; media: PrimeShotCard["media"];
    finalClipUrl: string; videoUrl: string; voiceUrl: string; imageUrl: string; revisionId: string;
    beats: number; write: PrimeShotInput;
};
export type PrimeEditIssueKind = "missing_clip" | "illegal_duration" | "duration_over_limit";
export type PrimeEditIssue = { kind: PrimeEditIssueKind; shotId: string; idx: number; label: string; detail: string };
export type PrimeEditBayModel = {
    projectId: string; title: string; fps: number; contentMode: string;
    finalUrl: string; bgmUrl: string; projectStatus: string;
    shots: PrimeEditShot[]; clips: PrimeEditClip[]; totalSec: number;
    issues: { missing: PrimeEditIssue[]; duration: PrimeEditIssue[] };
    noVoice: string[];
    stages: PrimeStageProjection | null;
};
export type PrimeEditProjection = {
    clips: PrimeEditClip[]; totalSec: number; dirty: string[];
    issues: { missing: PrimeEditIssue[]; duration: PrimeEditIssue[] };
};

const SHOT_MIN_SEC = 1;
const SHOT_MAX_SEC = 60;
const BEAT_MIN_SEC = 3;
const FALLBACK_DURATION_SEC = 6;

type RawTimelineItem = {
    shot_id?: unknown; idx?: unknown; kind?: unknown; preview_url?: unknown;
    media_url?: unknown; duration_sec?: unknown; nsfw?: unknown;
};
type RawTimeline = { fps?: unknown; content_mode?: unknown; items?: unknown };

/** Backend export projection: <=0 or non-finite falls back to 6s; over-limit keeps its value. */
export function primeEffectiveDuration(raw: number): number {
    return Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_DURATION_SEC;
}

function durationIssue(shot: Pick<PrimeEditShot, "id" | "idx" | "label" | "durationSec">): PrimeEditIssue | null {
    const value = shot.durationSec;
    if (!Number.isFinite(value) || value <= 0) {
        return { kind: "illegal_duration", shotId: shot.id, idx: shot.idx, label: shot.label,
            detail: `声明时长 ${Number.isFinite(value) ? value : "—"}s 非法，导出按 ${FALLBACK_DURATION_SEC}s 回退` };
    }
    if (value < SHOT_MIN_SEC) {
        return { kind: "illegal_duration", shotId: shot.id, idx: shot.idx, label: shot.label,
            detail: `声明时长 ${value}s 低于 ${SHOT_MIN_SEC}s 下限` };
    }
    if (value > SHOT_MAX_SEC) {
        return { kind: "duration_over_limit", shotId: shot.id, idx: shot.idx, label: shot.label,
            detail: `声明时长 ${value}s 超过 ${SHOT_MAX_SEC}s 上限，切点仍按原值` };
    }
    return null;
}

function durationBounds(beatCount: number): { minSec: number; maxSec: number } {
    return { minSec: beatCount ? BEAT_MIN_SEC : SHOT_MIN_SEC, maxSec: SHOT_MAX_SEC };
}

export function clampPrimeDuration(shot: PrimeEditShot, value: number): number {
    if (!Number.isFinite(value)) return shot.durationSec;
    return Math.min(shot.maxSec, Math.max(shot.minSec, Math.round(value)));
}

function project(
    shots: PrimeEditShot[], overrides: Record<string, number>, base: PrimeEditBayModel,
): PrimeEditProjection {
    const clips: PrimeEditClip[] = [];
    const duration: PrimeEditIssue[] = [];
    const dirty: string[] = [];
    let cursor = 0;
    for (const shot of shots) {
        const override = overrides[shot.id];
        const declared = override === undefined ? shot.durationSec : clampPrimeDuration(shot, override);
        if (override !== undefined && declared !== shot.durationSec) dirty.push(shot.id);
        const issue = durationIssue({ ...shot, durationSec: declared });
        if (issue) duration.push(issue);
        const seconds = primeEffectiveDuration(declared);
        const preview = base.clips.find(clip => clip.track === "v1" && clip.shotId === shot.id);
        if (!preview) continue;
        const startSec = round3(cursor);
        const durationSec = round3(seconds);
        clips.push({ ...preview, startSec, durationSec });
        if (shot.voiceUrl.trim()) {
            clips.push({ id: `${shot.id}:a1`, shotId: shot.id, track: "a1", label: `${shot.label} 配音`,
                startSec, durationSec, src: shot.voiceUrl, kind: "audio" });
        }
        if (shot.dialogue.trim()) {
            clips.push({ id: `${shot.id}:s1`, shotId: shot.id, track: "s1", label: `${shot.label} 字幕`,
                startSec, durationSec, src: "", text: shot.dialogue.trim(), kind: null });
        }
        cursor += seconds;
    }
    const totalSec = round3(cursor);
    if (base.bgmUrl) {
        clips.push({ id: "bgm", shotId: "", track: "a2", label: "声床", startSec: 0,
            durationSec: totalSec, src: base.bgmUrl, kind: "audio" });
    }
    return { clips, totalSec, dirty, issues: { missing: base.issues.missing, duration } };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function parsePrimeEditBay(detail: unknown, preview: unknown, projectId: string): PrimeEditBayModel {
    const detailRecord = detail && typeof detail === "object" && !Array.isArray(detail)
        ? detail as Record<string, unknown> : null;
    const timeline = preview && typeof preview === "object" && !Array.isArray(preview)
        ? preview as RawTimeline : null;
    if (!detailRecord || detailRecord.id !== projectId || !Array.isArray(detailRecord.shots)
        || !timeline || !Array.isArray(timeline.items)) {
        throw new Error("时间线响应不完整，请刷新；未执行写入");
    }
    const items = new Map<string, RawTimelineItem>();
    for (const raw of timeline.items) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as RawTimelineItem;
        if (typeof item.shot_id === "string" && item.shot_id) items.set(item.shot_id, item);
    }

    const shots: PrimeEditShot[] = [];
    const missing: PrimeEditIssue[] = [];
    const baseClips: PrimeEditClip[] = [];
    for (const [index, raw] of (detailRecord.shots as unknown[]).entries()) {
        const card = parsePrimeShotCard(raw, index);
        const record = raw as Record<string, unknown>;
        const item = items.get(card.id);
        if (!item) throw new Error("时间线响应不完整，请刷新；未执行写入");
        const kind = item.kind === undefined || item.kind === null ? null : item.kind;
        if (kind !== null && kind !== "video" && kind !== "image" && kind !== "audio") {
            throw new Error("时间线响应含未知媒体类型，请刷新；未执行写入");
        }
        const idx = typeof record.idx === "number" && Number.isFinite(record.idx) ? record.idx : index;
        const label = `镜${String(idx + 1).padStart(2, "0")}`;
        const beats = Array.isArray(record.beats) ? record.beats.length : 0;
        const bounds = durationBounds(beats);
        const imageUrl = typeof record.image_url === "string" ? record.image_url : "";
        const shot: PrimeEditShot = {
            id: card.id, idx, label, prompt: card.prompt, scene: String(record.scene ?? ""),
            camera: card.camera, durationSec: card.durationSec, ...bounds,
            dialogue: card.dialogue, speaker: card.speaker, status: card.status, error: card.error ?? "",
            media: card.media, finalClipUrl: card.finalClipUrl, videoUrl: card.videoUrl,
            voiceUrl: card.voiceUrl, imageUrl, revisionId: card.revisionId, beats,
            write: primeShotWriteInput({ ...card.write, expected_revision: card.revisionId }),
        };
        shots.push(shot);
        const src = (card.finalClipUrl || card.videoUrl).trim();
        if (kind !== "video" || !src) {
            missing.push({ kind: "missing_clip", shotId: card.id, idx, label,
                detail: kind === "image" ? "仅有静帧，缺最终片段，未进时间线" : "缺最终片段，未进时间线" });
            continue;
        }
        baseClips.push({ id: `${card.id}:v1`, shotId: card.id, track: "v1", label,
            startSec: 0, durationSec: primeEffectiveDuration(card.durationSec),
            src, kind: "video" });
    }

    const model: PrimeEditBayModel = {
        projectId, title: typeof detailRecord.title === "string" ? detailRecord.title : projectId,
        fps: Number(timeline.fps) > 0 ? Number(timeline.fps) : 24,
        contentMode: typeof timeline.content_mode === "string" ? timeline.content_mode : "",
        finalUrl: typeof detailRecord.final_url === "string" ? detailRecord.final_url : "",
        bgmUrl: typeof detailRecord.bgm_url === "string" ? detailRecord.bgm_url : "",
        projectStatus: typeof detailRecord.status === "string" ? detailRecord.status : "",
        shots, clips: [], totalSec: 0, issues: { missing, duration: [] }, noVoice: [],
        stages: parsePrimeStageProjection(detailRecord.stage_states, detailRecord.stage_revision),
    };
    model.noVoice = shots
        .filter(shot => shot.dialogue.trim() && !shot.voiceUrl.trim()
            && baseClips.some(clip => clip.shotId === shot.id))
        .map(shot => shot.id);
    const projection = project(shots, {}, { ...model, clips: baseClips });
    return { ...model, clips: projection.clips, totalSec: projection.totalSec, issues: projection.issues };
}

export async function loadPrimeEditBay(projectId: string): Promise<PrimeEditBayModel> {
    const [detail, preview] = await Promise.all([
        studioRequest<unknown>(`/api/studio/projects/${encodeURIComponent(projectId)}`),
        studioRequest<unknown>(`/api/studio/projects/${encodeURIComponent(projectId)}/timeline-preview`),
    ]);
    return parsePrimeEditBay(detail, preview, projectId);
}

export function projectPrimeEditBay(model: PrimeEditBayModel, overrides: Record<string, number>): PrimeEditProjection {
    return project(model.shots, overrides, model);
}

export async function savePrimeEditDurations(
    model: PrimeEditBayModel, overrides: Record<string, number>,
): Promise<PrimeEditBayModel> {
    const projection = projectPrimeEditBay(model, overrides);
    if (!projection.dirty.length) return model;
    for (const shotId of projection.dirty) {
        const shot = model.shots.find(item => item.id === shotId);
        const override = overrides[shotId];
        if (!shot || !Number.isFinite(override)) throw new Error("时长必须是整数秒");
        if (!Number.isInteger(override)) throw new Error("时长必须是 1–60 的整数秒");
        if (override < shot.minSec || override > shot.maxSec) {
            throw new Error(`时长须在 ${shot.minSec}–${shot.maxSec} 秒之间`);
        }
    }
    const payload = model.shots.map(shot => primeShotWriteInput({
        ...shot.write,
        duration_sec: overrides[shot.id] ?? shot.durationSec,
        expected_revision: shot.revisionId,
    }));
    await studioRequest(`/api/studio/projects/${encodeURIComponent(model.projectId)}/shots`, "PUT", {
        shots: payload, expected_shot_ids: model.shots.map(shot => shot.id),
    });
    return loadPrimeEditBay(model.projectId);
}

export type PrimeExportKind = "jianying" | "edl" | "fcpxml" | "multitrack";
export type PrimeExportPreflight =
    | { state: "ok"; missingAssets: number; durationIssues: number; detail: "" }
    | { state: "blocked" | "unknown"; missingAssets: null; durationIssues: null; detail: string };
export type PrimeExportFile = {
    kind: PrimeExportKind; filename: string; blob: Blob;
    missingAssets: number | null; durationIssues: number | null; format: string;
};

const EXPORT_PATH: Record<PrimeExportKind, string> = {
    jianying: "export/jianying", edl: "export/edl",
    fcpxml: "export/fcpxml", multitrack: "export/multitrack",
};
const EXPORT_EXT: Record<PrimeExportKind, string> = {
    jianying: "zip", edl: "edl", fcpxml: "fcpxml", multitrack: "zip",
};

function headerCount(res: Response, name: string): number | null {
    const raw = res.headers.get(name);
    if (raw === null || !raw.trim()) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function filenameFrom(header: string | null, fallback: string): string {
    if (!header) return fallback;
    const starred = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (starred) {
        try { return decodeURIComponent(starred[1]); } catch { /* fall through */ }
    }
    const plain = /filename="([^"]+)"/i.exec(header);
    return plain ? plain[1] : fallback;
}

async function failureText(res: Response, label: string): Promise<string> {
    const payload = await res.json().catch(() => null) as { detail?: unknown } | null;
    return studioDetailText(payload?.detail) || `${label} ${res.status}`;
}

/** Cheap HEAD on the EDL export: reads the server's missing-asset/duration receipt. */
export async function loadPrimeExportPreflight(projectId: string, signal?: AbortSignal): Promise<PrimeExportPreflight> {
    try {
        const res = await fetch(`/api/studio/projects/${encodeURIComponent(projectId)}/export/edl`, {
            method: "HEAD", headers: authHeaders(), ...(signal ? { signal } : {}),
        });
        if (!res.ok) {
            const detail = await failureText(res, "导出核验");
            return { state: res.status === 422 ? "blocked" : "unknown", missingAssets: null, durationIssues: null, detail };
        }
        const missing = headerCount(res, "X-Toiv-Missing-Assets");
        const duration = headerCount(res, "X-Toiv-Duration-Issues");
        if (missing === null || duration === null) {
            return { state: "unknown", missingAssets: null, durationIssues: null,
                detail: "服务端未返回导出核验头，缺素材统计不可用" };
        }
        return { state: "ok", missingAssets: missing, durationIssues: duration, detail: "" };
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return { state: "unknown", missingAssets: null, durationIssues: null,
            detail: error instanceof Error ? error.message : "导出核验请求失败" };
    }
}

export async function fetchPrimeExport(
    projectId: string, kind: PrimeExportKind, signal?: AbortSignal,
): Promise<PrimeExportFile> {
    const res = await fetch(`/api/studio/projects/${encodeURIComponent(projectId)}/${EXPORT_PATH[kind]}`, {
        headers: authHeaders(), ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`导出失败 · ${await failureText(res, "导出")}`);
    return {
        kind,
        filename: filenameFrom(res.headers.get("Content-Disposition"), `toiv-export.${EXPORT_EXT[kind]}`),
        blob: await res.blob(),
        missingAssets: headerCount(res, "X-Toiv-Missing-Assets"),
        durationIssues: headerCount(res, "X-Toiv-Duration-Issues"),
        format: res.headers.get("X-Toiv-Export-Format") || res.headers.get("X-Toiv-Draft-Format") || "",
    };
}

export function downloadPrimeExport(file: PrimeExportFile): void {
    const url = URL.createObjectURL(file.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatPrimeTime(sec: number): string {
    const tenths = Math.max(0, Math.floor((Number.isFinite(sec) ? sec : 0) * 10));
    const minutes = Math.floor(tenths / 600);
    const seconds = Math.floor((tenths % 600) / 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

export type PrimeEditTrackMeta = { key: PrimeEditTrack; label: string; hint: string };
export const PRIME_EDIT_TRACKS: readonly PrimeEditTrackMeta[] = [
    { key: "v1", label: "V1 画面", hint: "按分镜顺序拼接" },
    { key: "a1", label: "A1 配音", hint: "有配音才出现" },
    { key: "s1", label: "S1 字幕", hint: "台词随镜" },
    { key: "a2", label: "A2 声床", hint: "项目背景声" },
];

export const primeShotStale = (shot: PrimeEditShot): boolean => shot.media.final === "stale";
export const primeMediaLabel = (state: PrimeMediaStatus): string =>
    ({ none: "未生成", unknown: "未归档", current: "已同步", stale: "已过期" })[state] ?? "未归档";

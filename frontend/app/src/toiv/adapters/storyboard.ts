// Mirrors services/studio/schemas.py: ShotInput and WordAnchorBeat (not response projections).
import { parsePrimeStageProjection, type PrimeStageProjection } from "./stages";

type BeatDeclaration = { text?: string; kind?: "v" | "d" | null; cues?: string[]; anchor_words?: string; block?: number };
export type PrimeShotInput = {
    id?: string; scene?: string; prompt?: string; negative?: string | null; camera?: string;
    dialogue?: string; speaker?: string; duration_sec?: number; characters?: string[];
    render_mode?: string; seam_to_next?: string | null; seam_anchor?: string | null;
    ref_epoch?: number | null; ref_epoch_note?: string | null; beats?: BeatDeclaration[] | null;
    expected_revision?: string;
};
export type PrimeTake = {
    id: string; label: string; seed?: number; src?: string; picked: boolean; status: string;
    videoModel?: string; pipeline?: string; revisionId?: string; qaVerdict?: string; error?: string;
};
export type PrimeBeat = { text: string; kind: string };
export type PrimeMediaStatus = "none" | "unknown" | "current" | "stale";
export type PrimeShotMedia = { visual: PrimeMediaStatus; audio: PrimeMediaStatus; final: PrimeMediaStatus };
export type PrimeShotCard = {
    id: string; title: string; prompt: string; camera: string; durationSec: number;
    status: "done" | "run" | "wait" | "error"; error?: string;
    beats: PrimeBeat[]; takes: PrimeTake[]; candidatesDigest?: string;
    renderMode: "video" | "image_motion"; dialogue: string; speaker: string;
    videoUrl: string; voiceUrl: string; finalClipUrl: string; lipsyncSkipped: boolean;
    revisionId: string; media: PrimeShotMedia;
    write: PrimeShotInput;
};
export type PrimeStoryboardModel = {
    projectId: string; title: string; shots: PrimeShotCard[]; runningCount: number;
    stages: PrimeStageProjection | null; finalUrl: string; projectStatus: string; bgmUrl: string;
};
export type RawShot = PrimeShotInput & {
    id: string; idx?: number; status?: string; error?: string; current_revision_id?: string;
    candidates_digest?: string; render_mode?: string; dialogue?: string; speaker?: string;
    video_url?: string; voice_url?: string; final_clip_url?: string; lipsync_skipped?: boolean;
    visual_media_status?: string; audio_media_status?: string; final_media_status?: string;
    candidates?: { id: string; seed?: number; is_picked?: boolean; url?: string; status?: string;
        video_model?: string; pipeline?: string; revision_id?: string; qa?: { verdict?: string }; error?: string }[];
};
type RawProject = {
    id: string; title?: string; status?: string; final_url?: string; bgm_url?: string; shots: RawShot[];
    stage_states?: unknown; stage_revision?: unknown;
};

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const res = await fetch(path, { method, headers: { ...authHeaders(), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) {
        const detail = await res.json().catch(() => null) as { detail?: unknown } | null;
        throw new Error(`${method} ${res.status}${typeof detail?.detail === "string" ? ` · ${detail.detail}` : ""}${res.status === 409 ? " · 请刷新后核对，本地草稿已保留" : ""}`);
    }
    return res.json() as Promise<T>;
}

/** Explicit whitelist, including nested declarations: never echo media, candidates or projected times. */
export function primeShotWriteInput(shot: PrimeShotInput): PrimeShotInput {
    return {
        ...(shot.id ? { id: shot.id, expected_revision: shot.expected_revision ?? "" } : {}),
        scene: shot.scene ?? "", prompt: shot.prompt ?? "", negative: shot.negative ?? null,
        camera: shot.camera ?? "", dialogue: shot.dialogue ?? "", speaker: shot.speaker ?? "",
        duration_sec: shot.duration_sec ?? 6, characters: shot.characters ?? [], render_mode: shot.render_mode ?? "video",
        seam_to_next: shot.seam_to_next ?? null, seam_anchor: shot.seam_anchor ?? null,
        ref_epoch: shot.ref_epoch ?? null, ref_epoch_note: shot.ref_epoch_note ?? null,
        beats: shot.beats?.map(beat => ({ text: beat.text ?? "", kind: beat.kind ?? null,
            cues: beat.cues ?? [], anchor_words: beat.anchor_words ?? "", block: beat.block ?? 0 })) ?? [],
    };
}
function statusOf(raw: string): PrimeShotCard["status"] {
    if (["done", "voiced", "succeeded", "success"].includes(raw)) return "done";
    if (["running", "rendering", "processing"].includes(raw)) return "run";
    if (raw === "error" || raw === "failed") return "error";
    return "wait";
}
const MEDIA_STATES: readonly PrimeMediaStatus[] = ["none", "unknown", "current", "stale"];
/** Missing projection stays unknown; an unrecognized value is a contract violation, not a guess. */
function parseMedia(raw: Record<string, unknown>): PrimeShotMedia | null {
    const read = (value: unknown): PrimeMediaStatus | null => {
        if (value === undefined || value === null) return "unknown";
        return typeof value === "string" && MEDIA_STATES.includes(value as PrimeMediaStatus)
            ? value as PrimeMediaStatus : null;
    };
    const visual = read(raw.visual_media_status);
    const audio = read(raw.audio_media_status);
    const final = read(raw.final_media_status);
    return visual && audio && final ? { visual, audio, final } : null;
}

export function parsePrimeShotCard(raw: unknown, index: number, title?: string): PrimeShotCard {
    const shot = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as RawShot : null;
    const media = shot ? parseMedia(shot as Record<string, unknown>) : null;
    if (!shot || typeof shot.id !== "string" || !shot.id || !media) {
        throw new Error("分镜响应不完整，请刷新；未执行写入");
    }
    const candidates = Array.isArray(shot.candidates) ? shot.candidates : [];
    return {
        id: shot.id, title: title ?? `镜${String(index + 1).padStart(2, "0")}`,
        prompt: shot.prompt ?? "", camera: shot.camera || "—", durationSec: shot.duration_sec ?? 6,
        status: statusOf(shot.status ?? ""), error: shot.error,
        beats: (Array.isArray(shot.beats) ? shot.beats : []).map(beat => ({ text: beat.text ?? "", kind: beat.kind ?? "" })),
        takes: candidates.map((c, i) => ({ id: c.id, label: `T${i + 1}`, seed: c.seed,
            src: c.url, status: c.status ?? "unknown", picked: Boolean(c.is_picked), videoModel: c.video_model,
            pipeline: c.pipeline, revisionId: c.revision_id, qaVerdict: c.qa?.verdict, error: c.error })),
        candidatesDigest: shot.candidates_digest,
        renderMode: shot.render_mode === "image_motion" ? "image_motion" : "video",
        dialogue: shot.dialogue ?? "", speaker: shot.speaker ?? "",
        videoUrl: shot.video_url ?? "", voiceUrl: shot.voice_url ?? "", finalClipUrl: shot.final_clip_url ?? "",
        lipsyncSkipped: Boolean(shot.lipsync_skipped), revisionId: shot.current_revision_id ?? "", media,
        write: primeShotWriteInput({ ...shot, expected_revision: shot.current_revision_id ?? "" }),
    };
}

export function parsePrimeProjectDetail(detail: unknown, projectId: string, context: "分镜" | "项目" = "分镜"): PrimeStoryboardModel {
    const project = detail && typeof detail === "object" && !Array.isArray(detail) ? detail as RawProject : null;
    if (!project || project.id !== projectId || !Array.isArray(project.shots)) {
        throw new Error(`${context}响应不完整，请刷新；未执行写入`);
    }
    const shots = project.shots.map((shot, index) => parsePrimeShotCard(shot, index));
    return {
        projectId, title: project.title ?? projectId, shots,
        runningCount: shots.filter(s => s.status === "run").length,
        stages: parsePrimeStageProjection(project.stage_states, project.stage_revision),
        finalUrl: project.final_url ?? "", projectStatus: project.status ?? "", bgmUrl: project.bgm_url ?? "",
    };
}
export async function loadPrimeStoryboard(projectId: string): Promise<PrimeStoryboardModel> {
    const detail = await request<unknown>(`/api/studio/projects/${encodeURIComponent(projectId)}`);
    return parsePrimeProjectDetail(detail, projectId, "分镜");
}
function requireShot(model: PrimeStoryboardModel, shotId: string): PrimeShotCard {
    const shot = model.shots.find(s => s.id === shotId);
    if (!shot) throw new Error("分镜不存在，请刷新");
    return shot;
}
async function reloadAfterWrite(projectId: string): Promise<PrimeStoryboardModel> {
    try { return await loadPrimeStoryboard(projectId); }
    catch (error) { throw new Error(`写入已成功，但回读失败，请刷新核对后再编辑 · ${error instanceof Error ? error.message : "网络错误"}`); }
}

export async function savePrimeShotPrompt(model: PrimeStoryboardModel, shotId: string, prompt: string): Promise<PrimeStoryboardModel> {
    const target = requireShot(model, shotId);
    if (target.beats.length) throw new Error("有拍结构的镜头请编辑按拍文本，不能单独修改派生提示词");
    const shots = model.shots.map(s => primeShotWriteInput(s.id === shotId ? { ...s.write, prompt } : s.write));
    // 列表基线随写:服务端在同一事务里校验 id 集合与逐镜 expected_revision,
    // 不再用额外 GET 冒充 CAS。
    await request(`/api/studio/projects/${encodeURIComponent(model.projectId)}/shots`, "PUT", {
        shots, expected_shot_ids: model.shots.map(s => s.id),
    });
    return reloadAfterWrite(model.projectId);
}

export async function savePrimeShotBeats(model: PrimeStoryboardModel, shotId: string, texts: string[], totalSec: number): Promise<PrimeStoryboardModel> {
    const target = requireShot(model, shotId);
    if (!target.beats.length || texts.length !== target.beats.length) throw new Error("拍文本必须与原拍数等长");
    if (!Number.isInteger(totalSec) || totalSec < 3 || totalSec > 60) throw new Error("总时长须为 3–60 的整数秒");
    // expected_revision 由服务端在持久化事务内校验;从读到写之间无需预检 GET。
    await request(`/api/studio/shots/${encodeURIComponent(shotId)}/reflow-beats`, "POST", {
        texts, total_sec: totalSec, persist: true, expected_revision: target.revisionId,
    });
    return reloadAfterWrite(model.projectId);
}

export async function pickPrimeTake(shot: PrimeShotCard, candidateId: string): Promise<PrimeShotCard> {
    const take = shot.takes.find(t => t.id === candidateId);
    if (!take || take.status !== "done" || !take.src?.trim()) throw new Error("仅完成且有产物 URL 的候选可采用");
    if (!shot.candidatesDigest) throw new Error("候选校验信息缺失，请刷新后重试");
    const saved = await request<unknown>(`/api/studio/shots/${encodeURIComponent(shot.id)}/candidates/${encodeURIComponent(candidateId)}/pick`, "POST", {
        expected_candidates_digest: shot.candidatesDigest,
    });
    const card = parsePrimeShotCard(saved, 0, shot.title);
    if (card.id !== shot.id) throw new Error("采用请求已成功但返回的分镜不一致，请刷新核对");
    if (!Array.isArray((saved as RawShot).candidates)) throw new Error("采用请求已成功但返回数据不完整，请刷新核对");
    return card;
}

/** Sign only same-origin API paths. Protocol-relative/external URLs must never receive our token. */
export function primeTakeMediaUrl(src?: string): string {
    if (!src?.trim()) return "";
    const value = src.trim();
    const origin = typeof window !== "undefined" ? window.location.origin : "http://prime.invalid";
    try {
        const url = new URL(value, origin);
        if (url.protocol !== "https:" && url.protocol !== "http:") return "";
        if (url.origin !== origin || value.startsWith("//") || !url.pathname.startsWith("/api/")) return value;
        const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
        if (token) url.searchParams.set("token", token);
        return `${url.pathname}${url.search}${url.hash}`;
    } catch { return ""; }
}

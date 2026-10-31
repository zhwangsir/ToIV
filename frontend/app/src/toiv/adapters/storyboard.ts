// Mirrors services/studio/schemas.py: ShotInput and WordAnchorBeat (not response projections).
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
export type PrimeShotCard = {
    id: string; title: string; prompt: string; camera: string; durationSec: number;
    status: "done" | "run" | "wait" | "error"; error?: string;
    beats: PrimeBeat[]; takes: PrimeTake[]; candidatesDigest?: string;
    write: PrimeShotInput;
};
export type PrimeStoryboardModel = { projectId: string; title: string; shots: PrimeShotCard[]; runningCount: number };
type RawShot = PrimeShotInput & {
    id: string; idx?: number; status?: string; error?: string; current_revision_id?: string;
    candidates_digest?: string;
    candidates?: { id: string; seed?: number; is_picked?: boolean; url?: string; status?: string;
        video_model?: string; pipeline?: string; revision_id?: string; qa?: { verdict?: string }; error?: string }[];
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
function shotCard(shot: RawShot, index: number): PrimeShotCard {
    return {
        id: shot.id, title: `镜${String(index + 1).padStart(2, "0")}`,
        prompt: shot.prompt ?? "", camera: shot.camera || "—", durationSec: shot.duration_sec ?? 6,
        status: statusOf(shot.status ?? ""), error: shot.error,
        beats: (shot.beats ?? []).map(beat => ({ text: beat.text ?? "", kind: beat.kind ?? "" })),
        takes: (shot.candidates ?? []).map((c, i) => ({ id: c.id, label: `T${i + 1}`, seed: c.seed,
            src: c.url, status: c.status ?? "unknown", picked: Boolean(c.is_picked), videoModel: c.video_model,
            pipeline: c.pipeline, revisionId: c.revision_id, qaVerdict: c.qa?.verdict, error: c.error })),
        candidatesDigest: shot.candidates_digest,
        write: primeShotWriteInput({ ...shot, expected_revision: shot.current_revision_id ?? "" }),
    };
}
export async function loadPrimeStoryboard(projectId: string): Promise<PrimeStoryboardModel> {
    const detail = await request<{ id: string; title?: string; shots: RawShot[] }>(`/api/studio/projects/${encodeURIComponent(projectId)}`);
    if (detail.id !== projectId || !Array.isArray(detail.shots) || detail.shots.some(s => !s.id)) {
        throw new Error("分镜响应不完整，请刷新；未执行写入");
    }
    const shots = detail.shots.map(shotCard);
    return { projectId, title: detail.title ?? projectId, shots, runningCount: shots.filter(s => s.status === "run").length };
}
function requireShot(model: PrimeStoryboardModel, shotId: string): PrimeShotCard {
    const shot = model.shots.find(s => s.id === shotId);
    if (!shot) throw new Error("分镜不存在，请刷新");
    return shot;
}
async function checkSnapshot(model: PrimeStoryboardModel): Promise<void> {
    const current = await loadPrimeStoryboard(model.projectId);
    if (current.shots.length !== model.shots.length || current.shots.some((s, i) =>
        s.id !== model.shots[i].id || JSON.stringify(s.write) !== JSON.stringify(model.shots[i].write))) {
        throw new Error("分镜已变化，请刷新后核对；本地草稿已保留，未覆盖服务端");
    }
}
async function reloadAfterWrite(projectId: string): Promise<PrimeStoryboardModel> {
    try { return await loadPrimeStoryboard(projectId); }
    catch (error) { throw new Error(`写入已成功，但回读失败，请刷新核对后再编辑 · ${error instanceof Error ? error.message : "网络错误"}`); }
}

export async function savePrimeShotPrompt(model: PrimeStoryboardModel, shotId: string, prompt: string): Promise<PrimeStoryboardModel> {
    const target = requireShot(model, shotId);
    if (target.beats.length) throw new Error("有拍结构的镜头请编辑按拍文本，不能单独修改派生提示词");
    await checkSnapshot(model);
    const shots = model.shots.map(s => primeShotWriteInput(s.id === shotId ? { ...s.write, prompt } : s.write));
    await request(`/api/studio/projects/${encodeURIComponent(model.projectId)}/shots`, "PUT", { shots });
    return reloadAfterWrite(model.projectId);
}

export async function savePrimeShotBeats(model: PrimeStoryboardModel, shotId: string, texts: string[], totalSec: number): Promise<PrimeStoryboardModel> {
    const target = requireShot(model, shotId);
    if (!target.beats.length || texts.length !== target.beats.length) throw new Error("拍文本必须与原拍数等长");
    if (!Number.isInteger(totalSec) || totalSec < 3 || totalSec > 60) throw new Error("总时长须为 3–60 的整数秒");
    // Reflow has no expected_revision parameter. This preflight detects stale drafts, not an atomic CAS.
    await checkSnapshot(model);
    await request(`/api/studio/shots/${encodeURIComponent(shotId)}/reflow-beats`, "POST", { texts, total_sec: totalSec, persist: true });
    return reloadAfterWrite(model.projectId);
}

export async function pickPrimeTake(shot: PrimeShotCard, candidateId: string): Promise<PrimeShotCard> {
    const take = shot.takes.find(t => t.id === candidateId);
    if (!take || take.status !== "done" || !take.src?.trim()) throw new Error("仅完成且有产物 URL 的候选可采用");
    if (!shot.candidatesDigest) throw new Error("候选校验信息缺失，请刷新后重试");
    const saved = await request<RawShot>(`/api/studio/shots/${encodeURIComponent(shot.id)}/candidates/${encodeURIComponent(candidateId)}/pick`, "POST", {
        expected_candidates_digest: shot.candidatesDigest,
    });
    if (saved.id !== shot.id || !Array.isArray(saved.candidates)) throw new Error("采用请求已成功但返回数据不完整，请刷新核对");
    return { ...shotCard(saved, 0), title: shot.title };
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

import axios from "axios";

import { assertAxiosOutboundAllowed } from "@/lib/outbound-host-allowlist";

import {
    assertCChainMakeupOnly,
    buildMakeupCChainFromDrama,
    type ToivCChainCreateBody,
    type ToivCChainDetail,
    type ToivCChainJobAck,
    type ToivCChainSegmentIn,
} from "./c-chains";

export {
    assertCChainMakeupOnly,
    buildMakeupCChainFromDrama,
    type ToivCChainCandidate,
    type ToivCChainCreateBody,
    type ToivCChainDetail,
    type ToivCChainJobAck,
    type ToivCChainSegmentIn,
    type ToivCChainSegmentOut,
    type ToivCChainStart,
} from "./c-chains";

/**
 * ToIV 主站 API 客户端(融合 M1,2026-10-06):
 * 同源 /api 直连 ToIV FastAPI(PG 业务域:市场/作品/任务/智能体/短剧);
 * 认证用 ToIV JWT(localStorage.toiv_token,与旧版视图同 key 同源共享)。
 * 与画布 apiClient(/studio/api → per-user Go)是两个数据平面,互不混淆。
 */
const TOKEN_KEY = "toiv_token";

export const toivHttp = axios.create({ baseURL: "/api", timeout: 15_000 });

toivHttp.interceptors.request.use((config) => {
    assertAxiosOutboundAllowed(config);
    if (typeof window !== "undefined") {
        const token = window.localStorage.getItem(TOKEN_KEY);
        if (token) config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

export type ToivAgentRun = {
    id: string;
    level?: string;
    goal?: string;
    status: string;
    created_at: string;
    task_counts?: { total: number; done: number; error: number };
};

export type ToivBoard = {
    id: string;
    name: string;
    description?: string;
    cover_url?: string;
    item_count: number;
    created_at: string;
};

export async function fetchAgentRuns(limit = 100): Promise<ToivAgentRun[]> {
    const { data } = await toivHttp.get("/agent-runs", { params: { limit } });
    return Array.isArray(data) ? data : ((data as { items?: ToivAgentRun[] })?.items ?? []);
}

/** ToIV 生成作业（主站 /api/jobs，任务中心统一执行层） */
export type ToivJob = {
    id: string;
    prompt_id?: string;
    kind?: string;
    status: string;
    prompt?: string;
    created_at: string;
    error?: string;
    hold_reason?: string;
    nsfw?: boolean;
};

export async function fetchJobs(limit = 100): Promise<ToivJob[]> {
    const { data } = await toivHttp.get("/jobs", { params: { limit } });
    return Array.isArray(data) ? (data as ToivJob[]) : ((data as { items?: ToivJob[] })?.items ?? []);
}

export async function cancelJob(jobId: string): Promise<boolean> {
    try {
        await toivHttp.post(`/jobs/${jobId}/cancel`);
        return true;
    } catch {
        return false;
    }
}

export async function fetchBoards(): Promise<ToivBoard[]> {
    const { data } = await toivHttp.get("/boards");
    return Array.isArray(data) ? data : [];
}

export async function fetchBoardItems(boardId: string): Promise<ToivBoardItem[]> {
    const { data } = await toivHttp.get(`/boards/${boardId}/items`);
    return Array.isArray(data) ? (data as ToivBoardItem[]) : ((data as { items?: ToivBoardItem[] })?.items ?? []);
}

export type {
    MarketMediaHandle,
    MediaFilenamesOpts,
    ToivAppParam,
    ToivAppParamType,
} from "./market-run";
export {
    appUploadKind,
    asMarketMediaList,
    buildDefaultRunValues,
    buildToivRunValues,
    firstPinWorker,
    isRemoteDemoMedia,
    mediaFilenames,
    normalizeToivAppParam,
    requiredToivParamLabel,
} from "./market-run";
import { normalizeToivAppParam, type ToivAppParam } from "./market-run";


export { toivCoverImageUrl } from "./cover-url";


export type ToivApp = {
    id: string;
    name: string;
    description?: string;
    cover_url?: string;
    author?: string;
    category?: string;
    output_kind?: string;
    use_case?: string;
    usage_count?: number;
    featured?: boolean;
    is_builtin?: boolean;
    smoke_status?: string;
    guide_purpose?: string;
    source_links?: Array<{ label: string; url: string }>;
    /** 列表/详情均可能下发；本地能力徽标用 */
    submit_kind?: string;
    /** 详情接口才完整；列表 slim 时常为空数组 */
    params_schema?: ToivAppParam[];
};

export type ToivAppModeItem = {
    label: string;
    desc: string;
    app_id: string;
};

export type ToivAppVariantsInfo = {
    keeper_id: string;
    keeper_name: string;
    modes: ToivAppModeItem[];
    presets: Array<{ label: string; values: Record<string, unknown> }>;
};

export type ToivAppRunReceipt = {
    job_id: string;
    prompt_id: string;
    client_id?: string;
    worker?: string;
};

export async function fetchToivApps(
    limitOrFilter: number | { limit?: number; category?: string; q?: string } = 100,
): Promise<ToivApp[]> {
    const filter = typeof limitOrFilter === "number" ? { limit: limitOrFilter } : limitOrFilter;
    const params: Record<string, string | number> = { limit: filter.limit ?? 200 };
    if (filter.category && filter.category !== "all") params.category = filter.category;
    if (filter.q?.trim()) params.q = filter.q.trim();
    const { data } = await toivHttp.get("/apps", { params });
    const list = Array.isArray(data) ? data : ((data as { items?: ToivApp[] })?.items ?? []);
    return list.map((raw) => {
        const a = raw as ToivApp;
        return {
            ...a,
            params_schema: Array.isArray(a.params_schema) ? a.params_schema.map(normalizeToivAppParam) : [],
        };
    });
}

/** 应用详情（含完整 params_schema；运行前必须拉详情） */
export async function fetchToivApp(id: string): Promise<ToivApp> {
    const { data } = await toivHttp.get(`/apps/${encodeURIComponent(id)}`);
    const a = data as ToivApp;
    return {
        ...a,
        params_schema: Array.isArray(a.params_schema) ? a.params_schema.map(normalizeToivAppParam) : [],
    };
}

/** GET /apps/{id}/variants → 模式切换（app_variants.json）；失败返回空 modes */
export async function fetchToivAppVariants(id: string): Promise<ToivAppVariantsInfo> {
    try {
        const { data } = await toivHttp.get(`/apps/${encodeURIComponent(id)}/variants`);
        const raw = (data ?? {}) as Partial<ToivAppVariantsInfo>;
        const modes = Array.isArray(raw.modes)
            ? raw.modes
                .map((m) => ({
                    label: String((m as ToivAppModeItem)?.label ?? "").trim(),
                    desc: String((m as ToivAppModeItem)?.desc ?? ""),
                    app_id: String((m as ToivAppModeItem)?.app_id ?? "").trim(),
                }))
                .filter((m) => m.app_id && m.label)
            : [];
        const presets = Array.isArray(raw.presets)
            ? raw.presets
                .map((p) => {
                    const r = (p ?? {}) as { label?: string; values?: Record<string, unknown> };
                    return {
                        label: String(r.label ?? "").trim(),
                        values: r.values && typeof r.values === "object" ? r.values : {},
                    };
                })
                .filter((p) => p.label)
            : [];
        return {
            keeper_id: String(raw.keeper_id || id),
            keeper_name: String(raw.keeper_name || ""),
            modes,
            presets,
        };
    } catch {
        return { keeper_id: id, keeper_name: "", modes: [], presets: [] };
    }
}

/** POST /apps/{id}/run → job 回执；成功后引导任务中心 */

export type ToivUploadResult = { filename: string; worker: string; workers?: string[]; all_workers?: boolean };

function uploadTimeoutMs(file: File): number {
    const isVideo = /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name) || file.type.startsWith("video/");
    const floor = isVideo || file.size > 50 * 1024 * 1024 ? 600_000 : 60_000;
    const bySize = Math.ceil(file.size / (2 * 1024 * 1024)) * 1000;
    return Math.min(20 * 60_000, Math.max(floor, bySize));
}

/**
 * 市场/能力媒体上传：POST /api/upload（multipart 字段 image）。
 * 返回 {filename, worker} 句柄，供 params images/audio/video 与画布/run 同机接线。
 */
export function uploadToivMedia(
    file: File,
    kind: string = "img2img",
    worker?: string,
    opts?: { onProgress?: (pct: number) => void },
): Promise<ToivUploadResult> {
    return new Promise((resolve, reject) => {
        let qs = `kind=${encodeURIComponent(kind)}`;
        if (worker) qs += `&worker=${encodeURIComponent(worker)}`;
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/upload?${qs}`);
        xhr.timeout = uploadTimeoutMs(file);
        if (typeof window !== "undefined") {
            const token = window.localStorage.getItem(TOKEN_KEY);
            if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        }
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) opts?.onProgress?.(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    resolve(JSON.parse(xhr.responseText) as ToivUploadResult);
                } catch {
                    reject(new Error("上传响应解析失败"));
                }
            } else {
                let msg = `上传失败 (${xhr.status})`;
                try {
                    const detail = JSON.parse(xhr.responseText)?.detail;
                    if (typeof detail === "string" && detail) msg = detail;
                } catch {
                    /* non-JSON */
                }
                reject(new Error(msg));
            }
        };
        xhr.onerror = () => reject(new Error("上传网络错误"));
        xhr.ontimeout = () =>
            reject(new Error(`上传超时(${Math.round(xhr.timeout / 1000)}s)，请检查网络后重试`));
        const fd = new FormData();
        fd.append("image", file);
        xhr.send(fd);
    });
}

export async function runToivApp(id: string, values: Record<string, unknown>): Promise<ToivAppRunReceipt> {
    const { data } = await toivHttp.post(`/apps/${encodeURIComponent(id)}/run`, { values }, { timeout: 60_000 });
    const raw = (data ?? {}) as Record<string, unknown>;
    return {
        job_id: String(raw.job_id ?? ""),
        prompt_id: String(raw.prompt_id ?? ""),
        client_id: raw.client_id != null ? String(raw.client_id) : undefined,
        worker: raw.worker != null ? String(raw.worker) : undefined,
    };
}

export type ToivBoardItemJob = {
    id: string;
    kind?: string;
    status: string;
    prompt?: string;
    created_at: string;
    results?: string[];
    post_status?: string;
    /** 变体折叠键（主站 _job_dict）；缺省不参与变体组 */
    seed?: number | null;
    /** 内容分组（360° 等同批）；空串=无 */
    batch_id?: string;
    parent_id?: string;
    root_id?: string;
    error?: string;
};

export type ToivBoardItem = {
    id: number;
    sort_order: number;
    note?: string;
    shot_text?: string;
    shot_meta?: string;
    job: ToivBoardItemJob | null;
};

export type ToivDeleteJobResult = {
    undo_token?: string;
    undo_ttl?: number;
};

export type ToivTrashJob = ToivBoardItemJob & {
    deleted_at: string;
    restore_expires_at: string;
    restore_remaining_seconds: number;
};

/** 改名/描述/封面（PATCH /boards/{id}）。 */
export async function patchBoard(
    boardId: string,
    body: { name?: string; description?: string; cover_job_id?: string; sort?: number },
): Promise<ToivBoard> {
    const { data } = await toivHttp.patch(`/boards/${boardId}`, body);
    return data as ToivBoard;
}

/** 整板导出 drama_studio JSON（供本机下载）。 */
export async function exportBoardJson(boardId: string): Promise<{ filename: string; doc: unknown }> {
    const { data, headers } = await toivHttp.get(`/boards/${boardId}/export`);
    const cd = String(headers?.["content-disposition"] ?? headers?.["Content-Disposition"] ?? "");
    const m = /filename\*=UTF-8''([^;]+)|filename=([^;]+)/i.exec(cd);
    let filename = "board.drama_studio.json";
    if (m) {
        try {
            filename = decodeURIComponent((m[1] || m[2] || filename).replace(/"/g, "").trim());
        } catch {
            filename = (m[1] || m[2] || filename).replace(/"/g, "").trim() || filename;
        }
    }
    return { filename, doc: data };
}

/** 删板（级联成员行；不删成员作业本身）。 */
export async function deleteBoard(boardId: string): Promise<void> {
    await toivHttp.delete(`/boards/${boardId}`);
}

/** 整组替换板成员（增删+重排；job_id 空=占位行）。返回成员数。 */
export async function putBoardItems(
    boardId: string,
    items: Array<{ job_id?: string; note?: string; shot_text?: string; shot_meta?: string }>,
): Promise<number> {
    const { data } = await toivHttp.put(`/boards/${boardId}/items`, { items });
    return Number((data as { item_count?: number })?.item_count ?? items.length);
}

/** 软删作业入回收站（72h 可恢复）。 */
export async function deleteJob(jobId: string): Promise<ToivDeleteJobResult> {
    const { data } = await toivHttp.delete(`/jobs/${jobId}`);
    return (data ?? {}) as ToivDeleteJobResult;
}

export async function undoDeleteJob(undoToken: string): Promise<void> {
    await toivHttp.post(`/undo/${undoToken}`);
}

export async function fetchTrash(offset = 0, limit = 200): Promise<ToivTrashJob[]> {
    const { data } = await toivHttp.get("/jobs/trash", { params: { offset, limit } });
    return Array.isArray(data) ? (data as ToivTrashJob[]) : ((data as { items?: ToivTrashJob[] })?.items ?? []);
}

export async function restoreJob(jobId: string): Promise<void> {
    await toivHttp.post(`/jobs/${jobId}/restore`);
}

export async function permanentDeleteJob(jobId: string): Promise<void> {
    await toivHttp.delete(`/jobs/${jobId}/permanent`);
}

/** 批量软删（变体组整组移入回收站）。 */
export async function bulkDeleteJobs(ids: readonly string[]): Promise<{
    ok: boolean;
    done: Array<{ id: string; undo_token?: string }>;
    failed: string[];
}> {
    const { data } = await toivHttp.post("/jobs/bulk-delete", { ids: [...ids] });
    return data as { ok: boolean; done: Array<{ id: string; undo_token?: string }>; failed: string[] };
}

export type ToivDramaProject = {
    id: string;
    title?: string;
    premise?: string;
    style?: string;
    status: string;
    width?: number;
    height?: number;
    fps?: number;
    render_mode_default?: string;
    final_url?: string;
    updated_at?: string;
    pipeline?: {
        total_shots: number;
        by_status: Record<string, number>;
        next_step?: { step: string; label: string; todo: number };
    } | null;
};

export async function fetchDramaProjects(): Promise<ToivDramaProject[]> {
    const { data } = await toivHttp.get("/studio/projects");
    return Array.isArray(data) ? data : ((data as { items?: ToivDramaProject[] })?.items ?? []);
}

export type ToivDramaCharacter = {
    id: string;
    name?: string;
    description?: string;
    visual_prompt?: string;
    voice_ref_url?: string;
    reference_images?: string[];
    reference_images_by_style?: Record<string, string[]>;
};

export type ToivDramaShotCandidate = {
    id: string;
    url?: string;
    seed?: number;
    status?: string;
    is_picked?: boolean;
    error?: string;
};

export type ToivDramaShot = {
    id: string;
    idx: string | number;
    status: string;
    /** S9:PUT shots 全量保存回传所需(后端 ShotInput 契约字段) */
    negative?: string;
    characters?: string[];
    scene?: string;
    prompt?: string;
    dialogue?: string;
    speaker?: string;
    camera?: string;
    duration_sec?: number;
    render_mode?: string;
    image_url?: string;
    video_url?: string;
    voice_url?: string;
    final_clip_url?: string;
    error?: string;
    /** S4:多候选(candidates_json 透出)与 seam 衔接策略 */
    candidates?: ToivDramaShotCandidate[];
    seam_to_next?: string;
    seam_anchor?: string;
};

export type ToivDramaDetail = ToivDramaProject & {
    characters?: ToivDramaCharacter[];
    shots?: ToivDramaShot[];
};

export async function fetchDramaProject(pid: string): Promise<ToivDramaDetail> {
    const { data } = await toivHttp.get(`/studio/projects/${pid}`);
    return data as ToivDramaDetail;
}

export async function triggerShotRender(shotId: string): Promise<boolean> {
    try { await toivHttp.post(`/studio/shots/${shotId}/render`, undefined, { timeout: 3600_000 }); return true; }
    catch { return false; }
}

export async function triggerBatchRender(pid: string): Promise<boolean> {
    try { await toivHttp.post(`/studio/projects/${pid}/render`, undefined, { timeout: 3600_000 }); return true; }
    catch { return false; }
}

export async function triggerShotVoice(shotId: string): Promise<boolean> {
    try { await toivHttp.post(`/studio/shots/${shotId}/voice`, undefined, { timeout: 600_000 }); return true; }
    catch { return false; }
}

export async function triggerShotLipsync(shotId: string): Promise<boolean> {
    try { await toivHttp.post(`/studio/shots/${shotId}/lipsync`, undefined, { timeout: 1800_000 }); return true; }
    catch { return false; }
}

export type ToivCharacterSheet = {
    style: string;
    sheet_url: string;
    /** 分格图:键为 portrait/front/side/back 等(后端键值对象,非数组) */
    panel_urls?: Record<string, string>;
    mtime?: string | number;
};

export async function fetchCharacterSheets(cid: string): Promise<ToivCharacterSheet[]> {
    const { data } = await toivHttp.get(`/studio/characters/${cid}/character-sheets`);
    const list = (data as { sheets?: ToivCharacterSheet[] })?.sheets ?? [];
    return Array.isArray(list) ? list : [];
}

export async function triggerSheetRegen(cid: string, style: string): Promise<boolean> {
    try {
        await toivHttp.post(`/studio/characters/${cid}/character-sheet`, { style }, { timeout: 3600_000 });
        return true;
    } catch { return false; }
}

export async function triggerPanelReplace(cid: string, style: string, key: string, imageB64: string): Promise<boolean> {
    try {
        await toivHttp.post(`/studio/characters/${cid}/character-sheet/panel-replace`, { style, key, image_b64: imageB64 }, { timeout: 600_000 });
        return true;
    } catch { return false; }
}


/** POST /studio/c-chains → 202；首版仅 start.type=makeup */
export async function createCChain(body: ToivCChainCreateBody): Promise<ToivCChainJobAck> {
    assertCChainMakeupOnly(body.start);
    const payload: ToivCChainCreateBody = {
        pipeline: body.pipeline ?? "c_hybrid",
        aspect_ratio: "9:16",
        ...body,
        start: { type: "makeup", video_url: body.start?.video_url, job_id: body.start?.job_id },
    };
    const { data } = await toivHttp.post("/studio/c-chains", payload, {
        timeout: 30_000,
        validateStatus: (s) => s === 202 || (s >= 200 && s < 300),
    });
    return data as ToivCChainJobAck;
}

export async function appendCChainSegments(
    chainId: string,
    body: {
        segments: ToivCChainSegmentIn[];
        num_candidates?: number;
        keep_audio?: boolean;
        auto_assemble?: boolean;
        seed?: number;
        outfit_desc?: string;
        worker_url?: string;
        from_segment?: number;
        confirm_discard?: boolean;
    },
): Promise<ToivCChainJobAck> {
    const { data } = await toivHttp.post(`/studio/c-chains/${chainId}/segments`, body, {
        timeout: 30_000,
        validateStatus: (s) => s === 202 || (s >= 200 && s < 300),
    });
    return data as ToivCChainJobAck;
}

export async function fetchCChain(chainId: string): Promise<ToivCChainDetail> {
    const { data } = await toivHttp.get(`/studio/c-chains/${chainId}`);
    return data as ToivCChainDetail;
}

export async function pickCChainSegment(
    chainId: string,
    segIndex: number,
    candidateId: string,
    rerenderAfter = false,
): Promise<ToivCChainDetail> {
    const { data } = await toivHttp.post(
        `/studio/c-chains/${chainId}/segments/${segIndex}/pick`,
        { candidate_id: candidateId, rerender_after: rerenderAfter },
    );
    return data as ToivCChainDetail;
}

/** W0.2b(2026-10-11 S1):分页取应用——/api/apps limit/offset 已实装,总数走 X-Total-Count。
 * 与 fetchToivApps 的区别:带 offset、返回 {items,total} 供「加载更多」UI 用。 */
export async function fetchToivAppsPage(
    filter: { limit?: number; offset?: number; category?: string; q?: string } = {},
): Promise<{ items: ToivApp[]; total: number }> {
    const params: Record<string, string | number> = { limit: filter.limit ?? 200 };
    if (filter.offset) params.offset = filter.offset;
    if (filter.category && filter.category !== "all") params.category = filter.category;
    if (filter.q?.trim()) params.q = filter.q.trim();
    const resp = await toivHttp.get("/apps", { params });
    const data = resp.data;
    const list = Array.isArray(data) ? data : ((data as { items?: ToivApp[] })?.items ?? []);
    const total = Number(resp.headers?.["x-total-count"] ?? list.length) || list.length;
    return {
        total,
        items: list.map((raw) => {
            const a = raw as ToivApp;
            return {
                ...a,
                params_schema: Array.isArray(a.params_schema)
                    ? a.params_schema.map(normalizeToivAppParam)
                    : [],
            };
        }),
    };
}

// ---- W2.1(2026-10-11): 剧本→分镜自动化(后端 studio 域既有异步链路接线) ----

export type ToivParsedCharacter = { name?: string; description?: string; visual_prompt?: string };
export type ToivParsedShot = {
    id?: string;
    scene?: string;
    prompt?: string;
    negative?: string;
    camera?: string;
    dialogue?: string;
    speaker?: string;
    duration_sec?: number;
    characters?: string[];
    render_mode?: string;
};

/** POST /studio/projects/{pid}/script/parse → {job_id, status:"queued"}(LLM 后台拆解) */
export async function submitScriptParse(
    pid: string,
    premise: string,
    opts: { num_shots?: number; style?: string } = {},
): Promise<{ job_id: string; status: string }> {
    const { data } = await toivHttp.post(
        `/studio/projects/${encodeURIComponent(pid)}/script/parse`,
        { premise, num_shots: opts.num_shots ?? 8, style: opts.style ?? "" },
        { timeout: 30_000 },
    );
    return data;
}

/** GET /studio/projects/{pid}/script/parse/{job_id} → done 时带 characters/shots */
export async function pollScriptParse(
    pid: string,
    jobId: string,
): Promise<{ status: string; characters?: ToivParsedCharacter[]; shots?: ToivParsedShot[]; error?: string }> {
    const { data } = await toivHttp.get(
        `/studio/projects/${encodeURIComponent(pid)}/script/parse/${encodeURIComponent(jobId)}`,
        { timeout: 15_000 },
    );
    return data;
}

/** PUT /studio/projects/{pid}/shots —— 全量替换语义(拆解结果确认落库) */
export async function saveStudioShots(pid: string, shots: ToivParsedShot[]): Promise<void> {
    await toivHttp.put(`/studio/projects/${encodeURIComponent(pid)}/shots`, { shots }, { timeout: 30_000 });
}

/** POST /studio/projects/{pid}/characters(拆解出的新角色入库) */
export async function createStudioCharacter(
    pid: string,
    character: ToivParsedCharacter,
): Promise<void> {
    await toivHttp.post(
        `/studio/projects/${encodeURIComponent(pid)}/characters`,
        { name: character.name || "未命名", description: character.description || "", visual_prompt: character.visual_prompt || "" },
        { timeout: 15_000 },
    );
}

/** PATCH /studio/projects/{pid}(剧本正文保存) */
export async function patchStudioProject(pid: string, patch: { premise?: string; style?: string }): Promise<void> {
    await toivHttp.patch(`/studio/projects/${encodeURIComponent(pid)}`, patch, { timeout: 15_000 });
}

/** W1.3(2026-10-11):严格版设定卡生成——失败抛错(带后端 detail),供工作区透出;
 * 旧 triggerSheetRegen 吞错返回 boolean 的行为保留(drama-detail 既有契约)。 */
export async function generateCharacterSheetStrict(cid: string, style: string): Promise<void> {
    try {
        await toivHttp.post(`/studio/characters/${encodeURIComponent(cid)}/character-sheet`, { style }, { timeout: 3600_000 });
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "设定卡生成失败(可能未过内部质检门禁,可重试)");
    }
}

/** W1.4(2026-10-11):严格版单镜渲染——失败抛错带 detail(缺参考图等前置问题可见);
 * 旧 triggerShotRender 吞错 boolean 保留(drama-detail 契约)。 */
export async function renderShotStrict(sid: string, opts: { num_candidates?: number } = {}): Promise<void> {
    try {
        await toivHttp.post(
            `/studio/shots/${encodeURIComponent(sid)}/render`,
            opts.num_candidates ? { num_candidates: opts.num_candidates, wait: true } : undefined,
            { timeout: 3600_000 },
        );
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "渲染失败");
    }
}

/** S9-lite(2026-10-11):拼接全部就绪分镜 → 项目成片(POST /studio/projects/{pid}/assemble)。
 * 任一镜缺 final_clip_url → 422(错误透出)。 */
export async function assembleStudioProject(pid: string): Promise<void> {
    try {
        await toivHttp.post(`/studio/projects/${encodeURIComponent(pid)}/assemble`, undefined, { timeout: 600_000 });
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "成片合成失败");
    }
}

/** S4-b(2026-10-11):异步单镜渲染——wait=false 登记 Job 即回(管线C阶段B机制);
 * 同步等待撞 reload/断连=状态僵死(实测),一律走此路。 */
export async function renderShotAsync(sid: string, opts: { num_candidates?: number } = {}): Promise<{ job_id: string }> {
    try {
        const { data } = await toivHttp.post(
            `/studio/shots/${encodeURIComponent(sid)}/render`,
            { num_candidates: opts.num_candidates ?? 2, wait: false },
            { timeout: 30_000, validateStatus: (st) => st === 202 || (st >= 200 && st < 300) },
        );
        return data as { job_id: string };
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "渲染提交失败");
    }
}

/** S4:选用候选视频为该镜成片(POST /studio/shots/{sid}/candidates/{cid}/pick) */
export async function pickShotCandidate(sid: string, cid: string): Promise<void> {
    try {
        await toivHttp.post(`/studio/shots/${encodeURIComponent(sid)}/candidates/${encodeURIComponent(cid)}/pick`, undefined, { timeout: 30_000 });
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "选用候选失败");
    }
}

/** PATCH /studio/characters/{cid}——设定卡分格采用为参考图。
 * char_panel_* URL 受后端 12:01 风格守卫约束:必须显式带 allowed_panel_styles(非 ORM 守卫字段),
 * 否则 422「未显式匹配风格」。 */
export async function adoptSheetAsReference(cid: string, style: string, urls: string[]): Promise<void> {
    try {
        await toivHttp.patch(
            `/studio/characters/${encodeURIComponent(cid)}`,
            { reference_images: urls.slice(0, 8), allowed_panel_styles: [style] },
            { timeout: 15_000 },
        );
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "参考图写入失败");
    }
}

// ---- S3-b(2026-10-11): 设定卡生成异步化(15-20min 同步等待是 UX/可靠性雷) ----

/** POST /studio/characters/{cid}/character-sheet/async → {job_id, status:"queued"} */
export async function submitSheetAsync(cid: string, style: string): Promise<{ job_id: string; status: string }> {
    const { data } = await toivHttp.post(
        `/studio/characters/${encodeURIComponent(cid)}/character-sheet/async`,
        { style },
        { timeout: 30_000 },
    );
    return data;
}

/** GET /studio/characters/{cid}/character-sheet/async/{job_id} → done 时带 sheet_url/panel_urls */
export async function pollSheetJob(
    cid: string,
    jobId: string,
): Promise<{ status: string; sheet_url?: string; panel_urls?: Record<string, string>; error?: string }> {
    const { data } = await toivHttp.get(
        `/studio/characters/${encodeURIComponent(cid)}/character-sheet/async/${encodeURIComponent(jobId)}`,
        { timeout: 15_000 },
    );
    return data;
}

// ---- W2.2(2026-10-11): 多视角分镜扩展(单角色参考图→远/中/近景别示意图,异步 Job) ----

export type ToivFrameVariant = { scale: string; url: string };

export async function submitFrameVariants(sid: string, style: "anime" | "ancient_realistic" = "anime"): Promise<{ job_id: string; status: string }> {
    const { data } = await toivHttp.post(
        `/studio/shots/${encodeURIComponent(sid)}/frame-variants`,
        { style },
        { timeout: 30_000 },
    );
    return data;
}

export async function pollFrameVariants(sid: string, jobId: string): Promise<{ status: string; variants?: ToivFrameVariant[]; error?: string }> {
    const { data } = await toivHttp.get(
        `/studio/shots/${encodeURIComponent(sid)}/frame-variants/${encodeURIComponent(jobId)}`,
        { timeout: 15_000 },
    );
    return data;
}

// ---- S6(2026-10-11): 共享资产库(DramaAsset 跨项目,只读+选用为项目角色) ----

export type ToivSharedAsset = {
    id: string;
    kind: string;
    name?: string;
    description?: string;
    visual_prompt?: string;
    ref_image?: string;
    voice_name?: string;
};

export async function fetchSharedAssets(kind?: string): Promise<ToivSharedAsset[]> {
    const { data } = await toivHttp.get("/studio/assets", { params: kind ? { kind } : {} });
    return Array.isArray(data) ? data : [];
}

export async function applySharedAsset(aid: string, pid: string): Promise<void> {
    try {
        await toivHttp.post(`/studio/assets/${encodeURIComponent(aid)}/apply-to-project/${encodeURIComponent(pid)}`, undefined, { timeout: 15_000 });
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "选用资产失败");
    }
}

// ---- S9(2026-10-11): 字幕对齐(台词↔whisper 时间轴,SRT 内嵌/外挂双出) ----

export async function buildSubtitles(pid: string): Promise<{ srt_url: string; cues: Array<{ start: number; end: number; text: string }>; shots_covered: number; total_duration: number }> {
    try {
        const { data } = await toivHttp.post(`/studio/projects/${encodeURIComponent(pid)}/subtitles`, undefined, { timeout: 180_000 });
        return data;
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "字幕生成失败");
    }
}

export async function burnSubtitles(pid: string): Promise<{ video_url: string; srt_url: string; shots_covered: number }> {
    try {
        const { data } = await toivHttp.post(`/studio/projects/${encodeURIComponent(pid)}/subtitles/burn`, undefined, { timeout: 300_000 });
        return data;
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "字幕内嵌失败");
    }
}

/** S11(2026-10-11): 严格版对口型(LatentSync 产物覆盖 final_clip;错误透出,旧 trigger 吞错保留) */
export async function lipsyncShotStrict(sid: string): Promise<void> {
    try {
        await toivHttp.post(`/studio/shots/${encodeURIComponent(sid)}/lipsync`, undefined, { timeout: 1800_000 });
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "对口型失败");
    }
}

// ---- F3(2026-10-11):从图片创建(自经典 animatic 迁入 v2 域) ----

/** POST /studio/projects/from-image(异步):VLM 解析→建 StudioProject+角色+分镜。 */
export async function submitStudioFromImage(form: {
    images: File[];
    hint?: string;
    style?: string;
    numShots?: number;
}): Promise<{ job_id: string; status: string }> {
    const fd = new FormData();
    for (const f of form.images) fd.append("images", f);
    if (form.hint) fd.append("hint", form.hint);
    if (form.style) fd.append("style", form.style);
    fd.append("num_shots", String(form.numShots ?? 8));
    const { data } = await toivHttp.post("/studio/projects/from-image", fd, { timeout: 60_000 });
    return data;
}

export interface StudioFromImageDone {
    status: "done";
    project_id: string;
    title: string;
    shot_count: number;
    character_count: number;
    warnings?: string[];
}

export async function pollStudioFromImage(jobId: string): Promise<
    | { status: "queued" | "running" }
    | (StudioFromImageDone & { status: "done" })
    | { status: "error" | "canceled"; error: string }
> {
    const { data } = await toivHttp.get(`/studio/projects/from-image/${encodeURIComponent(jobId)}`);
    return data;
}

/** 快速拼接(经典 /api/animatic 小工具直通):图片+每镜时长 → 直接出片。 */
export interface AnimaticStitchResult {
    job_id: string;
    url: string;
    count: number;
    duration: number;
    fps: number;
    width: number;
    height: number;
}

export async function createAnimaticStitch(form: {
    images: File[];
    durations: number[];
    fps?: number;
    width?: number;
    height?: number;
}): Promise<AnimaticStitchResult> {
    const fd = new FormData();
    for (const f of form.images) fd.append("images", f);
    fd.append("durations", JSON.stringify(form.durations));
    fd.append("fps", String(form.fps ?? 16));
    fd.append("width", String(form.width ?? 1920));
    fd.append("height", String(form.height ?? 1080));
    const { data } = await toivHttp.post("/animatic", fd, { timeout: 300_000 });
    return data;
}

// ---- F4(2026-10-11):音频工具(自经典 AudioView 编辑三工具迁入) ----

export interface VoiceSynthResult {
    url: string;
    name: string;
    duration_sec: number;
}

/** POST /api/manju/voice:文本 → IndexTTS2 语音;refAudioUrl 传参考音则克隆音色。 */
export async function synthVoice(body: { text: string; emo_text?: string; emo_alpha?: number; ref_audio_url?: string }): Promise<VoiceSynthResult> {
    const { data } = await toivHttp.post("/manju/voice", body, { timeout: 180_000 });
    return data;
}

/** POST /api/manju/voice-ref multipart(audio):参考音上传(ffmpeg 归一为 wav)。 */
export async function uploadVoiceRefAudio(file: File): Promise<VoiceSynthResult> {
    const fd = new FormData();
    fd.append("audio", file);
    const { data } = await toivHttp.post("/manju/voice-ref", fd, { timeout: 120_000 });
    return data;
}

export interface DubSegment {
    index: number;
    start: number;
    end: number;
    text: string;
}

export interface DubTranscribeStatus {
    status: "running" | "done" | "error" | "canceled";
    stage: string;
    count: number;
    segments: DubSegment[];
    error: string | null;
    progress: number;
    elapsed: number;
}

/** POST /api/dub/upload multipart(video):长音视频流式落盘(带上传进度)。 */
export async function uploadDubMedia(file: File, onProgress?: (pct: number) => void): Promise<{ name: string }> {
    const fd = new FormData();
    fd.append("video", file);
    const { data } = await toivHttp.post("/dub/upload", fd, {
        timeout: 600_000,
        onUploadProgress: (e) => {
            if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
        },
    });
    return data;
}

/** POST /api/dub/transcribe {name} → {job_id}(后台 whisper 听写)。 */
export async function startDubTranscribe(name: string): Promise<{ job_id: string }> {
    const { data } = await toivHttp.post("/dub/transcribe", { name }, { timeout: 30_000 });
    return data;
}

export async function pollDubTranscribe(jobId: string): Promise<DubTranscribeStatus> {
    const { data } = await toivHttp.get(`/dub/transcribe/${encodeURIComponent(jobId)}`, { timeout: 30_000 });
    return data;
}

export interface AudioSeparateResult {
    url: string;
    duration_sec: number | null;
}

/** POST /api/audio/separate multipart(file):Demucs 人声分离 → 干声 wav。 */
export async function separateAudioFile(file: File): Promise<AudioSeparateResult> {
    const fd = new FormData();
    fd.append("file", file);
    const { data } = await toivHttp.post("/audio/separate", fd, { timeout: 180_000 });
    return data;
}

// ---- F5(2026-10-11):图片工具(自经典 ImageEditView 七工具迁入) ----

export interface UploadImageHandle {
    filename: string;
    worker: string;
}

/** POST /api/upload?kind=…(multipart file):上传源图,返回文件名+worker 句柄。 */
export async function uploadToivImage(file: File, kind = "img2img"): Promise<UploadImageHandle> {
    const fd = new FormData();
    fd.append("image", file);
    const { data } = await toivHttp.post(`/upload?kind=${encodeURIComponent(kind)}`, fd, { timeout: 300_000 });
    return data;
}

export interface GenAck {
    prompt_id: string;
    worker: string;
    kind?: string;
}

const genPost = async <T,>(path: string, body: Record<string, unknown>): Promise<T> => {
    const { data } = await toivHttp.post(path, body, { timeout: 60_000 });
    return data;
};

/** 智能去背景(mode: general/anime/human)。 */
export const generateRemoveBg = (p: { image: string; worker: string; mode?: string }) =>
    genPost<GenAck>("/generate/removebg", { ...p, mode: p.mode ?? "general" });

/** 高清增强(scale 2/4)。 */
export const generateUpscale = (p: { image: string; worker: string; scale?: number }) =>
    genPost<GenAck>("/generate/upscale", { ...p, scale: p.scale ?? 2 });

/** 局部重绘(target=文字描述要修改的区域)。 */
export const generateInpaint = (p: { image: string; worker: string; target: string; positive: string; negative?: string }) =>
    genPost<GenAck>("/generate/inpaint", p);

/** 人脸修复。 */
export const generateFaceDetailer = (p: { image: string; worker: string; denoise?: number }) =>
    genPost<GenAck>("/generate/facedetailer", { ...p, denoise: p.denoise ?? 0.6 });

/** 智能编辑 Qwen(语义编辑+相机控制)。 */
export const generateQwenEdit = (p: {
    image: string; worker: string; positive?: string; camera?: string;
    azimuth?: number; elevation?: number; distance?: string; fast?: boolean;
}) => genPost<GenAck>("/generate/qwen-edit", { ...p, fast: p.fast ?? true });

/** 图生 3D(Hunyuan3D → GLB)。 */
export const generate3DModel = (p: { image: string; worker: string; steps?: number; cfg?: number; octree_resolution?: number; seed?: number }) =>
    genPost<GenAck>("/generate/3d", { ...p, steps: p.steps ?? 30, cfg: p.cfg ?? 5.0, octree_resolution: p.octree_resolution ?? 256 });

/** 生成作业轮询:按 prompt_id 在本人最近作业里找状态与产物(results=签名 URL 数组)。 */
export async function pollGenJob(promptId: string, limit = 30): Promise<{ status: string; results: string[]; hold_reason?: string } | null> {
    const { data } = await toivHttp.get("/jobs", { params: { limit }, timeout: 30_000 });
    const rows = Array.isArray(data) ? data : [];
    const job = rows.find((j: { prompt_id?: string }) => j.prompt_id === promptId);
    if (!job) return null;
    return { status: String(job.status ?? ""), results: Array.isArray(job.results) ? job.results : [], hold_reason: job.hold_reason };
}

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
    reference_images_by_style?: Record<string, string[]>;
};

export type ToivDramaShot = {
    id: string;
    idx: string | number;
    status: string;
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
    panel_urls?: string[];
    mtime?: string;
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

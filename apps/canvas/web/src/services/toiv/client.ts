import axios from "axios";

import { assertAxiosOutboundAllowed } from "@/lib/outbound-host-allowlist";
import { SheetGateJobError, sheetFailureFromJobResult } from "./sheet-gate-failure";

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
import { nsfwHeaderEnabled } from "@/services/toiv/r18-mode";

const TOKEN_KEY = "toiv_token";

export const toivHttp = axios.create({ baseURL: "/api", timeout: 15_000 });

toivHttp.interceptors.request.use((config) => {
    assertAxiosOutboundAllowed(config);
    if (typeof window !== "undefined") {
        const token = window.localStorage.getItem(TOKEN_KEY);
        if (token) config.headers.Authorization = `Bearer ${token}`;
        // D-U1:R18 开启时附加 X-NSFW（仅审计携带）；403/放行以账号 content_mode 为准，不看请求头
        if (nsfwHeaderEnabled()) {
            config.headers["X-NSFW"] = "1";
        }
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

export type ToivJobProgress = {
    pct: number | null;
    step?: number | null;
    total?: number | null;
    queue_pos?: number | null;
    updated_at?: number | null;
    phase?: string;
    phase_label?: string;
};

export type ToivJobRuntime = {
    state: "fresh" | "watch" | "stalled" | "waiting" | "terminal" | "unknown";
    label: string;
    reason: string;
    last_evidence_at: number | null;
    age_seconds: number | null;
    evidence: "progress_snapshot" | "created_at" | "terminal" | "none";
};

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
    progress?: ToivJobProgress;
    results?: string[];
    runtime?: ToivJobRuntime;
    /** Wave P2:Studio 作业回跳短剧工作区 */
    project_id?: string;
};

export async function fetchJobs(limit = 100): Promise<ToivJob[]> {
    const { data } = await toivHttp.get("/jobs", { params: { limit } });
    return extractWorkJobList(data) as ToivJob[];
}

export async function fetchJobById(jobId: string): Promise<ToivJob> {
    const { data } = await toivHttp.get("/jobs/lookup", { params: { job_id: jobId } });
    return data as ToivJob;
}

export async function cancelJob(jobId: string): Promise<boolean> {
    try {
        await toivHttp.post(`/jobs/${jobId}/cancel`);
        return true;
    } catch {
        return false;
    }
}

/** 作品库作业面(SFW):主站 /api/jobs 分页契约与 apps/web fetchJobsPage 同口径。
 *  P-11:分页失败必须抛错,不得吞成空数组——吞了就会把「没拉到」显示成「作品库是空的」。 */
export type ToivWorkJob = {
    id: string;
    prompt_id: string;
    kind: string;
    status: string;
    prompt: string;
    created_at: string;
    results: string[];
    nsfw?: boolean;
    error?: string | null;
    post_status?: string;
    app_name?: string;
    has_params?: boolean;
    batch_id?: string;
    meta?: { width?: number; height?: number; steps?: number; duration_hint?: number };
};

/** P-11:列表响应非数组/非信封对象=异常(如 200 的错误页),必须抛错,禁止静默空集当「没有作业」。 */
function extractWorkJobList(data: unknown): ToivWorkJob[] {
    if (Array.isArray(data)) return data as ToivWorkJob[];
    if (data && typeof data === "object") {
        const items = (data as { items?: unknown }).items;
        if (Array.isArray(items)) return items as ToivWorkJob[];
    }
    throw new Error("作业列表响应形状异常(非数组/非 items 信封)");
}

export type ToivWorksPage = { items: ToivWorkJob[]; offset: number; hasMore: boolean };

export async function fetchToivWorksPage(opts: {
    limit?: number;
    offset?: number;
    kind?: string;
}): Promise<ToivWorksPage> {
    const limit = opts.limit ?? 60;
    const offset = opts.offset ?? 0;
    const { data } = await toivHttp.get("/jobs", {
        params: { limit, offset, ...(opts.kind ? { kind: opts.kind } : {}) },
        timeout: 45_000,
    });
    const items = extractWorkJobList(data);
    return { items, offset, hasMore: items.length >= limit };
}

export async function fetchToivWorkCounts(kind?: string): Promise<Record<string, number>> {
    const { data } = await toivHttp.get("/jobs/counts", {
        params: kind ? { kind } : {},
        timeout: 45_000,
    });
    return (data ?? {}) as Record<string, number>;
}

export async function fetchToivTrashPage(opts: { limit?: number; offset?: number }): Promise<ToivWorkJob[]> {
    const { data } = await toivHttp.get("/jobs/trash", {
        params: { limit: opts.limit ?? 100, offset: opts.offset ?? 0 },
        timeout: 45_000,
    });
    return extractWorkJobList(data);
}

export async function deleteToivWork(jobId: string): Promise<void> {
    await toivHttp.delete(`/jobs/${encodeURIComponent(jobId)}`);
}

export async function restoreToivWork(jobId: string): Promise<void> {
    await toivHttp.post(`/jobs/${encodeURIComponent(jobId)}/restore`);
}

export async function rerunToivWork(jobKey: string): Promise<boolean> {
    try {
        await toivHttp.post(`/jobs/${encodeURIComponent(jobKey)}/rerun`);
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
    applyMarketConvenienceChange,
    asMarketMediaList,
    buildDefaultRunValues,
    buildToivRunValues,
    firstPinWorker,
    h3LengthFromSeconds,
    enrichMarketSchemaWithDeepParams,
    isMarketConvenienceKey,
    isMarketCoreParam,
    isMarketDeepParam,
    isRemoteDemoMedia,
    ltxFramesFromSeconds,
    marketAppSupportsLoras,
    marketAppSupportsResolutionTarget,
    marketConvenienceParams,
    mediaFilenames,
    mergeMarketModeChips,
    normalizeToivAppParam,
    parseResolutionPreset,
    requiredToivParamLabel,
    marketRunValidation,
    splitMarketRunParams,
    splitMarketRunParamsWithConvenience,
    MARKET_EXTENSION_SHORTCUTS,
} from "./market-run";
export type { MarketModeChip } from "./market-run";
import { normalizeToivAppParam, type ToivAppParam } from "./market-run";
import {
    normalizeContentModeFields,
    type ContentMode,
} from "@/redline";


export { toivCoverImageUrl } from "./cover-url";
export type { ContentMode } from "@/redline";
export {
    CLASSIC_NSFW_TO_MARKET,
    appIsPureNsfw,
    appShowsR18Badge,
    appVisibleForContentMode,
    canShowContentModeToggle,
    normalizeContentModes,
    resolveSubmitContentMode,
} from "@/redline";


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
    /** R18 目录应用(后端 is_nsfw);无 X-NSFW 时列表不可见 */
    is_nsfw?: boolean;
    /** ["sfw"] | ["nsfw"] | ["sfw","nsfw"] — 双模=孪生父卡 */
    content_modes?: ContentMode[];
    /** SFW 父卡指向软隐藏 R18 twin */
    nsfw_variant_id?: string | null;
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
    return list.map((raw) => normalizeToivApp(raw));
}

function normalizeToivApp(raw: unknown): ToivApp {
    const a = (raw ?? {}) as ToivApp;
    const base = normalizeContentModeFields({
        ...a,
        params_schema: Array.isArray(a.params_schema) ? a.params_schema.map(normalizeToivAppParam) : [],
    });
    return base;
}

/** 应用详情（含完整 params_schema；运行前必须拉详情） */
export async function fetchToivApp(id: string): Promise<ToivApp> {
    const { data } = await toivHttp.get(`/apps/${encodeURIComponent(id)}`);
    return normalizeToivApp(data);
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

export async function runToivApp(
    id: string,
    values: Record<string, unknown>,
    opts?: { content_mode?: ContentMode },
): Promise<ToivAppRunReceipt> {
    const body: Record<string, unknown> = { values };
    if (opts?.content_mode === "sfw" || opts?.content_mode === "nsfw") {
        body.content_mode = opts.content_mode;
    }
    const { data } = await toivHttp.post(`/apps/${encodeURIComponent(id)}/run`, body, { timeout: 60_000 });
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
    /** Wave P2:项目默认视频管线(持久化) */
    preferred_pipeline?: "ref2va" | "c" | "c_hybrid";
    /** F1：分镜驱动默认 keyframe；direct=专家旁路 */
    preferred_drive_mode?: "keyframe" | "direct";
    /** F3：合成声床 */
    bgm_url?: string;
    bgm_volume?: number;
    bgm_duck?: boolean;
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

/** Wave P1 / N3: 空白新建短剧 → POST /studio/projects，进 /toiv/ws/:id */
export async function createStudioProject(input?: {
    title?: string;
    premise?: string;
    style?: string;
}): Promise<ToivDramaProject> {
    const { data } = await toivHttp.post("/studio/projects", {
        title: (input?.title ?? "").trim() || "未命名短剧",
        premise: input?.premise ?? "",
        style: input?.style ?? "",
    });
    return data as ToivDramaProject;
}

/** Wave P1 / D8: 幂等种子「雨夜」示例短剧 */
export async function seedRainNightSample(): Promise<{
    id: string;
    title?: string;
    created?: boolean;
    assets_ready?: boolean;
    asset_notes?: string[];
}> {
    const { data } = await toivHttp.post("/studio/sample-projects/rain-night");
    const body = data as Record<string, unknown>;
    const id = String(body.id ?? (body.project as { id?: string } | undefined)?.id ?? "");
    if (!id) throw new Error("雨夜示例未返回项目 id");
    return {
        id,
        title: typeof body.title === "string" ? body.title : undefined,
        created: Boolean(body.created),
        assets_ready: typeof body.assets_ready === "boolean" ? body.assets_ready : undefined,
        asset_notes: Array.isArray(body.asset_notes) ? (body.asset_notes as string[]) : undefined,
    };
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

/** FU1 词锚拍(hypit):一拍内台词 + 附着 cue/锚词 */
export type ToivBeat = {
    text?: string;
    cues?: string[];
    anchor_words?: string;
    kind?: "v" | "d";
    block?: number;
};

export type ToivProjectedBeat = ToivBeat & {
    start_sec: number;
    end_sec: number;
    est_sec: number;
};

export type ToivReflowResult = {
    id: string;
    duration_sec: number;
    beats: ToivProjectedBeat[];
    dialogue: string;
    prompt: string;
    persisted?: boolean;
};

export type ToivDramaShotCandidateQa = {
    verdict?: string;
    reason?: string;
    engine?: string;
    total?: number;
    scores?: Record<string, number>;
};

export type ToivDramaShotCandidate = {
    id: string;
    url?: string;
    seed?: number;
    status?: string;
    is_picked?: boolean;
    error?: string;
    video_model?: string;
    pipeline?: string;
    revision_id?: string;
    job_id?: string;
    db_job_id?: string;
    qa?: ToivDramaShotCandidateQa;
};

/** C1a 媒体归属投影(后端 _shot_out 派生,只消费不计算):none=无产物 unknown=旧行无归属 current=与当前内容一致 stale=内容已变 */
export type ToivShotMediaStatus = "none" | "unknown" | "current" | "stale";

export type ToivDramaShot = {
    id: string;
    idx: string | number;
    status: string;
    /** Wave P2:跳过口型标注 */
    lipsync_skipped?: boolean;
    /** C1a 修订指针与媒体归属投影(后端真值) */
    current_revision_id?: string;
    rendered_revision_id?: string;
    voiced_revision_id?: string;
    visual_media_status?: ToivShotMediaStatus;
    audio_media_status?: ToivShotMediaStatus;
    /** C1a 待上线:final_clip/lipsync 归属投影(none|unknown|current|stale)。
     *  后端尚未实现该字段,前端只声明类型,等后端真值上线后再接 stale 徽章/重对口型入口 */
    final_media_status?: ToivShotMediaStatus;
    /** C1a 参考纪元(场景锚绑定快照;PUT 时透传,None=后端不改) */
    ref_epoch?: string;
    ref_epoch_note?: string;
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
    video_model?: string;
    num_candidates?: number;
    ref_images?: string[];
    scene_images?: string[];
    ref_style?: string;
    image_url?: string;
    video_url?: string;
    voice_url?: string;
    final_clip_url?: string;
    error?: string;
    /** S4:多候选(candidates_json 透出)与 seam 衔接策略 */
    candidates?: ToivDramaShotCandidate[];
    candidates_digest?: string;
    seam_to_next?: string;
    seam_anchor?: string;
    /** FU1 声明及服务端投影(空=无词锚) */
    beats?: ToivProjectedBeat[];
};

/** C1c 六阶段轨道:后端 stage_states 真值(旧服务端无该字段 → 前端回退四阶段) */
export type ToivStageId = "script" | "assets" | "storyboard" | "generate" | "voice" | "timeline";

export type ToivStageStateValue =
    | "draft"
    | "pending_confirmation"
    | "confirmed"
    | "generating"
    | "failed"
    | "needs_review"
    | "skipped";

export type ToivStageState = {
    state: ToivStageStateValue;
    ready: boolean;
    blockers: string[];
};

export type ToivStageStates = Partial<Record<ToivStageId, ToivStageState>>;

export type ToivStageTransitionAction = "confirm" | "skip" | "reopen";

export type ToivStageTransitionBody = {
    stage: ToivStageId;
    action: ToivStageTransitionAction;
    /** 跳过说明(skip 必填,缺失 → 后端保持 HTTP 409 detail) */
    note?: string;
    /** 乐观并发基线:须等于当前 stage_revision,不符 → 后端保持 HTTP 409 detail */
    expected_stage_revision?: number;
};

export type ToivStageTransitionResult = {
    project_id: string;
    stage: ToivStageId;
    stage_states: ToivStageStates;
    stage_revision: number;
};

export type ToivStageHistoryEntry = {
    id: string;
    stage: string;
    from_state: string;
    to_state: string;
    source: string;
    note?: string | null;
    created_by: string;
    created_at: string;
};

export type ToivStageHistoryList = {
    history: ToivStageHistoryEntry[];
};

export type ToivDramaDetail = ToivDramaProject & {
    characters?: ToivDramaCharacter[];
    shots?: ToivDramaShot[];
    /** C1c:六阶段状态真源(旧服务端响应无此字段) */
    stage_states?: ToivStageStates;
    /** C1c:阶段乐观并发基线 */
    stage_revision?: number;
};

export async function fetchDramaProject(pid: string): Promise<ToivDramaDetail> {
    const { data } = await toivHttp.get(`/studio/projects/${encodeURIComponent(pid)}`);
    return data as ToivDramaDetail;
}

/** C1c:POST /studio/projects/{pid}/stage-transition —— 阶段确认/跳过/重开。
 *  成功返回服务端全量 stage_states 投影 + 新 stage_revision;CAS 不符 → 后端保持 HTTP 409 detail。
 *  前端动作成功后必须重新 load() 项目详情派生阶段,不以返回值为本地真源。 */
export async function transitionProjectStage(pid: string, input: ToivStageTransitionBody): Promise<ToivStageTransitionResult> {
    const { data } = await toivHttp.post(
        `/studio/projects/${encodeURIComponent(pid)}/stage-transition`,
        input,
        { timeout: 30_000 },
    );
    return data as ToivStageTransitionResult;
}

/** C1c:GET /studio/projects/{pid}/stages/history —— 阶段流转历史(新→旧);stage 过滤可选 */
export async function fetchStageHistory(pid: string, stage?: ToivStageId): Promise<ToivStageHistoryList> {
    const { data } = await toivHttp.get(`/studio/projects/${encodeURIComponent(pid)}/stages/history`, {
        params: stage ? { stage } : {},
    });
    return data as ToivStageHistoryList;
}

export async function triggerShotRender(shotId: string): Promise<boolean> {
    try { await toivHttp.post(`/studio/shots/${shotId}/render`, undefined, { timeout: 3600_000 }); return true; }
    catch { return false; }
}

export type ToivRenderPipeline = "ref2va" | "c" | "c_hybrid";

export type ToivBatchRenderAck = { job_id: string; status: string; project_id: string };

export async function triggerBatchRender(
    pid: string,
    accel?: string,
    pipeline: ToivRenderPipeline = "ref2va",
): Promise<ToivBatchRenderAck> {
    const body: Record<string, unknown> = { wait: false };
    if (accel && accel !== "off") body.accel = accel;
    if (pipeline && pipeline !== "ref2va") body.pipeline = pipeline;
    const { data } = await toivHttp.post(
        `/studio/projects/${encodeURIComponent(pid)}/render`,
        body,
        { timeout: 30_000, validateStatus: (status) => status === 202 },
    );
    return data as ToivBatchRenderAck;
}

export async function triggerShotVoice(shotId: string): Promise<boolean> {
    try { await toivHttp.post(`/studio/shots/${shotId}/voice`, undefined, { timeout: 600_000 }); return true; }
    catch { return false; }
}

export async function triggerShotLipsync(shotId: string): Promise<boolean> {
    try { await toivHttp.post(`/studio/shots/${shotId}/lipsync`, undefined, { timeout: 1800_000 }); return true; }
    catch { return false; }
}

/** 任务 #24：统一「生成加速档」清单（GET /api/acceleration/tiers）。
 *  每档 {level,label,speedup,ssim,recommended,source,note}；h3 为实测档（已过滤下架档），
 *  wan/qwen 为静态参考档（speedup/ssim 恒 null，source="reference"）。
 *  产品路径默认满血 off；加速档为显式可选。 */
export type ToivAccelTier = {
    level: string;
    label: string;
    speedup: number | null;
    ssim: number | null;
    recommended: boolean;
    source: string;
    note?: string;
};

export type ToivAccelFamily = "h3" | "wan" | "qwen";

/** 拉取指定家族的加速档清单；失败/缺省回落单条满血 off 档（不阻断渲染 UI）。 */
export async function fetchAccelTiers(family: ToivAccelFamily = "h3"): Promise<ToivAccelTier[]> {
    const { data } = await toivHttp.get("/acceleration/tiers");
    const list = (data as { families?: Record<string, ToivAccelTier[]> })?.families?.[family];
    return Array.isArray(list) ? list : [];
}

/** off 满血兜底档（tiers 端点不可达时保证 Select 至少一项且默认满血）。 */
export const OFF_ACCEL_TIER: ToivAccelTier = {
    level: "off",
    label: "满血（默认）",
    speedup: null,
    ssim: null,
    recommended: true,
    source: "reference",
    note: "原生采样，不做加速改写。质量优先默认档。",
};

/** 加速档 Select 选项 label：「甜点位 · 2.94x · SSIM 0.82」；off 档「满血（默认）」。
 *  无实测倍率/SSIM（wan/qwen 参考档）时只显 label。 */
export function formatAccelTierLabel(t: ToivAccelTier): string {
    if (t.level === "off") return t.label || "满血（默认）";
    const parts: string[] = [t.label || t.level];
    if (typeof t.speedup === "number") parts.push(`${t.speedup.toFixed(2)}x`);
    if (typeof t.ssim === "number") parts.push(`SSIM ${t.ssim.toFixed(2)}`);
    return parts.join(" · ");
}

/** 加速档说明小字：note/source；reference 档标注「参考值」（无实测倍率/SSIM）。 */
export function formatAccelTierNote(t: ToivAccelTier): string {
    const note = (t.note || "").trim();
    // off 满血档是产品默认,不是「参考值」:不加前缀,避免把默认档说成估算
    if (t.level === "off") return note;
    if (t.source === "reference") return note ? `参考值 · ${note}` : "参考值";
    return note || (t.source === "measured" ? "实测值" : "");
}

export type ToivCharacterSheet = {
    style: string;
    sheet_url: string;
    /** 分格图:键为 portrait/front/side/back 等(后端键值对象,非数组) */
    panel_urls?: Record<string, string>;
    mtime?: string | number;
    /** 本地学习软保留：门禁未过但仍留在工作区 */
    gate_warning?: boolean;
    gate_warning_zh?: string;
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
        items: list.map((raw) => normalizeToivApp(raw)),
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
    beats?: ToivBeat[];
    seam_to_next?: string;
    /** C1a 乐观并发:与 shot.current_revision_id 不符 → 后端 409(已有镜必带) */
    expected_revision?: string;
    /** 参考纪元(可选;null=后端保持原值) */
    ref_epoch?: string | null;
    ref_epoch_note?: string | null;
};

/** POST /studio/projects/{pid}/import-svml → 词锚定脚本确定性拆镜(hypit 语法,不经 LLM,不落库)。
 *  返回与 script/parse 同构的 shots+characters,由前端走既有「建角色+PUT shots 全量替换」链路。 */
export async function importSvmlStudio(
    pid: string,
    script: string,
): Promise<{ shots: ToivParsedShot[]; characters: string[]; count: number }> {
    const { data } = await toivHttp.post(
        `/studio/projects/${encodeURIComponent(pid)}/import-svml`,
        { script },
        { timeout: 15_000 },
    );
    return data;
}

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

/** POST /studio/shots/{sid}/reflow-beats —— 改词重排(词锚投影回写时长) */
export async function reflowShotBeats(
    sid: string,
    opts: { texts?: string[]; total_sec?: number; persist?: boolean } = {},
): Promise<ToivReflowResult> {
    const { data } = await toivHttp.post<ToivReflowResult>(
        `/studio/shots/${encodeURIComponent(sid)}/reflow-beats`,
        { texts: opts.texts, total_sec: opts.total_sec, persist: opts.persist ?? true },
        { timeout: 15_000 },
    );
    return data;
}

/** P4 scene_asset(dramaclaw 设计采纳,NOTICE 见 third_party/licenses/):场景变体+冻结锚点 */
export type ToivSceneFrozenAnchor = {
    anchor_id?: string;
    image_url?: string;
    snapshot_url?: string;
    sha256?: string;
    frozen_at?: number;
};

export type ToivSceneItem = {
    id: string;
    project_id: string;
    name: string;
    base_scene_id?: string;
    is_variant?: boolean;
    variant_prompt?: string;
    time_of_day?: string;
    environment_prompt?: string;
    master_ref?: string;
    reverse_ref?: string;
    frozen_anchor?: ToivSceneFrozenAnchor | null;
    composed_prompt?: string;
    variants?: ToivSceneItem[];
};

export type ToivSceneRef = {
    scene_id?: string;
    scene_name?: string;
    anchor_id?: string;
    anchor_image?: string;
    anchor_sha256?: string;
};

export async function listToivScenes(pid: string): Promise<{ scenes: ToivSceneItem[]; orphans: ToivSceneItem[] }> {
    const { data } = await toivHttp.get(`/drama/projects/${encodeURIComponent(pid)}/scenes`);
    return data as { scenes: ToivSceneItem[]; orphans: ToivSceneItem[] };
}

export async function createToivScene(pid: string, body: { name: string; environment_prompt?: string; master_ref?: string }): Promise<ToivSceneItem> {
    const { data } = await toivHttp.post(`/drama/projects/${encodeURIComponent(pid)}/scenes`, body);
    return (data as { scene: ToivSceneItem }).scene;
}

export async function freezeToivSceneAnchor(sid: string, body: { anchor_id: "master" | "reverse" | "selected"; image_url?: string }): Promise<ToivSceneItem> {
    const { data } = await toivHttp.post(`/drama/scenes/${encodeURIComponent(sid)}/freeze-anchor`, body);
    return (data as { scene: ToivSceneItem }).scene;
}

export async function attachToivSceneToShot(sid: string, body: { shot_id: string; use_frozen?: boolean }): Promise<{ anchor_image: string; scene_ref: ToivSceneRef }> {
    const { data } = await toivHttp.post(`/drama/scenes/${encodeURIComponent(sid)}/attach`, body);
    return data as { anchor_image: string; scene_ref: ToivSceneRef };
}

/** PUT /studio/projects/{pid}/shots —— 全量替换语义(拆解结果确认落库) */
export async function saveStudioShots(pid: string, shots: ToivParsedShot[]): Promise<void> {
    await toivHttp.put(`/studio/projects/${encodeURIComponent(pid)}/shots`, { shots }, { timeout: 30_000 });
}

// ---- C1a:分镜修订历史 / diff / 回滚(后端真值;前端不造 hash/版本) ----

export type ToivShotRevision = {
    id: string;
    version: number;
    /** manual-edit | rollback | imported | render */
    source: string;
    parent_id: string;
    visual_fingerprint: string;
    audio_fingerprint: string;
    created_by: string;
    created_at: string;
};

export type ToivShotRevisionList = {
    shot_id: string;
    revisions: ToivShotRevision[];
};

export type ToivShotRevisionDiff = {
    revision_id: string;
    version: number;
    source: string;
    from_version: number | null;
    /** 无上游(旧行首修)→ from 一律 null,不伪造对比基线 */
    from_unknown: boolean;
    fields: Record<string, { from: unknown; to: unknown }>;
};

/** GET /studio/shots/{sid}/revisions —— 修订历史(新→旧) */
export async function fetchShotRevisions(shotId: string): Promise<ToivShotRevisionList> {
    const { data } = await toivHttp.get(`/studio/shots/${encodeURIComponent(shotId)}/revisions`);
    return data as ToivShotRevisionList;
}

/** GET /studio/shots/{sid}/revisions/{rid}/diff —— 与上游内容链的逐字段 diff */
export async function fetchShotRevisionDiff(shotId: string, revisionId: string): Promise<ToivShotRevisionDiff> {
    const { data } = await toivHttp.get(
        `/studio/shots/${encodeURIComponent(shotId)}/revisions/${encodeURIComponent(revisionId)}/diff`,
    );
    return data as ToivShotRevisionDiff;
}

/** POST /studio/shots/{sid}/rollback —— 回滚到指定修订内容,返回 shot 全量投影。
 *  expected_revision(可选):回滚基线乐观并发,须等于当前 current_revision_id(旧行空串);
 *  不符 → 后端 409。不传则保持后端旧行为(不做基线校验)。 */
export async function rollbackShotRevision(shotId: string, revisionId: string, expectedRevision?: string): Promise<ToivDramaShot> {
    const body: { revision_id: string; expected_revision?: string } = { revision_id: revisionId };
    if (expectedRevision !== undefined) body.expected_revision = expectedRevision;
    const { data } = await toivHttp.post(
        `/studio/shots/${encodeURIComponent(shotId)}/rollback`,
        body,
        { timeout: 30_000 },
    );
    return data as ToivDramaShot;
}

// ---- C1b:用户生成配方(StudioRecipe)——服务端真值,不用 localforage 伪造跨设备数据 ----

/** 与后端 RECIPE_PICK_STRATEGIES 同口径:auto_best=出片自动择优,manual=人工挑选 */
export type ToivRecipePickStrategy = "auto_best" | "manual";

/** 配方快照(只存真实生成输入;无值=null,见 services/studio/recipes.py) */
export type ToivRecipeSnapshot = {
    engine?: string | null;
    render_mode?: string | null;
    pipeline?: string | null;
    pick_strategy?: string | null;
    prompt?: string | null;
    negative?: string | null;
    camera?: string | null;
    duration_sec?: number | null;
    num_candidates?: number | null;
    seed?: number | null;
    ref_images?: string[] | null;
    scene_images?: string[] | null;
    ref_style?: string | null;
    accel?: string | null;
    ref_epoch?: number | null;
    ref_epoch_note?: string | null;
    scene_ref_json?: string | null;
    width?: number | null;
    height?: number | null;
    fps?: number | null;
    ckpt_name?: string | null;
};

export type ToivRecipe = {
    id: string;
    name: string;
    description: string;
    engine: string;
    render_mode: string;
    pipeline: string;
    pick_strategy: ToivRecipePickStrategy;
    snapshot: ToivRecipeSnapshot;
    source_revision_id: string;
    source_shot_id: string;
    is_default: boolean;
    created_at: string;
    updated_at: string;
};

/** GET /:id/export 的导出形状;import 接受同一形状(服务端校验,422 不落半成品) */
export type ToivRecipeExport = {
    schema: "toiv_generation_recipe_v1";
    name: string;
    description: string;
    engine: string;
    render_mode: string;
    pipeline: string;
    pick_strategy: ToivRecipePickStrategy;
    snapshot: ToivRecipeSnapshot;
    exported_at: string;
};

/** GET /:id/diff → 配方 vs live shot(from=live,to=配方);null 项不比较 */
export type ToivRecipeDiff = {
    recipe_id: string;
    shot_id: string;
    fields: Record<string, { from: unknown; to: unknown }>;
    render_params: ToivRecipeRenderParams;
};

/** apply/diff 返回的 render_one 参数;可直接作为 renderShotAsync opts 的补充 */
export type ToivRecipeRenderParams = {
    video_model?: string;
    auto_pick?: boolean;
    wait?: boolean;
    pipeline?: string;
    num_candidates?: number;
    seed?: number;
    ref_images?: string[];
    scene_images?: string[];
    ref_style?: string;
    accel?: string;
    [key: string]: unknown;
};

/** POST /:id/apply → shot 全量投影 + render_params + 落库字段清单 */
export type ToivRecipeApplyResult = {
    shot: ToivDramaShot;
    render_params: ToivRecipeRenderParams;
    applied_fields: string[];
    project_specs_changed: string[];
};

/** POST /studio/recipes/from-shot —— 从成功 shot 快照生成输入创建配方 */
export async function createRecipeFromShot(
    shotId: string,
    opts: { name?: string; description?: string } = {},
): Promise<ToivRecipe> {
    const { data } = await toivHttp.post(
        "/studio/recipes/from-shot",
        { shot_id: shotId, name: opts.name ?? "", description: opts.description ?? "" },
        { timeout: 30_000 },
    );
    return data as ToivRecipe;
}

/** GET /studio/recipes —— 我的配方(可按 engine 过滤);空集合返回空数组 */
export async function fetchRecipes(engine?: string): Promise<ToivRecipe[]> {
    const { data } = await toivHttp.get("/studio/recipes", {
        params: engine ? { engine } : {},
        timeout: 15_000,
    });
    const list = (data as { recipes?: ToivRecipe[] })?.recipes;
    return Array.isArray(list) ? list : [];
}

/** GET /studio/recipes/{rid} */
export async function fetchRecipe(recipeId: string): Promise<ToivRecipe> {
    const { data } = await toivHttp.get(`/studio/recipes/${encodeURIComponent(recipeId)}`, { timeout: 15_000 });
    return data as ToivRecipe;
}

/** PATCH /studio/recipes/{rid} —— 只提交显式给出的字段(不伪造空串清空) */
export async function patchRecipe(
    recipeId: string,
    patch: { name?: string; description?: string; prompt?: string; negative?: string; pick_strategy?: ToivRecipePickStrategy },
): Promise<ToivRecipe> {
    const body: Record<string, string> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.prompt !== undefined) body.prompt = patch.prompt;
    if (patch.negative !== undefined) body.negative = patch.negative;
    if (patch.pick_strategy !== undefined) body.pick_strategy = patch.pick_strategy;
    const { data } = await toivHttp.patch(`/studio/recipes/${encodeURIComponent(recipeId)}`, body, { timeout: 30_000 });
    return data as ToivRecipe;
}

/** POST /studio/recipes/{rid}/clone —— 克隆(来源修订/出处保留,非默认) */
export async function cloneRecipe(recipeId: string, name?: string): Promise<ToivRecipe> {
    const { data } = await toivHttp.post(
        `/studio/recipes/${encodeURIComponent(recipeId)}/clone`,
        name !== undefined ? { name } : {},
        { timeout: 30_000 },
    );
    return data as ToivRecipe;
}

/** POST /studio/recipes/{rid}/set-default —— 每 (user, engine) 唯一默认(服务端同事务清旧) */
export async function setDefaultRecipe(recipeId: string): Promise<ToivRecipe> {
    const { data } = await toivHttp.post(`/studio/recipes/${encodeURIComponent(recipeId)}/set-default`, undefined, { timeout: 30_000 });
    return data as ToivRecipe;
}

/** DELETE /studio/recipes/{rid} —— 只删配方行,不碰源镜/产物 */
export async function deleteRecipe(recipeId: string): Promise<void> {
    await toivHttp.delete(`/studio/recipes/${encodeURIComponent(recipeId)}`, { timeout: 30_000 });
}

/** GET /studio/recipes/{rid}/export —— toiv_generation_recipe_v1 JSON */
export async function exportRecipe(recipeId: string): Promise<ToivRecipeExport> {
    const { data } = await toivHttp.get(`/studio/recipes/${encodeURIComponent(recipeId)}/export`, { timeout: 15_000 });
    return data as ToivRecipeExport;
}

/** POST /studio/recipes/import —— 接受 export 形状;校验失败 422(错误向上抛出由面板透出) */
export async function importRecipe(payload: unknown): Promise<ToivRecipe> {
    const { data } = await toivHttp.post("/studio/recipes/import", payload, { timeout: 30_000 });
    return data as ToivRecipe;
}

/** GET /studio/recipes/{rid}/diff?shot_id= —— 应用前的逐字段差异(from=live shot,to=配方) */
export async function fetchRecipeDiff(recipeId: string, shotId: string): Promise<ToivRecipeDiff> {
    const { data } = await toivHttp.get(`/studio/recipes/${encodeURIComponent(recipeId)}/diff`, {
        params: { shot_id: shotId },
        timeout: 15_000,
    });
    return data as ToivRecipeDiff;
}

/** POST /studio/recipes/{rid}/apply —— 应用到 shot(保留剧情/roster);
 *  expected_revision 与 current_revision_id 不符 → 后端 409(不静默覆盖,axios 错误向上抛) */
export async function applyRecipe(
    recipeId: string,
    body: { shot_id: string; expected_revision?: string; apply_project_specs?: boolean },
): Promise<ToivRecipeApplyResult> {
    const payload: Record<string, unknown> = { shot_id: body.shot_id };
    if (body.expected_revision !== undefined) payload.expected_revision = body.expected_revision;
    payload.apply_project_specs = body.apply_project_specs ?? false;
    const { data } = await toivHttp.post(
        `/studio/recipes/${encodeURIComponent(recipeId)}/apply`,
        payload,
        { timeout: 30_000 },
    );
    return data as ToivRecipeApplyResult;
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
export async function patchStudioProject(pid: string, patch: {
    premise?: string;
    style?: string;
    preferred_pipeline?: "ref2va" | "c" | "c_hybrid";
    preferred_drive_mode?: "keyframe" | "direct";
    title?: string;
    bgm_url?: string;
    bgm_volume?: number;
    bgm_duck?: boolean;
}): Promise<void> {
    await toivHttp.patch(`/studio/projects/${encodeURIComponent(pid)}`, patch, { timeout: 15_000 });
}

/** F3：上传声床音频并写入项目 bgm_url */
export async function uploadStudioProjectBgm(pid: string, file: File): Promise<{ bgm_url: string }> {
    const fd = new FormData();
    fd.append("file", file);
    const { data } = await toivHttp.post(`/studio/projects/${encodeURIComponent(pid)}/bgm`, fd, {
        timeout: 120_000,
        headers: { "Content-Type": "multipart/form-data" },
    });
    return data as { bgm_url: string };
}

/** W1.3(2026-10-11):严格版设定卡生成——失败抛错(带后端 detail),供工作区透出;
 * 旧 triggerSheetRegen 吞错返回 boolean 的行为保留(drama-detail 既有契约)。 */
export async function generateCharacterSheetStrict(cid: string, style: string): Promise<void> {
    try {
        await toivHttp.post(`/studio/characters/${encodeURIComponent(cid)}/character-sheet`, { style }, { timeout: 3600_000 });
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
        if (detail && typeof detail === "object") {
            throw new SheetGateJobError(
                sheetFailureFromJobResult({ ...(detail as Record<string, unknown>), status: "error", style }, style),
            );
        }
        throw new Error((typeof detail === "string" && detail) || "设定卡生成失败(可能未过内部质检门禁,可重试)");
    }
}

/** W1.4(2026-10-11):严格版单镜渲染——失败抛错带 detail(缺参考图等前置问题可见);
 * 旧 triggerShotRender 吞错 boolean 保留(drama-detail 契约)。
 * 任务 #24:opts.accel 传显式加速档(默认 off 满血);后端仅对 H3 家族图生效。 */
export async function renderShotStrict(sid: string, opts: { num_candidates?: number; accel?: string; pipeline?: ToivRenderPipeline } = {}): Promise<void> {
    try {
        const payload: Record<string, unknown> = { wait: true };
        if (opts.num_candidates) payload.num_candidates = opts.num_candidates;
        if (opts.accel && opts.accel !== "off") payload.accel = opts.accel;
        if (opts.pipeline) payload.pipeline = opts.pipeline;
        const hasExtra = Boolean(opts.num_candidates || (opts.accel && opts.accel !== "off") || opts.pipeline);
        await toivHttp.post(
            `/studio/shots/${encodeURIComponent(sid)}/render`,
            hasExtra ? payload : undefined,
            { timeout: 3600_000 },
        );
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "渲染失败");
    }
}

/** F4:导出剪映草稿 ZIP（GET /studio/projects/{pid}/export/jianying）。 */
export async function exportStudioJianyingDraft(
    pid: string,
    opts?: { include_media?: boolean },
): Promise<{ blob: Blob; fileName: string; draftId: string; format: string }> {
    try {
        const { data, headers } = await toivHttp.get(
            `/studio/projects/${encodeURIComponent(pid)}/export/jianying`,
            {
                params: { include_media: opts?.include_media ?? true },
                responseType: "blob",
                timeout: 600_000,
            },
        );
        const blob = data as Blob;
        const hdr = headers as Record<string, string>;
        const cd = String(hdr?.["content-disposition"] ?? hdr?.["Content-Disposition"] ?? "");
        const draftId = String(hdr?.["x-toiv-draft-id"] ?? hdr?.["X-Toiv-Draft-Id"] ?? "");
        const format = String(hdr?.["x-toiv-draft-format"] ?? hdr?.["X-Toiv-Draft-Format"] ?? "toiv_jianying_draft_v1");
        let fileName = `toiv-jianying_${draftId.slice(0, 8) || "draft"}.zip`;
        const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
        if (m) {
            try {
                fileName = decodeURIComponent((m[1] || m[2] || fileName).replace(/"/g, "").trim());
            } catch {
                fileName = (m[1] || m[2] || fileName).replace(/"/g, "").trim() || fileName;
            }
        }
        // axios 在 4xx 时可能仍把 JSON 错误体当 blob
        if (blob.type && blob.type.includes("application/json")) {
            const text = await blob.text();
            try {
                const j = JSON.parse(text) as { detail?: string };
                throw new Error(j.detail || "剪映草稿导出失败");
            } catch (e) {
                if (e instanceof Error && e.message !== "剪映草稿导出失败" && !text.startsWith("{")) throw e;
                if (e instanceof Error && e.message) throw e;
                throw new Error(text || "剪映草稿导出失败");
            }
        }
        return { blob, fileName, draftId, format };
    } catch (e) {
        const detail = (e as { response?: { data?: unknown } })?.response?.data;
        if (detail instanceof Blob) {
            try {
                const text = await detail.text();
                const j = JSON.parse(text) as { detail?: string };
                throw new Error(j.detail || "剪映草稿导出失败");
            } catch (inner) {
                if (inner instanceof Error && inner.message !== "剪映草稿导出失败") throw inner;
            }
        }
        if (e instanceof Error) throw e;
        const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(d || "剪映草稿导出失败");
    }
}

/** S9-lite(2026-10-11):拼接全部就绪分镜 → 项目成片(POST /studio/projects/{pid}/assemble)。
 * 任一镜缺 final_clip_url → 422(错误透出)。 */
export async function assembleStudioProject(
    pid: string,
    opts?: { bgm_url?: string | null; bgm_volume?: number; bgm_duck?: boolean },
): Promise<void> {
    try {
        const body =
            opts && (opts.bgm_url != null || opts.bgm_volume != null || opts.bgm_duck != null)
                ? opts
                : undefined;
        await toivHttp.post(`/studio/projects/${encodeURIComponent(pid)}/assemble`, body, { timeout: 600_000 });
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(detail || "成片合成失败");
    }
}

/** C1b 配方 render_params 透传选项(apply 返回的 render_params 可直接作为本 opts 的补充)。 */
export type RenderShotAsyncOpts = {
    num_candidates?: number;
    accel?: string;
    pipeline?: ToivRenderPipeline;
    force_direct?: boolean;
    /** C1b:配方带回的渲染参数(原样透传,不本地改写) */
    auto_pick?: boolean;
    seed?: number;
    ref_images?: string[];
    scene_images?: string[];
    ref_style?: string;
    video_model?: string;
};

export type ToivRenderEstimateBlocker = { code: string; message: string; stage?: ToivStageId };
export type ToivRenderEstimateWarning = { code: string; message: string };
export type ToivRenderEstimateItem = {
    shot_id: string;
    idx: string | number;
    engine: string;
    pipeline: string;
    render_mode: string;
    candidates: number;
    duration_sec: number;
    frames: number;
    pixel_frames_upper_bound: number;
};
export type ToivRenderEstimate = {
    schema: "toiv_render_estimate_v1";
    scope: "batch" | "shot";
    project_id: string;
    shot_id?: string;
    allowed: boolean;
    blockers: ToivRenderEstimateBlocker[];
    warnings: ToivRenderEstimateWarning[];
    input_fingerprint: string;
    work: {
        shot_count: number;
        candidate_upper_bound: number;
        requested_duration_sec: number;
        requested_frame_count: number;
        pixel_frame_upper_bound: number;
        image_motion_count: number;
    };
    items: ToivRenderEstimateItem[];
    pricing: {
        status: "estimated" | "unpriced";
        currency: string | null;
        total: string | null;
        rate_source: string;
        unknowns: string[];
    };
    budget: {
        status: "disabled" | "within" | "exceeded" | "unpriced";
        limit: string | null;
        currency: string | null;
    };
};

export type BatchRenderEstimateBody = { accel: string; pipeline: ToivRenderPipeline; wait?: boolean };

export async function estimateBatchRender(pid: string, body: BatchRenderEstimateBody): Promise<ToivRenderEstimate> {
    const { data } = await toivHttp.post(
        `/studio/projects/${encodeURIComponent(pid)}/render-estimate`,
        body,
        { timeout: 30_000 },
    );
    return data as ToivRenderEstimate;
}

export function buildRenderShotRequestBody(opts: RenderShotAsyncOpts = {}): Record<string, unknown> {
    const payload: Record<string, unknown> = { num_candidates: opts.num_candidates ?? 2, wait: false, pipeline: opts.pipeline ?? "ref2va" };
    if (opts.accel && opts.accel !== "off") payload.accel = opts.accel;
    if (opts.force_direct) payload.force_direct = true;
    if (opts.auto_pick !== undefined) payload.auto_pick = opts.auto_pick;
    if (opts.seed !== undefined) payload.seed = opts.seed;
    if (opts.ref_images && opts.ref_images.length > 0) payload.ref_images = opts.ref_images;
    if (opts.scene_images && opts.scene_images.length > 0) payload.scene_images = opts.scene_images;
    if (opts.ref_style) payload.ref_style = opts.ref_style;
    if (opts.video_model) payload.video_model = opts.video_model;
    return payload;
}

export async function estimateShotRender(sid: string, opts: RenderShotAsyncOpts = {}): Promise<ToivRenderEstimate> {
    const { data } = await toivHttp.post(
        `/studio/shots/${encodeURIComponent(sid)}/render-estimate`,
        buildRenderShotRequestBody(opts),
        { timeout: 30_000 },
    );
    return data as ToivRenderEstimate;
}

/** S4-b(2026-10-11):异步单镜渲染——wait=false 登记 Job 即回(管线C阶段B机制);
 * 同步等待撞 reload/断连=状态僵死(实测),一律走此路。 */
export async function renderShotAsync(sid: string, opts: RenderShotAsyncOpts = {}): Promise<{ job_id: string }> {
    try {
        const payload = buildRenderShotRequestBody(opts);
        const { data } = await toivHttp.post(
            `/studio/shots/${encodeURIComponent(sid)}/render`,
            payload,
            { timeout: 30_000, validateStatus: (st) => st === 202 || (st >= 200 && st < 300) },
        );
        return data as { job_id: string };
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
        if (typeof detail === "string" && detail) throw new Error(detail);
        if (detail && typeof detail === "object" && !Array.isArray(detail)) {
            const fields = detail as Record<string, unknown>;
            const message = [fields.code, fields.message, fields.hint]
                .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
                .join(" · ");
            if (message) throw new Error(message);
        }
        throw new Error("渲染提交失败");
    }
}

/** S4:选用候选视频为该镜成片(POST /studio/shots/{sid}/candidates/{cid}/pick) */
export async function pickShotCandidate(sid: string, cid: string, expectedCandidatesDigest?: string): Promise<ToivDramaShot> {
    try {
        const body: { expected_candidates_digest?: string } = {};
        if (expectedCandidatesDigest !== undefined) body.expected_candidates_digest = expectedCandidatesDigest;
        const { data } = await toivHttp.post<ToivDramaShot>(
            `/studio/shots/${encodeURIComponent(sid)}/candidates/${encodeURIComponent(cid)}/pick`,
            body,
            { timeout: 30_000 },
        );
        return data;
    } catch (e) {
        const response = (e as { response?: { data?: { detail?: string } } })?.response;
        const error = new Error(response?.data?.detail || "选用候选失败");
        Object.assign(error, { response });
        throw error;
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


/** L2 角色资产（含 style_variants 登记）。GET 不存在时后端会物化 v1。 */
export type ToivCharacterAsset = {
    style?: { current?: string; variants_allowed?: boolean } | string;
    style_variants?: Record<string, { url?: string; [k: string]: unknown }>;
    version?: number;
    materialized_now?: boolean;
    [k: string]: unknown;
};

export async function fetchCharacterAsset(cid: string, style = "anime"): Promise<ToivCharacterAsset> {
    const { data } = await toivHttp.get(
        `/studio/characters/${encodeURIComponent(cid)}/character-asset`,
        { params: { style }, timeout: 30_000 },
    );
    return data as ToivCharacterAsset;
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

/** GET /studio/characters/{cid}/character-sheet/async/{job_id} → done 时带 sheet_url/panel_urls；
 * error 时可能带 rejected_preview_url / reason_zh / gate_failures（门禁失败 UX）。 */
export type ToivSheetJobPoll = {
    status: string;
    sheet_url?: string;
    panel_urls?: Record<string, string>;
    error?: string;
    reason_code?: string;
    reason_zh?: string;
    technical_detail?: string;
    rejected_preview_url?: string | null;
    rejected_panel?: string | null;
    gate_failures?: Array<{
        code: string;
        title: string;
        detail: string;
        panel?: string | null;
        preview_url?: string | null;
    }>;
    soft_keep_available?: boolean;
    style?: string;
};

export async function pollSheetJob(cid: string, jobId: string): Promise<ToivSheetJobPoll> {
    const { data } = await toivHttp.get(
        `/studio/characters/${encodeURIComponent(cid)}/character-sheet/async/${encodeURIComponent(jobId)}`,
        { timeout: 15_000 },
    );
    return data as ToivSheetJobPoll;
}

/** POST /studio/characters/{cid}/character-sheet/keep-rejected —— 警告下保留拒图为设定卡（本地学习软模式） */
export async function keepRejectedSheet(
    cid: string,
    body: { style: string; preview_url: string; reason_zh?: string; technical_detail?: string },
): Promise<{ sheet_url: string; warning: boolean; reason_zh?: string }> {
    const { data } = await toivHttp.post(
        `/studio/characters/${encodeURIComponent(cid)}/character-sheet/keep-rejected`,
        body,
        { timeout: 30_000 },
    );
    return data as { sheet_url: string; warning: boolean; reason_zh?: string };
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


/** F1：采用配景/站内图为本镜关键帧（写入 image_url） */
export async function adoptShotKeyframe(sid: string, url: string): Promise<ToivDramaShot> {
    const { data } = await toivHttp.post<ToivDramaShot>(
        `/studio/shots/${encodeURIComponent(sid)}/adopt-keyframe`,
        { url },
        { timeout: 30_000 },
    );
    return data;
}

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

/** Wave P1.5 L1:创作台忙闲只读摘要(藏端口) */
export type ToivFleetBrief = {
    level: "idle" | "busy" | "held" | "degraded" | "offline" | string;
    summary: string;
    mine?: { held: number; active: number };
    fleet?: { online_devices: number; services_up: number; services_total: number };
};

export async function fetchFleetBrief(): Promise<ToivFleetBrief> {
    const { data } = await toivHttp.get("/fleet/brief", { timeout: 8_000 });
    return data as ToivFleetBrief;
}

/** Wave P1.5 L5:依赖三态 */
export type ToivDepState = "reachable" | "degraded" | "unreachable" | string;
export type ToivDepItem = {
    id: string;
    label: string;
    state: ToivDepState;
    summary: string;
    block_cta?: boolean;
    blocked_hint?: string;
};
export type ToivDepsStatus = { overall: ToivDepState; deps: ToivDepItem[] };

export async function fetchStudioDepsStatus(): Promise<ToivDepsStatus> {
    const { data } = await toivHttp.get("/studio/deps-status", { timeout: 10_000 });
    return data as ToivDepsStatus;
}

/** Wave P2:跳过口型(须二次确认后调用) */
export async function skipLipsyncShot(sid: string): Promise<void> {
    try {
        await toivHttp.post(`/studio/shots/${encodeURIComponent(sid)}/lipsync/skip`, undefined, { timeout: 180_000 });
    } catch (e) {
        const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        throw new Error(typeof detail === "string" ? detail : "跳过口型失败");
    }
}

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

// ---- F6(2026-10-12):视频剪辑(自经典 VideoEditView 三轨剪辑迁入) ----

export interface VideoEditClip {
    file: number;
    in: number;
    duration: number;
    volume: number;
}

export interface VideoEditAudio {
    file: number;
    in: number;
    duration: number;
    start: number;
    volume: number;
}

export interface VideoEditText {
    text: string;
    start: number;
    end: number;
    position: string;
    fontSize: number;
    color: string;
}

export interface VideoEditPlan {
    width: number;
    height: number;
    fps: number;
    clips: VideoEditClip[];
    audios: VideoEditAudio[];
    texts: VideoEditText[];
}

export interface VideoEditResult {
    job_id: string;
    url: string;
    clips: number;
    audios: number;
    texts: number;
    duration: number;
    fps: number;
    width: number;
    height: number;
}

/** POST /api/video-edit/render multipart(plan+media):剪辑计划 → ffmpeg 成片(同步,分钟级)。 */
export async function renderVideoEdit(plan: VideoEditPlan, media: File[]): Promise<VideoEditResult> {
    const fd = new FormData();
    fd.append("plan", JSON.stringify(plan));
    for (const f of media) fd.append("media", f);
    const { data } = await toivHttp.post("/video-edit/render", fd, { timeout: 300_000 });
    return data;
}

// ---- F7(2026-10-12):视频译制(自经典 DubView 迁入) ----

/** POST /api/dub/import-srt multipart(file):SRT/VTT → 带时间轴片段。 */
export async function importSrtDub(file: File): Promise<{ segments: DubSegment[]; count: number }> {
    const fd = new FormData();
    fd.append("file", file);
    const { data } = await toivHttp.post("/dub/import-srt", fd, { timeout: 60_000 });
    return data;
}

/** POST /api/dub/translate:LLM 批量翻译整段字幕(段数多耗时长)。 */
export async function translateDub(
    segments: { index: number; text: string }[],
    targetLang: string,
): Promise<{ translated: { index: number; translated: string }[]; count: number; target_lang: string }> {
    const { data } = await toivHttp.post("/dub/translate", { segments, target_lang: targetLang }, { timeout: 180_000 });
    return data;
}

export interface VoiceTrackResult {
    name: string;
    url: string;
    duration: number;
    segment_count: number;
}

/** POST /api/dub/voice-track → {job_id};轮询 /dub/voice-track/{job_id} 取进度/产物。 */
export async function startVoiceTrack(body: {
    name: string;
    segments: { start: number; end: number; text: string }[];
    refSeconds?: number;
    emoText?: string;
}): Promise<{ job_id: string }> {
    const { data } = await toivHttp.post("/dub/voice-track", {
        name: body.name,
        segments: body.segments,
        ref_seconds: body.refSeconds ?? 8,
        emo_text: body.emoText ?? null,
    }, { timeout: 30_000 });
    return data;
}

export async function pollVoiceTrack(jobId: string): Promise<{
    status: string; stage: string; progress: number;
    url?: string; duration?: number; segment_count?: number; error?: string | null;
}> {
    const { data } = await toivHttp.get(`/dub/voice-track/${encodeURIComponent(jobId)}`, { timeout: 30_000 });
    return data;
}

export interface LipsyncLongStatus {
    id: string;
    status: "running" | "done" | "error";
    stage: string;
    total: number;
    completed: number;
    url: string | null;
    error: string | null;
}

/** POST /api/dub/lipsync-long:源视频+配音轨 → 对口型成片(分段 GPU,长视频)。 */
export async function startLipsyncLong(body: {
    name: string;
    audioName?: string;
    segSeconds?: number;
    lipsExpression?: number;
    inferenceSteps?: number;
}): Promise<{ job_id: string }> {
    const { data } = await toivHttp.post("/dub/lipsync-long", {
        name: body.name,
        segments: [],
        seg_seconds: body.segSeconds ?? 12,
        lips_expression: body.lipsExpression ?? 1,
        inference_steps: body.inferenceSteps ?? 20,
        ...(body.audioName ? { audio_name: body.audioName } : {}),
    }, { timeout: 30_000 });
    return data;
}

export async function pollLipsyncLong(jobId: string): Promise<LipsyncLongStatus> {
    const { data } = await toivHttp.get(`/dub/lipsync-long/${encodeURIComponent(jobId)}`, { timeout: 30_000 });
    return data;
}

// ---- V4-5(2026-10-13):译制增强三件(自经典 DubView 附加功能迁入) ----

export interface DubAutoCutSegment {
    start: number;
    end: number;
}

/** POST /api/dub/autocut:场景/静音检测 → 建议切段(供 lipsync-long segments)。 */
export async function autocutDub(name: string, mode: "scene" | "silence", threshold: number, minSeg: number): Promise<{ segments: DubAutoCutSegment[]; count: number }> {
    const { data } = await toivHttp.post("/dub/autocut", {
        name, mode, threshold, min_seg: minSeg,
    }, { timeout: 180_000 });
    return data;
}

/** POST /api/dub/highlights:LLM 从字幕挑高光句(集锦候选;返回选中序号)。 */
export async function highlightsDub(segments: { index: number; text: string }[], targetCount = 0): Promise<{ title: string; selected: number[]; count: number }> {
    const { data } = await toivHttp.post("/dub/highlights", { segments, target_count: targetCount }, { timeout: 120_000 });
    return data;
}

export interface AnimeLipsyncStatus {
    id: string;
    status: "running" | "done" | "error";
    stage: string;
    progress: number;
    frames: number;
    faces_detected: number;
    url: string | null;
    error: string | null;
    elapsed: number;
}

/** POST /api/dub/anime-lipsync:本地自建 CV 动漫口型(非 LatentSync;异步 job_id)。 */
export async function startAnimeLipsync(name: string, audioName?: string, mouthGain?: number, smooth?: number): Promise<{ job_id: string }> {
    const { data } = await toivHttp.post("/dub/anime-lipsync", {
        name,
        audio_name: audioName ?? null,
        mouth_gain: mouthGain ?? 1.0,
        smooth: smooth ?? 3,
    }, { timeout: 30_000 });
    return data;
}

export async function getAnimeLipsyncStatus(jobId: string): Promise<AnimeLipsyncStatus> {
    const { data } = await toivHttp.get(`/dub/anime-lipsync/${encodeURIComponent(jobId)}`, { timeout: 30_000 });
    return data;
}

import axios from "axios";

/**
 * ToIV 主站 API 客户端(融合 M1,2026-10-06):
 * 同源 /api 直连 ToIV FastAPI(PG 业务域:市场/作品/任务/智能体/短剧);
 * 认证用 ToIV JWT(localStorage.toiv_token,与旧版视图同 key 同源共享)。
 * 与画布 apiClient(/studio/api → per-user Go)是两个数据平面,互不混淆。
 */
const TOKEN_KEY = "toiv_token";

export const toivHttp = axios.create({ baseURL: "/api", timeout: 15_000 });

toivHttp.interceptors.request.use((config) => {
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

export async function fetchBoards(): Promise<ToivBoard[]> {
    const { data } = await toivHttp.get("/boards");
    return Array.isArray(data) ? data : [];
}

export async function fetchBoardItems(boardId: string): Promise<ToivBoardItem[]> {
    const { data } = await toivHttp.get(`/boards/${boardId}/items`);
    return Array.isArray(data) ? (data as ToivBoardItem[]) : ((data as { items?: ToivBoardItem[] })?.items ?? []);
}

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
};

export async function fetchToivApps(limit = 100): Promise<ToivApp[]> {
    const { data } = await toivHttp.get("/apps", { params: { limit } });
    return Array.isArray(data) ? data : ((data as { items?: ToivApp[] })?.items ?? []);
}

export type ToivBoardItem = {
    id: number;
    sort_order: number;
    note?: string;
    shot_text?: string;
    shot_meta?: string;
    job: {
        id: string;
        kind?: string;
        status: string;
        prompt?: string;
        created_at: string;
        results?: string[];
        post_status?: string;
    } | null;
};

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

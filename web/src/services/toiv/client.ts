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

export async function fetchBoardItems(boardId: string): Promise<unknown[]> {
    const { data } = await toivHttp.get(`/boards/${boardId}/items`);
    return Array.isArray(data) ? data : ((data as { items?: unknown[] })?.items ?? []);
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

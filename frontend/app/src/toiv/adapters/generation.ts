export type ToolRatio = "1:1" | "16:9" | "9:16";
export type ToolDuration = "short" | "long";

export type GenerationSubmission = { promptId: string; seed?: number };
export type GenerationJob = { status: string; results: string[]; error: string };

export const RATIO_SIZE: Record<ToolRatio, { width: number; height: number }> = {
    "1:1": { width: 768, height: 768 },
    "16:9": { width: 1024, height: 576 },
    "9:16": { width: 576, height: 1024 },
};

// Wan 视频帧数必须是 4n+1；16fps 下 49≈3 秒、97≈6 秒。
export const DURATION_FRAMES: Record<ToolDuration, number> = { short: 49, long: 97 };

function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function submit(path: string, body: Record<string, unknown>): Promise<GenerationSubmission> {
    const response = await fetch(path, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null) as { prompt_id?: unknown; seed?: unknown; detail?: unknown } | null;
    if (!response.ok) {
        const detail = typeof payload?.detail === "string" ? payload.detail : "";
        throw new Error(detail || `生成提交失败 (${response.status})`);
    }
    const promptId = typeof payload?.prompt_id === "string" ? payload.prompt_id : "";
    if (!promptId) throw new Error("生成响应缺少作业号");
    return typeof payload?.seed === "number" ? { promptId, seed: payload.seed } : { promptId };
}

export function submitT2I(input: { prompt: string; negative: string; ratio: ToolRatio }): Promise<GenerationSubmission> {
    const size = RATIO_SIZE[input.ratio];
    return submit("/api/generate/txt2img", {
        positive: input.prompt,
        negative: input.negative,
        width: size.width,
        height: size.height,
    });
}

export function submitT2V(input: { prompt: string; ratio: ToolRatio; duration: ToolDuration }): Promise<GenerationSubmission> {
    const size = RATIO_SIZE[input.ratio];
    return submit("/api/generate/txt2video", {
        positive: input.prompt,
        width: size.width,
        height: size.height,
        length: DURATION_FRAMES[input.duration],
        fps: 16,
    });
}

/** Jobs are listed newest-first; a just-submitted job may not be visible yet, so null means "keep polling". */
export async function fetchGenerationJob(promptId: string): Promise<GenerationJob | null> {
    const response = await fetch("/api/jobs?limit=50", { headers: authHeaders() });
    if (!response.ok) throw new Error(`任务查询失败 (${response.status})`);
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) return null;
    const job = rows.find((row) => (row as { prompt_id?: unknown })?.prompt_id === promptId) as
        { status?: unknown; results?: unknown; error?: unknown } | undefined;
    if (!job) return null;
    const results = Array.isArray(job.results) ? job.results.filter((url): url is string => typeof url === "string") : [];
    return {
        status: typeof job.status === "string" ? job.status : "",
        results,
        error: typeof job.error === "string" ? job.error : "",
    };
}

export function isGenerationDone(status: string): boolean {
    return status === "done" || status === "succeeded";
}

export function isGenerationFailed(status: string): boolean {
    return status === "error" || status === "failed";
}

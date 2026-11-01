export type ToolSize = { width: number; height: number };

export type GenerationSubmission = { promptId: string; seed?: number };
export type GenerationJob = { status: string; results: string[]; error: string };

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

export function submitT2I(input: {
    prompt: string;
    negative: string;
    model?: string;
    size: ToolSize;
    route?: string | null;
}): Promise<GenerationSubmission> {
    return submit(input.route || "/api/generate/txt2img", {
        positive: input.prompt,
        negative: input.negative,
        ...(input.model ? { ckpt_name: input.model } : {}),
        width: input.size.width,
        height: input.size.height,
    });
}

export function submitT2V(input: {
    prompt: string;
    size: ToolSize;
    durationSec: number;
    route?: string | null;
}): Promise<GenerationSubmission> {
    return submit(input.route || "/api/h3/t2v", {
        positive: input.prompt,
        width: input.size.width,
        height: input.size.height,
        duration_sec: input.durationSec,
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

import { apiClient, request } from "@/services/api/request";

export type NasModelEntry = {
    basename: string;
    rel_path: string;
    用途?: string;
    bytes?: number | null;
    group?: "h3" | "main" | "image" | string;
};

export type NasModelInventory = {
    h3: NasModelEntry[];
    main: NasModelEntry[];
    nas_root_default: string;
    h3_worker: string;
    image_worker?: string;
    chat_alias: string;
    source?: string;
    updated_at?: string;
};

export type NasBinding = {
    rel_path: string;
    basename: string;
    group: string;
    worker?: string;
    bound_at: string;
    note?: string;
};

export type NasBindJob = {
    id: string;
    status: "running" | "done" | "error" | string;
    stage: string;
    progress: number;
    stages: string[];
    error?: string;
    binding?: NasBinding;
    hint?: string;
};

export type NasBindGroup = "h3" | "main" | "image";

export function getNasModels(group?: "h3" | "main" | "all") {
    const params = group && group !== "all" ? { group } : undefined;
    return request<{ inventory: NasModelInventory; bindings: { h3?: NasBinding; image?: NasBinding }; defaults: Record<string, unknown> }>(
        apiClient.get("/nas/models", { params }),
    );
}

export function getNasModelDefaults() {
    return request<Record<string, unknown>>(apiClient.get("/nas/models/defaults"));
}

export function startNasModelBind(relPath: string, group: NasBindGroup = "h3", workerLabel?: string) {
    return request<NasBindJob>(
        apiClient.post("/nas/models/bind", {
            rel_path: relPath,
            group,
            ...(workerLabel ? { worker_label: workerLabel } : {}),
        }),
    );
}

export function getNasModelBindJob(jobId: string) {
    return request<NasBindJob>(apiClient.get(`/nas/models/bind/${encodeURIComponent(jobId)}`));
}

export async function pollNasModelBind(jobId: string, opts?: { signal?: AbortSignal; intervalMs?: number }) {
    const interval = opts?.intervalMs ?? 120;
    for (;;) {
        if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const job = await getNasModelBindJob(jobId);
        if (job.status === "done" || job.status === "error") return job;
        await new Promise((r) => setTimeout(r, interval));
    }
}

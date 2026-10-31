import { primeMediaKind, type PrimeMediaKind } from "./media";

export type PrimeWorkCard = {
    id: string;
    title: string;
    kind: string;
    status: "done" | "run" | "fail" | "wait" | "canceled";
    createdAt: string;
    media?: string;
    mediaKind?: PrimeMediaKind;
};

export function primeJobHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

export function primeJobStatus(raw: string): PrimeWorkCard["status"] {
    if (raw === "done" || raw === "succeeded" || raw === "success") return "done";
    if (raw === "running" || raw === "rendering" || raw === "processing") return "run";
    if (raw === "failed" || raw === "error") return "fail";
    if (raw === "canceled") return "canceled";
    return "wait";
}

type RawJob = {
    id: string;
    kind?: string;
    status?: string;
    created_at?: string;
    results?: string[];
    progress?: { pct?: number | null };
};

// Both history and task center consume GET /api/jobs, not Studio or canvas tasks.
export async function loadPrimeJobs(limit: number, signal?: AbortSignal): Promise<RawJob[]> {
    const res = await fetch(`/api/jobs?limit=${limit}`, { headers: primeJobHeaders(), signal });
    if (!res.ok) throw new Error(`jobs ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body) || body.some(job => !job || typeof job.id !== "string" || !job.id.trim())) {
        throw new Error("Invalid jobs response");
    }
    return body;
}

export async function loadPrimeWorks(signal?: AbortSignal): Promise<PrimeWorkCard[]> {
    const list = await loadPrimeJobs(100, signal);
    return list.map((job) => {
        // Persisted results are string URLs; malformed entries are not an object compatibility API.
        const media = Array.isArray(job.results) ? job.results.find(result => primeMediaKind(result)) : undefined;
        return {
            id: job.id,
            title: job.kind || job.id,
            kind: job.kind || "—",
            status: primeJobStatus(job.status ?? ""),
            createdAt: (job.created_at ?? "").slice(0, 10),
            media,
            mediaKind: primeMediaKind(media),
        };
    });
}

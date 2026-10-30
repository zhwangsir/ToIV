export type PrimeWorkCard = {
    id: string;
    title: string;
    kind: string;
    status: "done" | "run" | "fail" | "wait";
    createdAt: string;
    media?: string;
};

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

function statusOf(raw: string): PrimeWorkCard["status"] {
    if (raw === "done" || raw === "succeeded" || raw === "success") return "done";
    if (raw === "running" || raw === "rendering" || raw === "processing") return "run";
    if (raw === "failed" || raw === "error") return "fail";
    return "wait";
}

type RawJob = {
    id?: string;
    title?: string;
    kind?: string;
    type?: string;
    status?: string;
    created_at?: string;
    results?: { url?: string; path?: string }[];
};

export async function loadPrimeWorks(): Promise<PrimeWorkCard[]> {
    const res = await fetch("/api/jobs?limit=100", { headers: authHeaders() });
    if (!res.ok) throw new Error(`jobs ${res.status}`);
    const body = (await res.json()) as { jobs?: RawJob[] } | RawJob[];
    const list = Array.isArray(body) ? body : (body.jobs ?? []);
    return list.map((job) => ({
        id: job.id ?? "",
        title: job.title ?? job.kind ?? job.type ?? job.id ?? "未命名产物",
        kind: job.kind ?? job.type ?? "—",
        status: statusOf(job.status ?? ""),
        createdAt: (job.created_at ?? "").slice(0, 10),
        media: job.results?.[0]?.url ?? job.results?.[0]?.path,
    }));
}

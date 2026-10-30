export type PrimeProjectCard = {
    id: string;
    title: string;
    source: "studio" | "canvas";
    status: string;
    shotCount: number;
};

export type PrimeProjectsModel = {
    cards: PrimeProjectCard[];
    degraded: "none" | "studio" | "canvas";
};

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchStudioProjects(): Promise<PrimeProjectCard[]> {
    const res = await fetch("/api/studio/projects?limit=200", { headers: authHeaders() });
    if (!res.ok) throw new Error(`studio projects ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.projects ?? []);
    return list.map((project: { id: string; title?: string; status?: string; shots_count?: number }) => ({
        id: project.id,
        title: project.title || project.id,
        source: "studio" as const,
        status: project.status ?? "draft",
        shotCount: project.shots_count ?? 0,
    }));
}

async function fetchCanvasProjects(): Promise<PrimeProjectCard[]> {
    const res = await fetch("/studio/api/canvas-projects", { credentials: "include" });
    if (!res.ok) throw new Error(`canvas projects ${res.status}`);
    const body = await res.json();
    return (body.projects ?? []).map((project: { id: string; title?: string }) => ({
        id: project.id,
        title: project.title || project.id,
        source: "canvas" as const,
        status: "canvas",
        shotCount: 0,
    }));
}

export async function loadPrimeProjects(): Promise<PrimeProjectsModel> {
    const [studio, canvas] = await Promise.allSettled([fetchStudioProjects(), fetchCanvasProjects()]);
    const cards = [
        ...(studio.status === "fulfilled" ? studio.value : []),
        ...(canvas.status === "fulfilled" ? canvas.value : []),
    ];
    const degraded: PrimeProjectsModel["degraded"] =
        studio.status === "rejected" ? "studio" : canvas.status === "rejected" ? "canvas" : "none";
    return { cards, degraded };
}

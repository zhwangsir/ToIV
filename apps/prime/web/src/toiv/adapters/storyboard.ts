export type PrimeTake = { id: string; label: string; seed: number; src?: string; picked: boolean };
export type PrimeBeat = { text: string; kind: string };
export type PrimeShotCard = {
    id: string;
    title: string;
    prompt: string;
    camera: string;
    durationSec: number;
    status: "done" | "run" | "wait";
    beats: PrimeBeat[];
    takes: PrimeTake[];
};
export type PrimeStoryboardModel = { projectId: string; title: string; shots: PrimeShotCard[]; runningCount: number };

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

function statusOf(raw: string): PrimeShotCard["status"] {
    if (raw === "done" || raw === "voiced" || raw === "succeeded" || raw === "success") return "done";
    if (raw === "running" || raw === "rendering" || raw === "processing") return "run";
    return "wait";
}

type RawShot = {
    id: string;
    idx?: number;
    status?: string;
    prompt?: string;
    camera?: string;
    duration_sec?: number;
    beats?: { text?: string; kind?: string }[];
    candidates?: { id: string; seed?: number; is_picked?: boolean; url?: string }[];
};

export async function loadPrimeStoryboard(projectId: string): Promise<PrimeStoryboardModel> {
    const res = await fetch(`/api/studio/projects/${encodeURIComponent(projectId)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`storyboard ${res.status}`);
    const detail = (await res.json()) as { id?: string; title?: string; shots?: RawShot[] };
    const shots: PrimeShotCard[] = (detail.shots ?? []).map((shot, index) => ({
        id: shot.id,
        title: `镜${String(index + 1).padStart(2, "0")}`,
        prompt: shot.prompt ?? "",
        camera: shot.camera || "—",
        durationSec: shot.duration_sec ?? 0,
        status: statusOf(shot.status ?? ""),
        beats: (shot.beats ?? []).map((beat) => ({ text: beat.text ?? "", kind: beat.kind ?? "d" })),
        takes: (shot.candidates ?? []).map((candidate, candidateIndex) => ({
            id: candidate.id,
            label: `T${candidateIndex + 1}`,
            seed: candidate.seed ?? 0,
            src: candidate.url,
            picked: Boolean(candidate.is_picked),
        })),
    }));
    return {
        projectId: detail.id ?? projectId,
        title: detail.title ?? projectId,
        shots,
        runningCount: shots.filter((shot) => shot.status === "run").length,
    };
}

export type PrimeClip = {
    id: string;
    shotId: string;
    track: "v1" | "a1";
    label: string;
    startSec: number;
    durationSec: number;
    src?: string;
};
export type PrimeTimelineModel = { projectId: string; title: string; clips: PrimeClip[]; totalSec: number };

type RawShot = {
    id: string;
    duration_sec?: number;
    dialogue?: string;
    audio_media_status?: string;
    candidates?: { id: string; is_picked?: boolean; url?: string }[];
};

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function loadPrimeTimeline(projectId: string): Promise<PrimeTimelineModel> {
    const res = await fetch(`/api/studio/projects/${encodeURIComponent(projectId)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`timeline ${res.status}`);
    const detail = (await res.json()) as { id?: string; title?: string; shots?: RawShot[] };
    const clips: PrimeClip[] = [];
    let cursor = 0;
    for (const [index, shot] of (detail.shots ?? []).entries()) {
        const durationSec = shot.duration_sec ?? 0;
        const picked = (shot.candidates ?? []).find((candidate) => candidate.is_picked);
        clips.push({
            id: `${shot.id}:v1`,
            shotId: shot.id,
            track: "v1",
            label: `镜${String(index + 1).padStart(2, "0")}`,
            startSec: cursor,
            durationSec,
            src: picked?.url,
        });
        if (shot.dialogue && shot.audio_media_status === "current") {
            clips.push({
                id: `${shot.id}:a1`,
                shotId: shot.id,
                track: "a1",
                label: `对白${String(index + 1).padStart(2, "0")}`,
                startSec: cursor,
                durationSec,
            });
        }
        cursor += durationSec;
    }
    return { projectId: detail.id ?? projectId, title: detail.title ?? projectId, clips, totalSec: cursor };
}

import { fetchDramaProject } from "@/services/toiv/client";

export type EditClip = {
    id: string;
    label: string;
    track: "v1" | "a1" | "a2";
    startSec: number;
    durationSec: number;
    kind: "video" | "dialogue" | "bgm";
    status: "done" | "run" | "wait";
};

export type EditShot = { id: string; title: string; durationSec: number; status: EditClip["status"]; stillSeed: number };

export type EditModel = {
    projectId: string;
    projectName: string;
    clips: EditClip[];
    shots: EditShot[];
    totalSec: number;
    hasBgm: boolean;
};

function statusOf(status: string): EditClip["status"] {
    return status === "done" ? "done" : status === "running" || status === "rendering" ? "run" : "wait";
}

export async function loadEditModel(projectId: string): Promise<EditModel> {
    const detail = await fetchDramaProject(projectId);
    const shots = detail.shots ?? [];
    const clips: EditClip[] = [];
    const strip: EditShot[] = [];
    let cursor = 0;
    shots.forEach((shot, index) => {
        const duration = shot.duration_sec ?? 0;
        const status = statusOf(shot.status);
        clips.push({ id: `v-${shot.id}`, label: `SHOT${String(index + 1).padStart(2, "0")} · ${duration}s`, track: "v1", startSec: cursor, durationSec: duration, kind: "video", status });
        if (shot.dialogue && shot.audio_media_status === "done") {
            clips.push({ id: `a-${shot.id}`, label: `对白 · 镜${String(index + 1).padStart(2, "0")}`, track: "a1", startSec: cursor, durationSec: duration, kind: "dialogue", status: "done" });
        }
        strip.push({ id: shot.id, title: `镜${String(index + 1).padStart(2, "0")}`, durationSec: duration, status, stillSeed: shot.candidates?.find((candidate) => candidate.is_picked)?.seed ?? 0 });
        cursor += duration;
    });
    const bgmUrl = (detail as { bgm_url?: string }).bgm_url;
    if (bgmUrl) clips.push({ id: "a-bgm", label: "BGM", track: "a2", startSec: 0, durationSec: cursor, kind: "bgm", status: "done" });
    return { projectId, projectName: detail.title ?? projectId, clips, shots: strip, totalSec: cursor, hasBgm: Boolean(bgmUrl) };
}

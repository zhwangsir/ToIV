import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const preview = {
    fps: 24,
    content_mode: "sfw",
    items: [
        { shot_id: "s1", idx: 0, kind: "video", preview_url: "/k/1.jpg", media_url: "/api/studio/files/s1.mp4", duration_sec: 4, nsfw: false },
        { shot_id: "s2", idx: 1, kind: null, preview_url: "", duration_sec: 6, nsfw: false },
        { shot_id: "s3", idx: 2, kind: "video", preview_url: "/k/3.jpg", media_url: "/api/studio/files/s3.mp4", duration_sec: 5, nsfw: false },
    ],
};

function makeDetail() {
    return {
        id: "p1", title: "雨夜便利店", fps: 24, bgm_url: "/api/studio/files/bgm.mp3",
        final_url: "/api/studio/files/final.mp4", status: "ready", stage_states: {}, stage_revision: 4,
        shots: [
            {
                id: "s1", idx: 0, prompt: "店内", scene: "便利店", camera: "STATIC", dialogue: "欢迎光临",
                speaker: "林夏", duration_sec: 4, current_revision_id: "r1",
                final_clip_url: "/api/studio/files/s1.mp4", video_url: "/api/studio/files/s1v.mp4",
                voice_url: "/api/studio/files/s1.mp3", image_url: "/api/studio/files/s1.jpg",
                visual_media_status: "current", audio_media_status: "current", final_media_status: "current",
                candidates: [], beats: [],
            },
            {
                id: "s2", idx: 1, prompt: "空镜", scene: "门口", camera: "PAN", dialogue: "",
                speaker: "", duration_sec: 6, current_revision_id: "r2", final_clip_url: "", video_url: "",
                voice_url: "", image_url: "", visual_media_status: "none", audio_media_status: "none",
                final_media_status: "none", candidates: [], beats: [],
            },
            {
                id: "s3", idx: 2, prompt: "雨", scene: "街口", camera: "DOLLY", dialogue: "再见",
                speaker: "林夏", duration_sec: 5, current_revision_id: "r3",
                final_clip_url: "/api/studio/files/s3.mp4", video_url: "/api/studio/files/s3v.mp4",
                voice_url: "", image_url: "/api/studio/files/s3.jpg",
                visual_media_status: "current", audio_media_status: "none", final_media_status: "stale",
                candidates: [], beats: [{ text: "画面", kind: "v", cues: [], anchor_words: "", block: 0 },
                    { text: "再见", kind: "d", cues: [], anchor_words: "", block: 0 }],
            },
        ],
    };
}

describe("prime edit bay model", () => {
    test("projects four tracks with export cut points and skips shots without a final clip", async () => {
        const { parsePrimeEditBay } = await import("../src/toiv/adapters/edit");
        const model = parsePrimeEditBay(makeDetail(), preview, "p1");
        const v1 = model.clips.filter((clip) => clip.track === "v1");
        expect(v1.map((clip) => [clip.shotId, clip.startSec, clip.durationSec])).toEqual([
            ["s1", 0, 4], ["s3", 4, 5],
        ]);
        expect(v1[0].src).toBe("/api/studio/files/s1.mp4");
        expect(model.clips.filter((clip) => clip.track === "a1").map((clip) => clip.shotId)).toEqual(["s1"]);
        expect(model.clips.filter((clip) => clip.track === "s1").map((clip) => [clip.shotId, clip.text]))
            .toEqual([["s1", "欢迎光临"], ["s3", "再见"]]);
        expect(model.clips.filter((clip) => clip.track === "a2").map((clip) => [clip.startSec, clip.durationSec]))
            .toEqual([[0, 9]]);
        expect(model.totalSec).toBe(9);
        expect(model.issues.missing.map((issue) => issue.shotId)).toEqual(["s2"]);
        expect(model.noVoice).toEqual(["s3"]);
        expect(model.shots[2].minSec).toBe(3);
        expect(model.shots[0].minSec).toBe(1);
        expect(model.finalUrl).toBe("/api/studio/files/final.mp4");
        expect(model.fps).toBe(24);
    });

    test("reports illegal durations and missing preview data instead of guessing", async () => {
        const { parsePrimeEditBay } = await import("../src/toiv/adapters/edit");
        const detail = makeDetail();
        detail.shots[0].duration_sec = 0;
        detail.shots[2].duration_sec = 61;
        const model = parsePrimeEditBay(detail, preview, "p1");
        expect(model.issues.duration.map((issue) => [issue.shotId, issue.kind])).toEqual([
            ["s1", "illegal_duration"], ["s3", "duration_over_limit"],
        ]);
        expect(() => parsePrimeEditBay({ ...detail, id: "other" }, preview, "p1")).toThrow(/响应不完整/);
        expect(() => parsePrimeEditBay(detail, { items: [] }, "p1")).toThrow(/响应不完整/);
    });

    test("projects local trims into cut points and clamps to the shot bounds", async () => {
        const { parsePrimeEditBay, projectPrimeEditBay } = await import("../src/toiv/adapters/edit");
        const model = parsePrimeEditBay(makeDetail(), preview, "p1");
        const next = projectPrimeEditBay(model, { s1: 6 });
        expect(next.dirty).toEqual(["s1"]);
        expect(next.totalSec).toBe(11);
        expect(next.clips.filter((clip) => clip.track === "v1").map((clip) => clip.startSec)).toEqual([0, 6]);
        expect(next.clips.filter((clip) => clip.track === "a2")[0].durationSec).toBe(11);
        expect(projectPrimeEditBay(model, { s1: 0 }).clips.filter((clip) => clip.track === "v1")[0].durationSec).toBe(1);
        expect(projectPrimeEditBay(model, { s3: 1 }).clips.filter((clip) => clip.track === "v1")[1].durationSec).toBe(3);
        expect(projectPrimeEditBay(model, { s1: 4 }).dirty).toEqual([]);
    });

    test("saves only through the existing shots PUT with revisions and reloads", async () => {
        const detail = makeDetail();
        const calls: { method: string; path: string; body: any }[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = String(input);
            const method = init?.method ?? "GET";
            calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (method === "PUT") {
                const body = JSON.parse(String(init.body));
                detail.shots = body.shots.map((shot: any, index: number) => ({ ...detail.shots[index], ...shot }));
                return json({ shots: detail.shots });
            }
            if (path.endsWith("/timeline-preview")) return json(preview);
            return json(detail);
        }) as typeof fetch;
        const { loadPrimeEditBay, savePrimeEditDurations } = await import("../src/toiv/adapters/edit");
        const model = await loadPrimeEditBay("p1");
        const saved = await savePrimeEditDurations(model, { s1: 6 });
        const put = calls.find((call) => call.method === "PUT");
        expect(put?.path).toBe("/api/studio/projects/p1/shots");
        expect(put?.body.expected_shot_ids).toEqual(["s1", "s2", "s3"]);
        expect(put?.body.shots).toHaveLength(3);
        expect(put?.body.shots[0].duration_sec).toBe(6);
        expect(put?.body.shots[0].expected_revision).toBe("r1");
        expect(put?.body.shots[2].beats).toHaveLength(2);
        expect(saved.shots[0].durationSec).toBe(6);
        expect(saved.totalSec).toBe(11);
        await expect(savePrimeEditDurations(model, { s1: 4.5 })).rejects.toThrow(/整数秒/);
        await expect(savePrimeEditDurations(model, { s1: 61 })).rejects.toThrow(/1–60|1-60/);
    });
});

describe("prime edit bay export", () => {
    test("preflights with a HEAD request and reads the export receipt headers", async () => {
        const calls: { method: string; path: string }[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ method: init?.method ?? "GET", path: String(input) });
            return new Response(null, { status: 200, headers: {
                "X-Toiv-Missing-Assets": "2", "X-Toiv-Duration-Issues": "1",
            } });
        }) as typeof fetch;
        const { loadPrimeExportPreflight } = await import("../src/toiv/adapters/edit");
        const result = await loadPrimeExportPreflight("p1");
        expect(calls[0]).toEqual({ method: "HEAD", path: "/api/studio/projects/p1/export/edl" });
        expect(result).toEqual({ state: "ok", missingAssets: 2, durationIssues: 1, detail: "" });
    });

    test("preflight turns 422 into a blocked reason and missing headers into unknown", async () => {
        const { loadPrimeExportPreflight } = await import("../src/toiv/adapters/edit");
        globalThis.fetch = (async () => json({ detail: "无可用成片片段（缺 final_clip_url）" }, 422)) as typeof fetch;
        expect(await loadPrimeExportPreflight("p1")).toMatchObject({
            state: "blocked", detail: "无可用成片片段（缺 final_clip_url）",
        });
        globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
        expect(await loadPrimeExportPreflight("p1")).toMatchObject({ state: "unknown" });
    });

    test("downloads a draft with its filename and receipt counts", async () => {
        globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: {
            "Content-Disposition": "attachment; filename=\"toiv-draft.zip\"; filename*=UTF-8''%E9%9B%A8%E5%A4%9C.zip",
            "X-Toiv-Draft-Format": "toiv_jianying_draft_v1",
            "X-Toiv-Media-Copied": "3",
        } })) as typeof fetch;
        const { fetchPrimeExport } = await import("../src/toiv/adapters/edit");
        const file = await fetchPrimeExport("p1", "jianying");
        expect(file.filename).toBe("雨夜.zip");
        expect(file.format).toBe("toiv_jianying_draft_v1");
        expect(file.missingAssets).toBeNull();
        expect(file.blob.size).toBe(3);
    });

    test("export failures surface the server detail", async () => {
        globalThis.fetch = (async () => json({ detail: "无可用成片片段（缺 final_clip_url）" }, 422)) as typeof fetch;
        const { fetchPrimeExport } = await import("../src/toiv/adapters/edit");
        await expect(fetchPrimeExport("p1", "edl")).rejects.toThrow(/无可用成片片段/);
    });

    test("formats the transport clock at tenths", async () => {
        const { formatPrimeTime } = await import("../src/toiv/adapters/edit");
        expect(formatPrimeTime(0)).toBe("00:00.0");
        expect(formatPrimeTime(4)).toBe("00:04.0");
        expect(formatPrimeTime(65.4)).toBe("01:05.4");
        expect(formatPrimeTime(3599.96)).toBe("59:59.9");
    });
});

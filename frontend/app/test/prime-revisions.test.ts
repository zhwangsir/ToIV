import { afterEach, describe, expect, test } from "bun:test";
import * as storyboard from "../src/toiv/adapters/storyboard";
import * as revisions from "../src/toiv/adapters/revisions";
import * as production from "../src/toiv/adapters/production";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
type Call = { path: string; method: string; body: any };
function api(handler: (call: Call) => unknown | Response) {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = { path: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const result = handler(call);
        return result instanceof Response ? result : Response.json(result);
    }) as typeof fetch;
    return calls;
}
function rawShot(patch: Record<string, unknown> = {}) {
    return {
        id: "sh1", idx: 0, status: "voiced", prompt: "晨雾", scene: "崖边", camera: "STATIC", duration_sec: 6,
        dialogue: "借箭十万", speaker: "诸葛亮", characters: ["诸葛亮"], render_mode: "video",
        current_revision_id: "rev3", video_url: "/api/studio/files/1.mp4", voice_url: "/api/studio/files/1.wav",
        final_clip_url: "/api/studio/files/final.mp4", lipsync_skipped: true,
        visual_media_status: "current", audio_media_status: "stale", final_media_status: "none",
        candidates_digest: "digest1", candidates: [],
        beats: [], ...patch,
    };
}
function project(shot: Record<string, unknown> = {}) {
    return { id: "p1", title: "草船借箭", status: "ready", final_url: "/api/studio/files/final.mp4",
        bgm_url: "/api/studio/files/bgm.mp3", shots: [rawShot(shot)], stage_states: {}, stage_revision: 3 };
}

describe("Prime shot production projection", () => {
    test("keeps media status, dialogue and final outputs instead of hiding stale state", async () => {
        api(() => project());
        const model = await storyboard.loadPrimeStoryboard("p1");
        expect(model.shots[0]).toMatchObject({
            id: "sh1", dialogue: "借箭十万", speaker: "诸葛亮", renderMode: "video",
            voiceUrl: "/api/studio/files/1.wav", finalClipUrl: "/api/studio/files/final.mp4",
            videoUrl: "/api/studio/files/1.mp4", lipsyncSkipped: true, revisionId: "rev3",
            media: { visual: "current", audio: "stale", final: "none" },
        });
        expect(model.finalUrl).toBe("/api/studio/files/final.mp4");
        expect(model.projectStatus).toBe("ready");
    });
    test("treats a missing media projection as unknown rather than faking synchronization", async () => {
        const { visual_media_status, audio_media_status, final_media_status, ...rest } = rawShot();
        api(() => ({ ...project(), shots: [rest] }));
        const model = await storyboard.loadPrimeStoryboard("p1");
        expect(model.shots[0].media).toEqual({ visual: "unknown", audio: "unknown", final: "unknown" });
    });
    test("rejects an unrecognized media status instead of guessing", async () => {
        api(() => project({ visual_media_status: "fresh-ish" }));
        await expect(storyboard.loadPrimeStoryboard("p1")).rejects.toThrow("分镜响应不完整");
    });
});

describe("Prime revision history contracts", () => {
    test("lists newest-first revisions with their fingerprints", async () => {
        const calls = api(call => {
            expect(call.path).toBe("/api/studio/shots/sh1/revisions");
            return { shot_id: "sh1", revisions: [
                { id: "rev3", version: 3, source: "rollback", parent_id: "rev2", visual_fingerprint: "vf3",
                    audio_fingerprint: "af3", created_by: "u1", created_at: "2026-11-01T04:00:00" },
                { id: "rev2", version: 2, source: "render", parent_id: "rev1", visual_fingerprint: "vf2",
                    audio_fingerprint: "af2", created_by: "u1", created_at: "2026-11-01T03:00:00" },
            ] };
        });
        const rows = await revisions.listPrimeRevisions("sh1");
        expect(calls).toHaveLength(1);
        expect(rows.map(row => [row.id, row.version, row.source, row.parentId])).toEqual([
            ["rev3", 3, "rollback", "rev2"], ["rev2", 2, "render", "rev1"],
        ]);
    });
    test("refuses a revision list for another shot", async () => {
        api(() => ({ shot_id: "other", revisions: [] }));
        await expect(revisions.listPrimeRevisions("sh1")).rejects.toThrow("修订");
    });
    test("parses a field-level diff and marks a missing upstream explicitly", async () => {
        api(() => ({ revision_id: "rev3", version: 3, source: "rollback", from_version: 2, from_unknown: false,
            fields: { prompt: { from: "旧词", to: "新词" }, dialogue: { from: null, to: "借箭十万" } } }));
        const diff = await revisions.diffPrimeRevision("sh1", "rev3");
        expect(diff.fields).toEqual({ prompt: { from: "旧词", to: "新词" }, dialogue: { from: null, to: "借箭十万" } });
        expect(diff.fromUnknown).toBe(false);
        expect(diff.fromVersion).toBe(2);

        api(() => ({ revision_id: "rev1", version: 1, source: "imported", from_version: null, from_unknown: true,
            fields: { prompt: { from: null, to: "首版" } } }));
        const first = await revisions.diffPrimeRevision("sh1", "rev1");
        expect(first.fromUnknown).toBe(true);
        expect(first.fromVersion).toBeNull();
    });
    test("rejects a diff entry that cannot be compared", async () => {
        api(() => ({ revision_id: "rev3", version: 3, source: "rollback", from_version: 2, from_unknown: false,
            fields: { prompt: { from: "旧词" } } }));
        await expect(revisions.diffPrimeRevision("sh1", "rev3")).rejects.toThrow("修订差异");
    });
    test("rolls back with the live revision baseline and verifies the returned shot", async () => {
        const calls = api(call => {
            expect(call.method).toBe("POST");
            return rawShot({ current_revision_id: "rev4" });
        });
        await revisions.rollbackPrimeShot("sh1", "rev1", "rev3");
        expect(calls[0].path).toBe("/api/studio/shots/sh1/rollback");
        expect(calls[0].body).toEqual({ revision_id: "rev1", expected_revision: "rev3" });
    });
    test("surfaces a 409 baseline conflict instead of claiming the rollback landed", async () => {
        api(() => new Response(JSON.stringify({ detail: "分镜已被其他修改更新(current=rev9)" }), { status: 409 }));
        await expect(revisions.rollbackPrimeShot("sh1", "rev1", "rev3")).rejects.toThrow("分镜已被其他修改更新");
    });
});

describe("Prime voice, lipsync and assemble contracts", () => {
    test("voice posts once and returns the updated shot media projection", async () => {
        const calls = api(call => rawShot({ voice_url: "/api/studio/files/new.wav", audio_media_status: "current" }));
        const card = await production.synthesizePrimeVoice("sh1", 0);
        expect(calls[0]).toMatchObject({ path: "/api/studio/shots/sh1/voice", method: "POST" });
        expect(card.voiceUrl).toBe("/api/studio/files/new.wav");
        expect(card.media.audio).toBe("current");
    });
    test("voice rejects a response for a different shot", async () => {
        api(() => rawShot({ id: "sh2" }));
        await expect(production.synthesizePrimeVoice("sh1", 0)).rejects.toThrow("分镜");
    });
    test("lipsync and its skip use distinct endpoints and keep the final status", async () => {
        const calls = api(call => rawShot({ final_clip_url: "/api/studio/files/lipsync.mp4", final_media_status: "current" }));
        const card = await production.lipsyncPrimeShot("sh1", 0);
        await production.skipPrimeLipsync("sh1", 0);
        expect(calls.map(call => [call.method, call.path])).toEqual([
            ["POST", "/api/studio/shots/sh1/lipsync"],
            ["POST", "/api/studio/shots/sh1/lipsync/skip"],
        ]);
        expect(card.media.final).toBe("current");
    });
    test("assemble returns the refreshed project with its final output", async () => {
        const calls = api(call => project());
        const model = await production.assemblePrimeProject("p1");
        expect(calls[0]).toMatchObject({ path: "/api/studio/projects/p1/assemble", method: "POST" });
        expect(model.projectId).toBe("p1");
        expect(model.finalUrl).toBe("/api/studio/files/final.mp4");
        expect(model.shots).toHaveLength(1);
    });
    test("assemble surfaces the stale-clip gate", async () => {
        api(() => new Response(JSON.stringify({ detail: "最终片段已过期,请重渲染/重对口型后再合成:镜1" }), { status: 409 }));
        await expect(production.assemblePrimeProject("p1")).rejects.toThrow("最终片段已过期");
    });
    test("assemble refuses a project detail for a different project", async () => {
        api(() => ({ ...project(), id: "p2" }));
        await expect(production.assemblePrimeProject("p1")).rejects.toThrow("项目");
    });
});

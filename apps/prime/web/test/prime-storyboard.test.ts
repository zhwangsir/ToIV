import { afterEach, describe, expect, test } from "bun:test";
import * as storyboard from "../src/toiv/adapters/storyboard";

const realFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
    globalThis.fetch = realFetch;
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
function stubProject() {
    return { id: "p1", title: "草船借箭", shots: [
        { id: "sh1", idx: 0, status: "voiced", prompt: "晨雾", scene: "崖边", camera: "STATIC", duration_sec: 6,
            dialogue: "旧词", speaker: "甲", negative: "blur", characters: ["甲"], render_mode: "image_motion",
            seam_to_next: "continue", seam_anchor: "崖", ref_epoch: 2, ref_epoch_note: "换装", current_revision_id: "rev1",
            beats: [{ text: "旧词", kind: "d", cues: ["光"], anchor_words: "词", block: 1, start_sec: 0, end_sec: 6 }],
            candidates_digest: "digest1", video_url: "/api/studio/files/old.mp4", video_model: "ltx",
            candidates: [
                { id: "c1", seed: 88213, status: "done", is_picked: true, url: "/api/studio/files/1.mp4", video_model: "h3", pipeline: "ref2va", revision_id: "rev0", qa: { verdict: "pass" } },
                { id: "c2", seed: 88214, status: "done", is_picked: false, url: "https://cdn.example/2.mp4", video_model: "ltx", pipeline: "fl2va", revision_id: "rev1" },
                { id: "c3", seed: 0, status: "error", url: "", error: "GPU unavailable" },
            ] },
        { id: "sh2", idx: 1, status: "running", prompt: "睁眼", camera: "DOLLY IN", duration_sec: 3, current_revision_id: "rev2" },
        { id: "sh3", idx: 2, status: "error", prompt: "", duration_sec: 6, error: "engine failed", current_revision_id: "" },
    ] };
}
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

describe("Prime storyboard read and write contracts", () => {
    test("retains failure state and actual candidate comparison fields", async () => {
        api(() => stubProject());
        const model = await storyboard.loadPrimeStoryboard("p1");
        expect(model.shots.map(s => s.status)).toEqual(["done", "run", "error"]);
        expect(model.runningCount).toBe(1);
        expect(model.shots[0].candidatesDigest).toBe("digest1");
        expect(model.shots[0].takes[0]).toMatchObject({ id: "c1", status: "done", seed: 88213, videoModel: "h3", pipeline: "ref2va", revisionId: "rev0", qaVerdict: "pass", picked: true });
        expect(model.shots[0].takes[2].error).toBe("GPU unavailable");
        expect(model.shots[1].beats).toEqual([]);
    });
    test("prompt PUT whitelists every shot and beat declaration, retains baseline revisions, and returns saved truth", async () => {
        let project = stubProject();
        const calls = api(call => {
            if (call.method === "PUT") {
                project = { ...project, shots: project.shots.map(s => s.id === "sh2" ? { ...s, prompt: "新提示词", current_revision_id: "rev3" } : s) };
                return { shots: project.shots };
            }
            return project;
        });
        const before = await storyboard.loadPrimeStoryboard("p1");
        const result = await storyboard.savePrimeShotPrompt(before, "sh2", "新提示词");
        const put = calls.find(c => c.method === "PUT")!;
        expect(put.path).toBe("/api/studio/projects/p1/shots");
        expect(put.body.shots).toHaveLength(3);
        expect(put.body.shots[0]).toEqual({ id: "sh1", scene: "崖边", prompt: "晨雾", negative: "blur", camera: "STATIC", dialogue: "旧词", speaker: "甲", duration_sec: 6, characters: ["甲"], render_mode: "image_motion", seam_to_next: "continue", seam_anchor: "崖", ref_epoch: 2, ref_epoch_note: "换装", beats: [{ text: "旧词", kind: "d", cues: ["光"], anchor_words: "词", block: 1 }], expected_revision: "rev1" });
        expect(put.body.shots[1].prompt).toBe("新提示词");
        expect(put.body.shots[1].expected_revision).toBe("rev2");
        expect(put.body.shots[2].expected_revision).toBe("");
        expect(before.shots[1].prompt).toBe("睁眼");
        expect(result.shots[1].prompt).toBe("新提示词");
    });
    test("refuses derived prompt edits when the shot has beats", async () => {
        const calls = api(() => stubProject());
        const model = await storyboard.loadPrimeStoryboard("p1");
        await expect(storyboard.savePrimeShotPrompt(model, "sh1", "不能覆盖拍")).rejects.toThrow("拍");
        expect(calls.filter(c => c.method !== "GET")).toHaveLength(0);
    });
    test("detects a missing target rather than silently saving an unchanged list", async () => {
        const calls = api(() => stubProject());
        const model = await storyboard.loadPrimeStoryboard("p1");
        await expect(storyboard.savePrimeShotPrompt(model, "missing", "词")).rejects.toThrow();
        expect(calls.some(c => c.method === "PUT")).toBe(false);
    });
    test("preflight refuses remote revision or list changes instead of rebasing stale edits", async () => {
        api(() => stubProject());
        const model = await storyboard.loadPrimeStoryboard("p1");
        const changed = stubProject();
        changed.shots[1].current_revision_id = "remote";
        const calls = api(() => changed);
        await expect(storyboard.savePrimeShotPrompt(model, "sh2", "本地草稿")).rejects.toThrow("刷新");
        expect(calls.some(c => c.method === "PUT")).toBe(false);
    });
    test("PUT 409 propagates refresh guidance without retrying", async () => {
        const calls = api(call => call.method === "PUT" ? Response.json({ detail: "revision changed" }, { status: 409 }) : stubProject());
        const model = await storyboard.loadPrimeStoryboard("p1");
        await expect(storyboard.savePrimeShotPrompt(model, "sh2", "新词")).rejects.toThrow("刷新");
        expect(calls.filter(c => c.method === "PUT")).toHaveLength(1);
    });
    test("beat edit posts equal-length texts and total_sec with persist, then reloads derived fields", async () => {
        let project = stubProject();
        const calls = api(call => {
            if (call.path.endsWith("reflow-beats")) {
                project.shots[0].beats![0].text = "新词";
                project.shots[0].dialogue = "新词";
                project.shots[0].duration_sec = 9;
                return project.shots[0];
            }
            return project;
        });
        const model = await storyboard.loadPrimeStoryboard("p1");
        const next = await storyboard.savePrimeShotBeats(model, "sh1", ["新词"], 9);
        expect(calls.find(c => c.method === "POST")).toEqual({ path: "/api/studio/shots/sh1/reflow-beats", method: "POST", body: { texts: ["新词"], total_sec: 9, persist: true } });
        expect(calls.at(-1)?.method).toBe("GET");
        expect(next.shots[0].beats[0].text).toBe("新词");
        expect(next.shots[0].durationSec).toBe(9);
    });
    test("rejects changed beat count and invalid reflow duration without writing", async () => {
        const calls = api(() => stubProject());
        const model = await storyboard.loadPrimeStoryboard("p1");
        for (const [texts, sec] of [[[], 6], [["a"], 2], [["a"], 6.5]] as [string[], number][]) {
            await expect(storyboard.savePrimeShotBeats(model, "sh1", texts, sec)).rejects.toThrow();
        }
        expect(calls.some(c => c.method === "POST")).toBe(false);
    });
    test("pick sends server digest and returns only confirmed selection", async () => {
        const project = stubProject();
        const calls = api(call => {
            if (call.method === "POST") return { ...project.shots[0], candidates_digest: "digest2", candidates: project.shots[0].candidates!.map(c => ({ ...c, is_picked: c.id === "c2" })) };
            return project;
        });
        const model = await storyboard.loadPrimeStoryboard("p1");
        const next = await storyboard.pickPrimeTake(model.shots[0], "c2");
        expect(calls.find(c => c.method === "POST")).toEqual({ path: "/api/studio/shots/sh1/candidates/c2/pick", method: "POST", body: { expected_candidates_digest: "digest1" } });
        expect(model.shots[0].takes[0].picked).toBe(true);
        expect(next.takes.find(t => t.id === "c2")?.picked).toBe(true);
        expect(next.candidatesDigest).toBe("digest2");
    });
    test("incomplete candidates and missing digest cannot bypass pick validation", async () => {
        const calls = api(() => stubProject());
        const model = await storyboard.loadPrimeStoryboard("p1");
        const shot = model.shots[0];
        await expect(storyboard.pickPrimeTake(shot, "c3")).rejects.toThrow();
        await expect(storyboard.pickPrimeTake({ ...shot, candidatesDigest: undefined }, "c2")).rejects.toThrow();
        await expect(storyboard.pickPrimeTake({ ...shot, takes: shot.takes.map(t => ({ ...t, status: "queued" })) }, "c2")).rejects.toThrow();
        expect(calls.some(c => c.method === "POST")).toBe(false);
    });
    test("pick conflicts and server errors stay visible and leave selection unchanged", async () => {
        for (const status of [409, 503]) {
            api(call => call.method === "POST" ? Response.json({ detail: "pick failed" }, { status }) : stubProject());
            const model = await storyboard.loadPrimeStoryboard("p1");
            await expect(storyboard.pickPrimeTake(model.shots[0], "c2")).rejects.toThrow(status === 409 ? "刷新" : "503");
            expect(model.shots[0].takes[0].picked).toBe(true);
        }
    });
    test("media signs only same-origin API files, never external or protocol-relative URLs", () => {
        Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "test-token" } });
        expect(storyboard.primeTakeMediaUrl("/api/studio/files/1.mp4?x=1")).toBe("/api/studio/files/1.mp4?x=1&token=test-token");
        for (const url of ["https://cdn.example/a.mp4", "//cdn.example/a.mp4", "https://evil.example/api/studio/files/a.mp4"]) {
            expect(storyboard.primeTakeMediaUrl(url)).toBe(url);
        }
        expect(storyboard.primeTakeMediaUrl("javascript:alert(1)")).toBe("");
    });
});

import { afterEach, describe, expect, test } from "bun:test";
import * as create from "../src/toiv/adapters/create";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const parsed = {
    shots: [
        { scene: "夜", prompt: "推近", camera: "", dialogue: "你好", speaker: "小雨", duration_sec: 6,
            characters: ["小雨"], render_mode: "video", beats: [{ text: "你好", kind: "d", cues: ["光"], anchor_words: "好", block: 0 }] },
        { scene: "窗边", prompt: "回头", camera: "", dialogue: "", speaker: "", duration_sec: 3,
            characters: ["阿明"], render_mode: "video", beats: [{ text: "回头", kind: "v", cues: [], anchor_words: "", block: 0 }] },
    ],
    characters: ["小雨", " 小雨 ", "阿明"], count: 2,
};
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
function normal(call: Call) {
    if (call.path === "/api/studio/projects") return { id: "p9", title: "新剧" };
    if (call.method === "GET") return { id: "p9", characters: [], shots: [] };
    if (call.path.endsWith("import-svml")) return parsed;
    if (call.path.endsWith("characters")) return { id: "char", name: call.body.name };
    return { shots: parsed.shots.map(shot => ({ ...shot, id: "s1" })) };
}

describe("Prime create persistence and recovery", () => {
    test("parser success is not import success: creates named characters before saving every parsed shot", async () => {
        const calls = api(normal);
        const result = await create.createPrimeProject({ title: " 新剧 ", svml: "推近||<小雨>你好" });
        expect(result).toEqual({ id: "p9", title: "新剧", imported: true });
        expect(calls.filter(c => c.path.endsWith("characters")).map(c => c.body)).toEqual([{ name: "小雨" }, { name: "阿明" }]);
        const put = calls.find(c => c.method === "PUT");
        expect(put?.path).toBe("/api/studio/projects/p9/shots");
        expect(put?.body.shots).toMatchObject(parsed.shots);
        expect(calls.indexOf(put!)).toBeGreaterThan(calls.findLastIndex(c => c.path.endsWith("characters")));
        expect(calls[0].body.title).toBe("新剧");
    });
    test("skips import without SVML", async () => {
        const calls = api(normal);
        expect((await create.createPrimeProject({ title: "新剧" })).imported).toBe(false);
        expect(calls).toHaveLength(1);
    });
    for (const stage of ["import-svml", "characters", "shots"]) {
        test(`retains project ID and script after ${stage} failure`, async () => {
            api(call => call.path.endsWith(`/${stage}`) ? new Response("failure", { status: 503 }) : normal(call));
            const result = await create.createPrimeProject({ title: "新剧", svml: "原始脚本" });
            expect(result.id).toBe("p9");
            expect(result.imported).toBe(false);
            expect(result.recovery?.script).toBe("原始脚本");
            expect(result.recovery?.message).toContain("503");
        });
    }
    test("retry reads existing data, skips existing names and never posts another project", async () => {
        api(call => call.path.endsWith("/shots") ? new Response("down", { status: 503 }) : normal(call));
        const failed = await create.createPrimeProject({ title: "新剧", svml: "原词" });
        const calls = api(call => call.method === "GET" ? { id: "p9", shots: [], characters: [{ id: "c1", name: "小雨" }] } : normal(call));
        const result = await create.retryPrimeImport(failed, "修正脚本");
        expect(result.imported).toBe(true);
        expect(calls[0].method).toBe("GET");
        expect(calls.some(c => c.path === "/api/studio/projects")).toBe(false);
        expect(calls.filter(c => c.path.endsWith("characters")).map(c => c.body.name)).toEqual(["阿明"]);
        expect(calls.find(c => c.path.endsWith("import-svml"))?.body).toEqual({ script: "修正脚本" });
    });
    test("retry preserves existing shots, including a possibly successful prior PUT", async () => {
        const calls = api(call => call.method === "GET" ? { id: "p9", shots: [{ id: "edited", prompt: "人工编辑" }], characters: [] } : normal(call));
        const result = await create.retryPrimeImport({ id: "p9", title: "新剧", imported: false }, "原词");
        expect(result.imported).toBe(false);
        expect(result.recovery?.message).toMatch(/已有.*镜头.*保留/);
        expect(calls.every(c => c.method === "GET")).toBe(true);
    });
    test("rechecks shots after character creation instead of replacing concurrent edits", async () => {
        let reads = 0;
        const calls = api(call => call.method === "GET"
            ? { id: "p9", characters: [], shots: ++reads > 1 ? [{ id: "other" }] : [] }
            : normal(call));
        const result = await create.createPrimeProject({ title: "新剧", svml: "原词" });
        expect(result.imported).toBe(false);
        expect(result.recovery?.message).toContain("保留");
        expect(calls.some(c => c.method === "PUT")).toBe(false);
    });
    test("malformed or unreadable recovery data never permits a destructive PUT", async () => {
        const calls = api(call => call.method === "GET" ? {} : normal(call));
        const result = await create.retryPrimeImport({ id: "p9", title: "新剧", imported: false }, "原词");
        expect(result.recovery).toBeDefined();
        expect(calls.some(c => c.method === "PUT")).toBe(false);
    });
    test("project creation failure is still thrown, not reported as a recoverable project", async () => {
        api(() => new Response("no", { status: 403 }));
        await expect(create.createPrimeProject({ title: "新剧" })).rejects.toThrow("403");
    });
});

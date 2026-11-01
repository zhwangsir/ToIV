import { afterEach, expect, test } from "bun:test";
import { fetchGenerationJob, submitT2I, submitT2V } from "../src/toiv/adapters/generation";
import { PRIME_TOOLS, resolveToolId } from "../src/toiv/tools/catalog";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("txt2img submits ToIV generation fields and unwraps the prompt id", async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), body: JSON.parse(String(init?.body)) };
        return json({ prompt_id: "p-1", seed: 42 });
    }) as typeof fetch;
    const result = await submitT2I({ prompt: "雨夜街口", negative: "水印", ratio: "16:9" });
    expect(result).toEqual({ promptId: "p-1", seed: 42 });
    expect(seen!.url).toBe("/api/generate/txt2img");
    expect(seen!.body).toMatchObject({ positive: "雨夜街口", negative: "水印", width: 1024, height: 576 });
    expect(seen!.body).not.toHaveProperty("seed");
});

test("txt2video maps the duration choice to a 4n+1 frame count", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return json({ prompt_id: "v-1" });
    }) as typeof fetch;
    await submitT2V({ prompt: "推镜", ratio: "9:16", duration: "long" });
    expect(body).toMatchObject({ positive: "推镜", width: 576, height: 1024, length: 97, fps: 16 });
});

test("backend detail is surfaced when generation is rejected", async () => {
    globalThis.fetch = (async () => json({ detail: "worker 忙" }, 503)) as typeof fetch;
    await expect(submitT2I({ prompt: "x", negative: "", ratio: "1:1" })).rejects.toThrow("worker 忙");
});

test("job polling finds the prompt in the latest jobs and normalises results", async () => {
    globalThis.fetch = (async () => json([
        { prompt_id: "other", status: "done", results: [] },
        { prompt_id: "p-1", status: "done", results: ["/api/images/a.png"], error: "" },
    ])) as typeof fetch;
    expect(await fetchGenerationJob("p-1")).toEqual({ status: "done", results: ["/api/images/a.png"], error: "" });
});

test("job polling returns null while the job is not listed yet", async () => {
    globalThis.fetch = (async () => json([{ prompt_id: "other", status: "queued", results: [] }])) as typeof fetch;
    expect(await fetchGenerationJob("p-1")).toBeNull();
});

test("non-array results and failures are handled without throwing", async () => {
    globalThis.fetch = (async () => json([{ prompt_id: "p-1", status: "error", results: { error: "boom" } }])) as typeof fetch;
    expect(await fetchGenerationJob("p-1")).toEqual({ status: "error", results: [], error: "" });
});

test("the tools catalogue keeps image and video as the only runnable entries", () => {
    expect(PRIME_TOOLS.filter((tool) => tool.available).map((tool) => tool.id)).toEqual(["t2i", "t2v"]);
    expect(PRIME_TOOLS.filter((tool) => !tool.available).length).toBeGreaterThan(0);
});

test("legacy tool ids resolve to their native counterpart", () => {
    expect(resolveToolId("image")).toBe("t2i");
    expect(resolveToolId("t2i")).toBe("t2i");
    expect(resolveToolId("video")).toBe("t2v");
    expect(resolveToolId("t2v")).toBe("t2v");
    expect(resolveToolId("ecommerce")).toBeUndefined();
});

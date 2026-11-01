import { afterEach, expect, test } from "bun:test";
import { fetchGenerationJob, submitT2I, submitT2V } from "../src/toiv/adapters/generation";
import { PRIME_TOOLS, resolveToolId } from "../src/toiv/tools/catalog";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("txt2img submits capability-derived size and model, then unwraps the prompt id", async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), body: JSON.parse(String(init?.body)) };
        return json({ prompt_id: "p-1", seed: 42 });
    }) as typeof fetch;
    const result = await submitT2I({
        prompt: "雨夜街口", negative: "水印", model: "sdxl.safetensors",
        size: { width: 1024, height: 576 }, route: "/api/generate/txt2img",
    });
    expect(result).toEqual({ promptId: "p-1", seed: 42 });
    expect(seen!.url).toBe("/api/generate/txt2img");
    expect(seen!.body).toMatchObject({
        positive: "雨夜街口", negative: "水印", ckpt_name: "sdxl.safetensors", width: 1024, height: 576,
    });
    expect(seen!.body).not.toHaveProperty("seed");
});

test("txt2video submits the H3 capability route with the selected duration in seconds", async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), body: JSON.parse(String(init?.body)) };
        return json({ prompt_id: "v-1" });
    }) as typeof fetch;
    await submitT2V({
        prompt: "推镜", size: { width: 768, height: 1344 }, durationSec: 6, route: "/api/h3/t2v",
    });
    expect(seen!.url).toBe("/api/h3/t2v");
    expect(seen!.body).toMatchObject({ positive: "推镜", width: 768, height: 1344, duration_sec: 6 });
    expect(seen!.body).not.toHaveProperty("length");
});

test("backend detail is surfaced when generation is rejected", async () => {
    globalThis.fetch = (async () => json({ detail: "worker 忙" }, 503)) as typeof fetch;
    await expect(submitT2I({
        prompt: "x", negative: "", size: { width: 1024, height: 1024 },
    })).rejects.toThrow("worker 忙");
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

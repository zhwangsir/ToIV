import { afterEach, expect, test } from "bun:test";
import { loadLegacyCanvas, normalizeLegacyCanvas } from "../src/toiv/adapters/legacyCanvas";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const project = {
    id: "c1",
    canvasTitle: "旧画布甲",
    updatedAt: "2026-10-30T10:00:00Z",
    nodes: [
        {
            id: "n1", type: "image", title: "开场", position: { x: 40, y: 60 }, width: 280, height: 160,
            metadata: { content: "/api/images/n1?filename=shot.png", prompt: "雨夜街口" },
        },
        {
            id: "n2", type: "video", title: "镜头二", position: { x: 380, y: 60 }, width: 300, height: 180,
            metadata: { content: "/api/images/n2.mp4", videoPreview: { content: "/api/images/n2-poster.png" } },
        },
        {
            id: "n3", type: "text", title: "台词", position: { x: 40, y: 280 }, width: 240, height: 120,
            metadata: { content: "别回头。" },
        },
    ],
    connections: [
        { id: "e1", fromNodeId: "n1", toNodeId: "n2" },
        { id: "e2", fromNodeId: "n2", toNodeId: "missing" },
    ],
};

test("normalises the Go canvas envelope into read-only nodes and edges", () => {
    const canvas = normalizeLegacyCanvas(project);
    expect(canvas).toMatchObject({ id: "c1", title: "旧画布甲" });
    expect(canvas.nodes.map(({ id, kind, title }) => ({ id, kind, title }))).toEqual([
        { id: "n1", kind: "image", title: "开场" },
        { id: "n2", kind: "video", title: "镜头二" },
        { id: "n3", kind: "text", title: "台词" },
    ]);
    expect(canvas.nodes[0]).toMatchObject({ x: 40, y: 60, width: 280, height: 160 });
    expect(canvas.nodes[0].src).toEndWith("/api/images/n1?filename=shot.png");
    expect(canvas.nodes[1].poster).toEndWith("/api/images/n2-poster.png");
    expect(canvas.nodes[2].excerpt).toBe("别回头。");
    expect(canvas.edges).toEqual([{ id: "e1", source: "n1", target: "n2" }]);
});

test("unknown node types stay visible instead of being dropped", () => {
    const canvas = normalizeLegacyCanvas({ id: "c2", title: "插件画布", nodes: [{ id: "x1", type: "market-app", position: { x: 0, y: 0 } }] });
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.nodes[0]).toMatchObject({ id: "x1", kind: "market-app", title: "market-app" });
});

test("unsafe media URLs are not rendered as sources", () => {
    const canvas = normalizeLegacyCanvas({
        id: "c3", title: "坏链接",
        nodes: [{ id: "x1", type: "image", position: { x: 0, y: 0 }, metadata: { content: "javascript:alert(1)" } }],
    });
    expect(canvas.nodes[0].src).toBeUndefined();
    expect(canvas.nodes[0].excerpt).toBeUndefined();
});

test("a rejected business envelope reports access failure instead of an empty canvas", async () => {
    globalThis.fetch = (async () => json({ code: 403, data: null, msg: "denied" })) as typeof fetch;
    await expect(loadLegacyCanvas("c1")).rejects.toThrow("无权访问");
});

test("missing canvases report a distinct error", async () => {
    globalThis.fetch = (async () => json({ detail: "not found" }, 404)) as typeof fetch;
    await expect(loadLegacyCanvas("gone")).rejects.toThrow("画布不存在");
});

test("a successful envelope is unwrapped from data.project", async () => {
    globalThis.fetch = (async () => json({ code: 0, data: { project }, msg: "ok" })) as typeof fetch;
    const canvas = await loadLegacyCanvas("c1");
    expect(canvas.title).toBe("旧画布甲");
    expect(canvas.nodes).toHaveLength(3);
});

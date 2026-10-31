import { describe, expect, test } from "bun:test";
import { createSseParser } from "../src/toiv/adapters/agent";
import { agentGraphToFlow } from "../src/toiv/adapters/agent-graph";

describe("agent SSE parser", () => {
    test("emits named and default events across chunk boundaries", () => {
        const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
        const parse = createSseParser((event, data) => seen.push({ event, data }));

        parse('event: tool\ndata: {"id":"t1","sta');
        expect(seen).toEqual([]);
        parse('tus":"start"}\n\nevent: msg\ndata: {"type":"text","content":"你好"}\n\n');

        expect(seen).toEqual([
            { event: "tool", data: { id: "t1", status: "start" } },
            { event: "msg", data: { type: "text", content: "你好" } },
        ]);
    });

    test("skips keepalive comments and joins multiline data", () => {
        const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
        const parse = createSseParser((event, data) => seen.push({ event, data }));

        parse(": ping\n\n");
        parse("event: proposal\ndata: {\"proposal_id\":\"p1\",\ndata: \"title\":\"雨夜\"}\n\n");
        parse("event: done\ndata: {}\n\n");

        expect(seen).toEqual([
            { event: "proposal", data: { proposal_id: "p1", title: "雨夜" } },
            { event: "done", data: {} },
        ]);
    });
});

describe("agent canvas graph conversion", () => {
    const graph = {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl.safetensors" } },
        "2": { class_type: "CLIPTextEncode", inputs: { text: "rainy neon street", clip: ["1", 1] } },
        "3": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], steps: 28 } },
    };

    test("maps API refs to edges and lays nodes out by depth", () => {
        const flow = agentGraphToFlow(graph);

        expect(flow.nodes.map((node) => [node.id, node.position.x])).toEqual([
            ["1", 0],
            ["2", 320],
            ["3", 640],
        ]);
        expect(flow.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
            "1->2",
            "1->3",
            "2->3",
        ]);
        expect(flow.nodes[1]?.data.label).toBe("CLIPTextEncode");
        expect(flow.nodes[1]?.data.summary).toContain("rainy neon street");
        expect(flow.nodes[2]?.data.summary).toBe("steps=28");
    });

    test("drops refs that point outside the graph and survives cycles", () => {
        const flow = agentGraphToFlow({
            a: { class_type: "Alpha", inputs: { image: ["missing", 0] } },
            b: { class_type: "Beta", inputs: { image: ["a", 0] } },
            c: { class_type: "Cycle", inputs: { image: ["c", 0], prior: ["b", 0] } },
        });

        expect(flow.nodes).toHaveLength(3);
        expect(flow.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
            "a->b",
            "b->c",
        ]);
    });

    test("keeps same-level nodes stacked with a stable y offset", () => {
        const flow = agentGraphToFlow({
            root: { class_type: "Loader", inputs: {} },
            x: { class_type: "Branch", inputs: { model: ["root", 0] } },
            y: { class_type: "Branch", inputs: { model: ["root", 0] } },
        });

        expect(flow.nodes.filter((node) => node.position.x === 320).map((node) => node.position.y)).toEqual([0, 180]);
    });
});

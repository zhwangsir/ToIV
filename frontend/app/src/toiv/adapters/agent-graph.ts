import type { AgentApiGraph } from "./agent";

export type AgentFlowNodeData = { id: string; label: string; summary: string };
export type AgentFlow = {
    nodes: { id: string; position: { x: number; y: number }; data: AgentFlowNodeData }[];
    edges: { id: string; source: string; target: string }[];
};

const COLUMN = 320;
const ROW = 180;
const SUMMARY_LIMIT = 70;
const SUMMARY_KEYS = ["text", "prompt", "ckpt_name", "filename_prefix"];

function clip(value: string): string {
    return value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT)}…` : value;
}

function summarize(inputs: Record<string, unknown> | undefined): string {
    if (!inputs) return "";
    for (const key of SUMMARY_KEYS) {
        const value = inputs[key];
        if (typeof value === "string" && value) return clip(value);
    }
    for (const [key, value] of Object.entries(inputs)) {
        if (typeof value === "number" || typeof value === "boolean") return clip(`${key}=${value}`);
    }
    const stringy = Object.values(inputs).find((value) => typeof value === "string");
    return typeof stringy === "string" ? clip(stringy) : "";
}

function refs(inputs: Record<string, unknown> | undefined): Array<{ key: string; source: string }> {
    if (!inputs) return [];
    return Object.entries(inputs).flatMap(([key, value]) =>
        Array.isArray(value) && value.length >= 2 && typeof value[0] === "string" && typeof value[1] === "number"
            ? [{ key, source: value[0] }]
            : [],
    );
}

/** ComfyUI API 图 → xyflow：按依赖深度分列，引用 [nodeId, slot] 变边。 */
export function agentGraphToFlow(graph: AgentApiGraph): AgentFlow {
    const ids = Object.keys(graph);
    const parents = new Map<string, string[]>();
    for (const id of ids) {
        parents.set(id, [...new Set(refs(graph[id]?.inputs).map((ref) => ref.source))]
            .filter((source) => graph[source] && source !== id));
    }

    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    const resolveDepth = (id: string): number => {
        const known = depth.get(id);
        if (known !== undefined) return known;
        if (visiting.has(id)) return 0;
        visiting.add(id);
        const up = parents.get(id) ?? [];
        const value = up.length ? 1 + Math.max(...up.map(resolveDepth)) : 0;
        visiting.delete(id);
        depth.set(id, value);
        return value;
    };

    const rows = new Map<number, number>();
    const nodes = ids.map((id) => {
        const level = resolveDepth(id);
        const row = rows.get(level) ?? 0;
        rows.set(level, row + 1);
        return {
            id,
            position: { x: level * COLUMN, y: row * ROW },
            data: {
                id,
                label: graph[id]?.class_type || id,
                summary: summarize(graph[id]?.inputs),
            },
        };
    });

    const edges = ids.flatMap((target) =>
        refs(graph[target]?.inputs).flatMap((ref) =>
            graph[ref.source] && ref.source !== target
                ? [{ id: `${ref.source}->${target}:${ref.key}`, source: ref.source, target }]
                : [],
        ),
    );

    return { nodes, edges };
}

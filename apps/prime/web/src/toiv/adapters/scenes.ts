export type PrimeSceneView = { id: string; label: string; src?: string; locked: boolean };
export type PrimeSceneNode = {
    id: string;
    name: string;
    env: string;
    views: PrimeSceneView[];
    variantCount: number;
    frozen: boolean;
};

const VIEW_LABELS = ["主视", "反打", "左立面", "右立面"];

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

type RawScene = {
    id: string;
    name?: string;
    environment_prompt?: string;
    master_ref?: string | null;
    reverse_ref?: string | null;
    frozen_anchor?: unknown;
    variants?: { id: string; master_ref?: string | null }[];
};

export async function loadPrimeScenes(projectId: string): Promise<PrimeSceneNode[]> {
    const res = await fetch(`/api/drama/projects/${encodeURIComponent(projectId)}/scenes`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`scenes ${res.status}`);
    const body = (await res.json()) as { scenes?: RawScene[] };
    return (body.scenes ?? []).map((scene) => {
        const variants = scene.variants ?? [];
        const refs = [scene.master_ref ?? null, scene.reverse_ref ?? null, variants[0]?.master_ref ?? null, variants[1]?.master_ref ?? null];
        return {
            id: scene.id,
            name: scene.name ?? scene.id,
            env: scene.environment_prompt ?? "—",
            views: VIEW_LABELS.map((label, index) => ({
                id: `${scene.id}:${label}`,
                label,
                src: refs[index] ?? undefined,
                locked: Boolean(scene.frozen_anchor),
            })),
            variantCount: variants.length,
            frozen: Boolean(scene.frozen_anchor),
        };
    });
}

export type PrimeSceneNodeData = { label: string; env: string; frozen: boolean; views: PrimeSceneView[] };
export type PrimeCanvasGraph = {
    nodes: { id: string; position: { x: number; y: number }; data: PrimeSceneNodeData }[];
    edges: { id: string; source: string; target: string }[];
};

/** 场景→画布节点：横排 260px 步长，顺序边串联。 */
export function primeSceneNodes(scenes: PrimeSceneNode[]): PrimeCanvasGraph {
    return {
        nodes: scenes.map((scene, index) => ({
            id: scene.id,
            position: { x: index * 280, y: 40 },
            data: { label: scene.name, env: scene.env, frozen: scene.frozen, views: scene.views },
        })),
        edges: scenes.slice(1).map((scene, index) => ({
            id: `${scenes[index].id}->${scene.id}`,
            source: scenes[index].id,
            target: scene.id,
        })),
    };
}

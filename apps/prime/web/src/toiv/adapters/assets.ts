import { loadPrimeScenes, type PrimeSceneNode } from "./scenes";

export type PrimeCharacterCard = { id: string; name: string; style: string; refImage?: string };
export type PrimeAssetsModel = { characters: PrimeCharacterCard[]; scenes: PrimeSceneNode[] };

type RawCharacter = { id?: string; name?: string; style?: string; reference_images_by_style?: Record<string, string[]>; reference_image?: string };

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function loadPrimeAssets(projectId: string): Promise<PrimeAssetsModel> {
    const [projectRes, scenes] = await Promise.all([
        fetch(`/api/studio/projects/${encodeURIComponent(projectId)}`, { headers: authHeaders() }),
        loadPrimeScenes(projectId),
    ]);
    if (!projectRes.ok) throw new Error(`assets ${projectRes.status}`);
    const detail = (await projectRes.json()) as { characters?: RawCharacter[] };
    const characters: PrimeCharacterCard[] = (detail.characters ?? []).map((character) => {
        const buckets = Object.values(character.reference_images_by_style ?? {});
        return {
            id: character.id ?? "",
            name: character.name ?? "未命名角色",
            style: character.style ?? "—",
            refImage: character.reference_image ?? buckets[0]?.[0],
        };
    });
    return { characters, scenes };
}

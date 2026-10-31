import { fetchDramaProjects } from "@/services/toiv/client";

export type ProjectCardModel = { id: string; title: string; status: string; stillSeed: number; shotCount: number; source: "studio" | "canvas" };
export type CanvasHomeModel = { cards: ProjectCardModel[]; empty: boolean };

function seedOf(id: string): number {
    let hash = 0;
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
    return hash % 4;
}

export async function loadCanvasHomeModel(canvasProjects: { id: string; title: string }[] = []): Promise<CanvasHomeModel> {
    const projects = await fetchDramaProjects();
    const cards: ProjectCardModel[] = [
        ...(projects ?? []).map((project) => ({
            id: project.id,
            title: project.title ?? project.id,
            status: project.status,
            stillSeed: seedOf(project.id),
            shotCount: (project as { shots_count?: number }).shots_count ?? 0,
            source: "studio" as const,
        })),
        ...canvasProjects.map((project) => ({
            id: project.id,
            title: project.title || project.id,
            status: "canvas",
            stillSeed: seedOf(project.id),
            shotCount: 0,
            source: "canvas" as const,
        })),
    ];
    return { cards, empty: cards.length === 0 };
}

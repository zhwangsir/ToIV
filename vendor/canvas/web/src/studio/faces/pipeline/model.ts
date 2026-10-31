import { fetchDramaProject, listToivScenes } from "@/services/toiv/client";
import type { StudioStatus } from "@/studio/ui/StatusDot";

export type ViewTileModel = { id: string; label: string; src?: string; status: StudioStatus; progress?: number; badge?: string; locked?: boolean };
export type SceneGroupModel = { id: string; name: string; slug: string; views: ViewTileModel[] };
export type TakeModel = { id: string; label: string; seed: number; src?: string };
export type ShotCardModel = { id: string; title: string; prompt: string; camera: string; durationSec: number; status: StudioStatus; takes: TakeModel[]; activeTakeId?: string };
export type PipelineModel = {
    projectId: string;
    projectName: string;
    runningCount: number;
    companionHint: string;
    stages: { key: string; label: string; done: boolean }[];
    stageIndex: number;
    scenes: SceneGroupModel[];
    shots: ShotCardModel[];
};

export const STAGE_LABELS = ["项目配置", "剧本创作", "素材准备", "分镜设计", "视频生成", "音画同步", "成品预览"];
const VIEW_LABELS = ["主视", "反打", "左立面", "右立面"];

function viewFrom(label: string, src: string | null | undefined, locked: boolean): ViewTileModel {
    return src
        ? { id: `${label}-${src}`, label, src, status: "done", locked }
        : { id: `${label}-empty`, label, status: "wait", locked };
}

export async function loadPipelineModel(projectId: string): Promise<PipelineModel> {
    const [detail, scenePage] = await Promise.all([fetchDramaProject(projectId), listToivScenes(projectId)]);
    const scenes: SceneGroupModel[] = (scenePage.scenes ?? []).map((scene) => {
        const variants = scene.variants ?? [];
        const refs = [scene.master_ref ?? null, scene.reverse_ref ?? null, variants[0]?.master_ref ?? null, variants[1]?.master_ref ?? null];
        return {
            id: scene.id,
            name: scene.name,
            slug: scene.environment_prompt ? scene.environment_prompt.slice(0, 12) : "—",
            views: VIEW_LABELS.map((label, index) => viewFrom(label, refs[index], Boolean(scene.frozen_anchor))),
        };
    });
    const shots: ShotCardModel[] = (detail.shots ?? []).map((shot, index) => {
        const candidates = shot.candidates ?? [];
        return {
            id: shot.id,
            title: `镜${String(index + 1).padStart(2, "0")}`,
            prompt: shot.prompt ?? "",
            camera: shot.camera ?? "—",
            durationSec: shot.duration_sec ?? 0,
            status: shot.status === "done" ? "done" : shot.status === "running" || shot.status === "rendering" ? "run" : "wait",
            takes: candidates.map((candidate, candidateIndex) => ({ id: candidate.id, label: `T${candidateIndex + 1}`, seed: candidate.seed ?? 0, src: candidate.url })),
            activeTakeId: candidates.find((candidate) => candidate.is_picked)?.id ?? candidates[0]?.id,
        };
    });
    const runningCount = shots.filter((shot) => shot.status === "run").length;
    const stageIndex = 2;
    return {
        projectId,
        projectName: detail.title ?? projectId,
        runningCount,
        companionHint: runningCount > 0 ? `还有 ${runningCount} 个镜头在渲染，完成后我会提醒你择一。` : "所有镜头已就绪，可以进入分镜设计。",
        stages: STAGE_LABELS.map((label, index) => ({ key: `s${index}`, label, done: index < stageIndex })),
        stageIndex,
        scenes,
        shots,
    };
}

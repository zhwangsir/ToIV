import { studioRequest } from "./studioHttp";
import { parsePrimeProjectDetail, parsePrimeShotCard, type PrimeShotCard, type PrimeStoryboardModel } from "./storyboard";

async function shotAction(shotId: string, action: string, index: number, title: string | undefined, label: string): Promise<PrimeShotCard> {
    const raw = await studioRequest<unknown>(`/api/studio/shots/${encodeURIComponent(shotId)}/${action}`, "POST");
    const card = parsePrimeShotCard(raw, index, title);
    if (card.id !== shotId) throw new Error(`${label}已提交，但返回的分镜不一致，请刷新核对`);
    return card;
}

/** Requires a dialogue and a configured character voice card; backend rejects the rest. */
export function synthesizePrimeVoice(shotId: string, index: number, title?: string): Promise<PrimeShotCard> {
    return shotAction(shotId, "voice", index, title, "配音");
}

/** Video shots only; needs both the rendered video and its voice track. */
export function lipsyncPrimeShot(shotId: string, index: number, title?: string): Promise<PrimeShotCard> {
    return shotAction(shotId, "lipsync", index, title, "对口型");
}

/** Muxes the voice track and marks the clip as 未对口型; still eligible for assembly. */
export function skipPrimeLipsync(shotId: string, index: number, title?: string): Promise<PrimeShotCard> {
    return shotAction(shotId, "lipsync/skip", index, title, "跳过对口型");
}

/** Server gates voice confirmation, stale final clips and missing clips before concatenation. */
export async function assemblePrimeProject(projectId: string): Promise<PrimeStoryboardModel> {
    const raw = await studioRequest<unknown>(`/api/studio/projects/${encodeURIComponent(projectId)}/assemble`, "POST");
    return parsePrimeProjectDetail(raw, projectId, "项目");
}

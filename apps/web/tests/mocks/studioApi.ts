/**
 * useStudioProject 单测用的 @/lib/api 可控替身(经 tests/loader.mjs 静态映射)。
 * - impl:各方法的可替换实现,用例按需覆盖;
 * - calls:调用计数,用于断言「失败时不静默 refresh」之类行为;
 * - 类型从真实 lib/api 引入(仅类型,运行时擦除),保证与生产签名一致。
 */
import type { StudioProjectDetail, StudioShot, StudioShotInput } from "../../lib/api";

export const calls = {
  getStudioProject: 0,
  saveStudioShots: 0,
  renderStudioShot: 0,
  renderStudioAll: 0,
  voiceStudioShot: 0,
  lipsyncStudioShot: 0,
  assembleStudio: 0,
};

export function makeShot(id: string): StudioShot {
  return {
    id,
    project_id: "p1",
    idx: 0,
    scene: "",
    prompt: "",
    negative: "",
    camera: "",
    dialogue: "",
    speaker: "",
    duration_sec: 4,
    characters: [],
    render_mode: "video",
    status: "draft",
    image_url: "",
    video_url: "",
    voice_url: "",
    final_clip_url: "",
    error: "",
  };
}

export function makeDetail(pid: string): StudioProjectDetail {
  return {
    id: pid,
    title: "测试项目",
    premise: "",
    style: "",
    ckpt_name: "",
    render_mode_default: "video",
    width: 768,
    height: 384,
    fps: 16,
    status: "draft",
    final_url: "",
    created_at: "",
    updated_at: "",
    characters: [],
    shots: [],
  };
}

const defaultImpl = {
  getStudioProject: async (pid: string): Promise<StudioProjectDetail> => makeDetail(pid),
  saveStudioShots: async (
    _pid: string,
    _shots: StudioShotInput[],
  ): Promise<{ shots: StudioShot[] }> => ({ shots: [] }),
  renderStudioShot: async (sid: string): Promise<StudioShot> => makeShot(sid),
  renderStudioAll: async (_pid: string): Promise<{ rendered: number; failed: number }> => ({
    rendered: 0,
    failed: 0,
  }),
  voiceStudioShot: async (sid: string): Promise<StudioShot> => makeShot(sid),
  lipsyncStudioShot: async (sid: string): Promise<StudioShot> => makeShot(sid),
  assembleStudio: async (pid: string): Promise<StudioProjectDetail> => makeDetail(pid),
};

export const impl = { ...defaultImpl };

/** 恢复默认实现并清零调用计数(每个用例前调用)。 */
export function resetImpl(): void {
  Object.assign(impl, defaultImpl);
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
}

export const getStudioProject = (pid: string): Promise<StudioProjectDetail> => {
  calls.getStudioProject++;
  return impl.getStudioProject(pid);
};
export const saveStudioShots = (
  pid: string,
  shots: StudioShotInput[],
): Promise<{ shots: StudioShot[] }> => {
  calls.saveStudioShots++;
  return impl.saveStudioShots(pid, shots);
};
export const renderStudioShot = (sid: string): Promise<StudioShot> => {
  calls.renderStudioShot++;
  return impl.renderStudioShot(sid);
};
export const renderStudioAll = (pid: string): Promise<{ rendered: number; failed: number }> => {
  calls.renderStudioAll++;
  return impl.renderStudioAll(pid);
};
export const voiceStudioShot = (sid: string): Promise<StudioShot> => {
  calls.voiceStudioShot++;
  return impl.voiceStudioShot(sid);
};
export const lipsyncStudioShot = (sid: string): Promise<StudioShot> => {
  calls.lipsyncStudioShot++;
  return impl.lipsyncStudioShot(sid);
};
export const assembleStudio = (pid: string): Promise<StudioProjectDetail> => {
  calls.assembleStudio++;
  return impl.assembleStudio(pid);
};

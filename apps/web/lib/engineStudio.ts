/**
 * 引擎工作台(2026-09-12):图片/视频视图从「应用目录壳(KindCreateView)」收口为
 * 纯引擎工作台——模式 × 引擎 × 统一参数面板。应用全部归应用市场独立使用。
 *
 * 本模块是纯数据层(无 React),供 EngineStudioView 与单测共用:
 * - STUDIO_MODES:模式 → 引擎 id 映射(客户端常量;新引擎接入 = 注册表加条目 +
 *   此处挂进对应模式,缺失引擎自动隐藏)
 * - resolveStudioModes:按引擎目录(GET /api/models/engines)解析出可用模式列表;
 *   目录缺失/跨 kind/选择器隐藏(hidden)的引擎自动剔除,整模式无引擎时模式也隐藏。
 *   R18(nsfw)引擎由后端按 R18 上下文混入/剔除目录,前端不再判断。
 * - defaultStudioEngine:模式内默认引擎 = 映射表第一个在线项(无在线回退第一项,
 *   离线引擎仍可被选中查看参数,提交由视图层门控)。
 * - extractStudioMedia:把 ParamField 写在 values 里的媒体句柄(images/audio/video
 *   类型参数)抽成 submitEngineGeneration 契约的 refImage/refImages/refAudio/refVideo。
 */
import type { EngineInfo, RefImageHandle } from "./engines";

export type StudioKind = "image" | "video";

export interface StudioModeDef {
  id: string;
  label: string;
  /** 引擎 id 优先级序(第一个在线项 = 默认;h3 优先原则由排序承载)。 */
  engineIds: string[];
}

export const STUDIO_MODES: Record<StudioKind, StudioModeDef[]> = {
  image: [
    { id: "t2i", label: "文生图", engineIds: ["txt2img", "nsfw-txt2img"] },
    { id: "i2i", label: "图生图", engineIds: ["img2img", "nsfw-img2img"] },
    { id: "edit", label: "图片编辑", engineIds: ["qwen-image-edit"] },
  ],
  video: [
    { id: "t2v", label: "文生视频", engineIds: ["h3-t2v", "longcat-t2v", "ltx-nsfw-t2v"] },
    { id: "i2v", label: "图生视频", engineIds: ["h3-i2v", "longcat-i2v", "ltx-nsfw-i2v", "wan-nsfw-i2v"] },
    { id: "fl2v", label: "首尾帧", engineIds: ["h3-fl2v"] },
    { id: "r2v", label: "参考生视频", engineIds: ["h3-r2v"] },
  ],
};

export interface StudioMode extends StudioModeDef {
  /** 目录解析后的引擎(保持 engineIds 顺序;离线引擎保留,卡片置灰)。 */
  engines: EngineInfo[];
}

/** 目录 → 模式列表:缺失/跨 kind/hidden 引擎自动隐藏;整模式无引擎时模式隐藏。 */
export function resolveStudioModes(engines: EngineInfo[], kind: StudioKind): StudioMode[] {
  const byId = new Map(engines.filter((e) => e.kind === kind && !e.hidden).map((e) => [e.id, e]));
  const out: StudioMode[] = [];
  for (const def of STUDIO_MODES[kind]) {
    const list = def.engineIds
      .map((id) => byId.get(id))
      .filter((e): e is EngineInfo => e !== undefined);
    if (list.length > 0) out.push({ ...def, engines: list });
  }
  return out;
}

/** 模式内默认引擎:映射表第一个在线项;全部离线回退第一项(可选中看参数,提交禁用)。 */
export function defaultStudioEngine(mode: StudioMode): EngineInfo | null {
  return mode.engines.find((e) => e.available) ?? mode.engines[0] ?? null;
}

export interface StudioMediaRefs {
  /** 全部 images 类型参数的句柄(按参数声明序拼接;单图引擎取 [0] 即 refImage)。 */
  refImages: RefImageHandle[];
  refAudio: RefImageHandle | null;
  refVideo: RefImageHandle | null;
}

interface MediaHandleLike {
  filename?: unknown;
  worker?: unknown;
}

function asHandles(value: unknown): RefImageHandle[] {
  const items = Array.isArray(value) ? value : value != null ? [value] : [];
  const out: RefImageHandle[] = [];
  for (const it of items) {
    if (typeof it === "string" && it.trim()) {
      out.push({ filename: it.trim(), worker: "" });
      continue;
    }
    if (it && typeof it === "object") {
      const h = it as MediaHandleLike;
      if (typeof h.filename === "string" && h.filename.trim()) {
        out.push({ filename: h.filename.trim(), worker: typeof h.worker === "string" ? h.worker : "" });
      }
    }
  }
  return out;
}

/**
 * values(ParamField 媒体参数落点)→ submitEngineGeneration 媒体契约。
 * 多 images 参数(如首尾帧拆槽)按声明序拼接;h3-r2v 的图/视频/音频可并存。
 */
export function extractStudioMedia(
  engine: EngineInfo,
  values: Record<string, unknown>,
): StudioMediaRefs {
  const refs: StudioMediaRefs = { refImages: [], refAudio: null, refVideo: null };
  for (const p of engine.params) {
    const handles = asHandles(values[p.key]);
    if (handles.length === 0) continue;
    if (p.type === "images") refs.refImages.push(...handles);
    else if (p.type === "audio" && !refs.refAudio) refs.refAudio = handles[0];
    else if (p.type === "video" && !refs.refVideo) refs.refVideo = handles[0];
  }
  return refs;
}

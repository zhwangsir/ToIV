"use client";

import {
  apiFetch,
  authHeaders,
  generateAudio,
  generateImg2img,
  generateLongcatContinue,
  generateLongcatI2V,
  generateLongcatT2V,
  generateLtxI2V,
  generateLtxLipsync,
  generateLtxT2V,
  generateTxt2img,
  type AudioGenParams,
  type LongcatT2VParams,
} from "./api";
import type { GenerateResponse, Img2ImgGenParams, Txt2ImgParams } from "./types";

// ── 统一生成工作台:引擎注册表(GET /api/models/engines)──
// 后端 services/engine_registry 是唯一事实源:接入新引擎 = 注册表加条目,
// 前端按 params schema 动态渲染参数区,不为引擎开新视图。

export type EngineKind = "image" | "video" | "audio";

export type EngineParamType = "text" | "textarea" | "number" | "select" | "switch" | "images" | "audio" | "video" | "loras";

export interface EngineParamOption {
  value: string;
  label: string;
  nsfw?: boolean;
}

/** LoRA 叠加参数值(loras 类型):多选 + 单项强度。 */
export interface LoraValue {
  name: string;
  strength: number;
}

export interface EngineParam {
  key: string;
  label: string;
  type: EngineParamType;
  options?: EngineParamOption[];
  min?: number;
  max?: number;
  step?: number;
  default: unknown;
  hint?: string;
}

export interface EngineSource {
  /** 模型官方名 */
  name: string;
  /** 出处链接(官方仓库/模型页) */
  url: string;
  /** 出品方 */
  author: string;
  /** 一句话定位(可选) */
  note?: string;
}

export interface EngineInfo {
  id: string;
  label: string;
  kind: EngineKind;
  available: boolean;
  unavailable_reason?: string;
  nsfw: boolean;
  description?: string;
  params: EngineParam[];
  /** 模型介绍与出处(M9 起由后端注册表透传) */
  source?: EngineSource;
}

/** 拉取引擎注册表(NSFW 引擎由后端按 R18 上下文过滤,前端不再判断)。 */
export async function fetchEngines(): Promise<EngineInfo[]> {
  const res = await apiFetch(`/api/models/engines`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载引擎列表失败 (${res.status})`);
  const data = (await res.json()) as { engines?: EngineInfo[] };
  return data.engines ?? [];
}

/** 强制重新探测引擎可用性(清后端缓存后重查;「重新检测」按钮用)。 */
export async function refreshEngines(): Promise<EngineInfo[]> {
  const res = await apiFetch(`/api/models/engines/refresh`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`重新检测引擎失败 (${res.status})`);
  const data = (await res.json()) as { engines?: EngineInfo[] };
  return data.engines ?? [];
}

/** 引擎参数默认值表(动态参数区初始值;images/audio/video 由上传组件承载,不进 values)。 */
export function engineDefaults(engine: EngineInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of engine.params) {
    if (p.type !== "images" && p.type !== "audio" && p.type !== "video") out[p.key] = p.default;
  }
  return out;
}

/** 引擎是否需要上传参考图(params 含 images 类型)。 */
export function engineNeedsImage(engine: EngineInfo): EngineParam | null {
  return engine.params.find((p) => p.type === "images") ?? null;
}

/** 引擎参考图数量上限(images 类型参数的 max;缺省 1 = 单图)。 */
export function engineMaxImages(engine: EngineInfo): number {
  const p = engineNeedsImage(engine);
  return p?.max ?? 1;
}

/** 引擎是否需要上传驱动音频(params 含 audio 类型,如对口型)。 */
export function engineNeedsAudio(engine: EngineInfo): EngineParam | null {
  return engine.params.find((p) => p.type === "audio") ?? null;
}

/** 引擎是否需要上传驱动视频(params 含 video 类型,如 Wan2.2-Animate 动作迁移)。 */
export function engineNeedsVideo(engine: EngineInfo): EngineParam | null {
  return engine.params.find((p) => p.type === "video") ?? null;
}

/** 引擎是否支持负向提示词(params 含 negative)。 */
export function engineSupportsNegative(engine: EngineInfo): boolean {
  return engine.params.some((p) => p.key === "negative");
}

/** 已上传参考图句柄(经 /api/upload 得到)。 */
export interface RefImageHandle {
  filename: string;
  worker: string;
}

export interface EngineSubmitInput {
  engine: EngineInfo;
  positive: string;
  /** 动态参数值(按 params schema 的 key)。 */
  values: Record<string, unknown>;
  /** 参考图(images 类型参数必填;max=1 单图槽)。 */
  refImage?: RefImageHandle | null;
  /** 多参考图(images 类型 max>1,如 VACE 1-4 张;全部互钉同 worker)。 */
  refImages?: RefImageHandle[];
  /** 驱动音频(audio 类型参数必填,须与参考图同 worker)。 */
  refAudio?: RefImageHandle | null;
  /** 驱动视频(video 类型参数必填,须与参考图同 worker)。 */
  refVideo?: RefImageHandle | null;
}

function _str(values: Record<string, unknown>, key: string, fallback = ""): string {
  const v = values[key];
  return v == null ? fallback : String(v);
}

function _num(values: Record<string, unknown>, key: string, fallback: number): number {
  const v = values[key];
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function _bool(values: Record<string, unknown>, key: string): boolean {
  return Boolean(values[key]);
}

/** LoRA 叠加参数(loras 类型):多选数组 → [{name, strength}];非数组/空 → [](后端默认不加)。 */
function _loras(values: Record<string, unknown>): LoraValue[] {
  const v = values["loras"];
  if (!Array.isArray(v)) return [];
  const out: LoraValue[] = [];
  for (const it of v) {
    if (!it || typeof (it as LoraValue).name !== "string") continue;
    const strength = (it as LoraValue).strength;
    out.push({
      name: (it as LoraValue).name,
      strength: typeof strength === "number" && Number.isFinite(strength) ? strength : 0.6,
    });
  }
  return out;
}

function _seed(values: Record<string, unknown>): number | null {
  const raw = _str(values, "seed").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error("随机种子须为非负整数(留空则随机)");
  return n;
}

/**
 * 按引擎 id 路由到对应既有生成 API(图像走 generate 的 txt2img/img2img,
 * 视频走 ltx25 t2v/i2v 或 H3 专用实例 /api/h3/*;R18 引擎走 NSFW 专区 /api/generate/ltx-*)。
 * 返回的 GenerateResponse 交给 useGeneration/trackJob 做 SSE 进度跟踪。
 */
export async function submitEngineGeneration(input: EngineSubmitInput): Promise<GenerateResponse> {
  const { engine, positive, values, refImage, refImages, refAudio, refVideo } = input;
  const id = engine.id;
  const imageParam = engineNeedsImage(engine);
  const multiImage = imageParam !== null && (imageParam.max ?? 1) > 1;
  if (imageParam && !multiImage && !refImage) throw new Error("请先上传参考图");
  if (multiImage && !(refImages && refImages.length > 0)) throw new Error("请先上传参考图(至少 1 张)");
  if (engineNeedsAudio(engine) !== null && !refAudio) throw new Error("请先上传驱动音频");
  if (engineNeedsVideo(engine) !== null && !refVideo) throw new Error("请先上传驱动视频");
  const seed = _seed(values);
  const negative = _str(values, "negative");

  switch (id) {
    case "txt2img":
    case "nsfw-txt2img":
      return generateTxt2img({
        positive,
        negative,
        // 空 → 后端用全局默认底模(注册表 ckpt 参数默认即空)
        ckpt_name: _str(values, "ckpt_name"),
        width: _num(values, "width", 1024),
        height: _num(values, "height", 1024),
        steps: _num(values, "steps", 20),
        cfg: _num(values, "cfg", 7),
        sampler: _str(values, "sampler", "euler"),
        scheduler: _str(values, "scheduler", "normal"),
        seed,
        batch_size: _num(values, "batch_size", 1),
        ...(_str(values, "style_preset") ? { style_preset: _str(values, "style_preset") } : {}),
      } satisfies Txt2ImgParams);

    case "img2img":
    case "nsfw-img2img":
      return generateImg2img({
        positive,
        negative,
        ckpt_name: _str(values, "ckpt_name"),
        image: refImage!.filename,
        worker: refImage!.worker,
        denoise: _num(values, "denoise", 0.6),
        steps: _num(values, "steps", 20),
        cfg: _num(values, "cfg", 7),
        sampler: _str(values, "sampler", "euler"),
        scheduler: _str(values, "scheduler", "normal"),
        seed,
        ...(_str(values, "style_preset") ? { style_preset: _str(values, "style_preset") } : {}),
      } satisfies Img2ImgGenParams);

    case "ltx25-t2v":
      return _postLtx25("/api/ltx25/t2v", _ltx25Payload(values, positive, negative, seed));

    case "ltx25-i2v":
      // 参考图经 /api/upload 落在 pool worker,后端会转运到 LTX-2.5 专用实例(:8198)
      return _postLtx25("/api/ltx25/i2v", {
        ..._ltx25Payload(values, positive, negative, seed),
        image: refImage!.filename,
        worker: refImage!.worker,
        strength: _num(values, "strength", 0.7),
      });

    case "ltx-nsfw-t2v":
      return generateLtxT2V(_ltxNsfwPayload(values, positive, negative, seed));

    case "ltx-nsfw-i2v":
      return generateLtxI2V({
        ..._ltxNsfwPayload(values, positive, negative, seed),
        image: refImage!.filename,
        worker: refImage!.worker,
      });

    case "ltx-nsfw-lipsync":
      // 参考图 + 驱动音频须同 worker(前端上传时已互钉);ID LoRA 留空即不用
      return generateLtxLipsync({
        ..._ltxNsfwPayload(values, positive, negative, seed),
        image: refImage!.filename,
        audio: refAudio!.filename,
        worker: refImage!.worker,
        id_lora: _str(values, "id_lora").trim() || undefined,
        id_lora_strength: _num(values, "id_lora_strength", 0.8),
      });

    case "h3-t2v":
      return _postH3("/api/h3/t2v", _h3Payload(values, positive, negative, seed));

    case "h3-nsfw-t2v":
      // R18 版与 SFW 同一提交链路:专区内自带 X-NSFW 头,后端据此打标/放行 R18 LoRA
      return _postH3("/api/h3/t2v", _h3NsfwPayload(values, positive, negative, seed));

    case "longcat-t2v":
      return generateLongcatT2V(_longcatPayload(values, positive, negative, seed));

    case "longcat-i2v":
      // 参考图经 /api/upload 落在 pool worker,后端会转运到 LongCat 专用实例
      return generateLongcatI2V({
        ..._longcatPayload(values, positive, negative, seed),
        image: refImage!.filename,
        worker: refImage!.worker,
      });

    case "longcat-continue": {
      // 源视频:/api/images? 产物 URL(注册表 text 参数),后端抽末帧续写
      const video = _str(values, "video").trim();
      if (!video) throw new Error("请填写源视频产物 URL(/api/images?...)");
      return generateLongcatContinue({
        ..._longcatPayload(values, positive, negative, seed),
        video,
      });
    }

    case "h3-i2v":
      // 参考图经 /api/upload 落在 pool worker,后端会转运到 H3 专用实例
      return _postH3("/api/h3/i2v", {
        ..._h3Payload(values, positive, negative, seed),
        image: refImage!.filename,
        worker: refImage!.worker,
      });

    case "h3-nsfw-i2v":
      return _postH3("/api/h3/i2v", {
        ..._h3NsfwPayload(values, positive, negative, seed),
        image: refImage!.filename,
        worker: refImage!.worker,
      });

    case "wan-animate":
      // 参考图 + 驱动视频互钉同 worker(上传时已钉);后端转运到 :8197 实例
      return _postWan("/api/wan/animate", {
        ..._wanPayload(values, positive, negative, seed, 121),
        image: refImage!.filename,
        video: refVideo!.filename,
        worker: refImage!.worker,
        relight_lora: _bool(values, "relight_lora"),
      });

    case "wan-vace":
      // 多参考图(1-4 张,全部互钉同 worker,worker 取第一张落点)
      return _postWan("/api/wan/vace", {
        ..._wanPayload(values, positive, negative, seed, 81),
        images: refImages!.map((r) => r.filename),
        worker: refImages![0].worker,
      });

    case "ace-music":
      // ACE-Step 文生音乐:positive 即风格标签(tags);歌词/时长等走动态参数
      return generateAudio({
        tags: positive,
        lyrics: _str(values, "lyrics"),
        seconds: _num(values, "seconds", 30),
        steps: _num(values, "steps", 50),
        cfg: _num(values, "cfg", 5),
        seed,
      } satisfies AudioGenParams);

    default:
      throw new Error(`引擎「${engine.label}」尚未接入提交链路`);
  }
}

function _ltx25Payload(values: Record<string, unknown>, positive: string, negative: string, seed: number | null) {
  return {
    positive,
    negative,
    width: _num(values, "width", 960),
    height: _num(values, "height", 544),
    length: _num(values, "length", 121),
    fps: _num(values, "fps", 24),
    steps: _num(values, "steps", 8),
    seed,
  };
}

/** R18 分辨率预设换算:select 值 "WxH" → {width, height};非法/缺失 → fallback 预设。 */
function _resolution(values: Record<string, unknown>, fallback: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(_str(values, "resolution", fallback));
  const [w, h] = (m ? [m[1], m[2]] : fallback.split("x")).map(Number);
  return { width: w, height: h };
}

/** R18 时长预设换算:duration 秒 × fps → 吸附 8k+1 网格并钳到 [9, 241](LTX 帧数约束)。 */
function _ltxNsfwLength(values: Record<string, unknown>): number {
  const secs = parseFloat(_str(values, "duration", "6")) || 6;
  const fps = _num(values, "fps", 16);
  const raw = Math.max(9, Math.round(secs * fps));
  const snapped = ((raw - 1) >> 3) * 8 + 1; // 8k+1
  return Math.min(241, snapped);
}

function _ltxNsfwPayload(values: Record<string, unknown>, positive: string, negative: string, seed: number | null) {
  const { width, height } = _resolution(values, "1280x720");
  return {
    positive,
    negative,
    width,
    height,
    length: _ltxNsfwLength(values),
    fps: _num(values, "fps", 16),
    steps: _num(values, "steps", 20),
    cfg: _num(values, "cfg", 1),
    seed,
    use_upscale: _bool(values, "use_upscale"),
    use_rife: _bool(values, "use_rife"),
  };
}

/** LongCat 提交负载:无 cfg(蒸馏链路固定 1.0,builder 内锁定)。 */
function _longcatPayload(values: Record<string, unknown>, positive: string, negative: string, seed: number | null): LongcatT2VParams {
  return {
    positive,
    negative,
    width: _num(values, "width", 832),
    height: _num(values, "height", 480),
    num_frames: _num(values, "num_frames", 121),
    steps: _num(values, "steps", 10),
    fps: _num(values, "fps", 16),
    seed,
  };
}

/** Wan2.2-Animate / Wan2.1-VACE 提交负载:与 routes/wan_studio.py 请求模型同一套范围。 */
function _wanPayload(
  values: Record<string, unknown>,
  positive: string,
  negative: string,
  seed: number | null,
  defaultFrames: number,
) {
  return {
    positive,
    negative,
    width: _num(values, "width", 832),
    height: _num(values, "height", 480),
    num_frames: _num(values, "num_frames", defaultFrames),
    steps: _num(values, "steps", 6),
    fps: _num(values, "fps", 16),
    seed,
  };
}

/** Wan 工作室提交(POST /api/wan/*):与 _postH3 同模式,422 展开首条校验信息。 */
async function _postWan(path: string, body: object): Promise<GenerateResponse> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const msg = Array.isArray(detail?.detail)
      ? ((detail.detail[0] as { msg?: string } | undefined)?.msg ?? "Wan 视频请求参数校验失败")
      : typeof detail?.detail === "string"
        ? detail.detail
        : `Wan 视频生成请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

/** H3 提交负载:无 fps/cfg(H3 固定 24fps + res_multistep/simple,模板内锁定)。 */
function _h3Payload(values: Record<string, unknown>, positive: string, negative: string, seed: number | null) {
  return {
    positive,
    negative,
    width: _num(values, "width", 1344),
    height: _num(values, "height", 768),
    length: _num(values, "length", 124),
    steps: _num(values, "steps", 20),
    seed,
    loras: _loras(values),
  };
}

// R18 H3 时长预设 → 17k+5 帧网格(固定 24fps;与注册表 _H3_NSFW_DURATIONS 同源)
const _H3_NSFW_DURATION_FRAMES: Record<string, number> = { "6": 141, "10": 243, "15": 362 };

/** R18 H3 提交负载:resolution/duration 预设换算成后端硬校验的 32 对齐宽高 + 17k+5 帧数。 */
function _h3NsfwPayload(values: Record<string, unknown>, positive: string, negative: string, seed: number | null) {
  const { width, height } = _resolution(values, "1280x736");
  return {
    positive,
    negative,
    width,
    height,
    length: _H3_NSFW_DURATION_FRAMES[_str(values, "duration", "6")] ?? 141,
    steps: _num(values, "steps", 20),
    seed,
    loras: _loras(values),
  };
}

/** H3 工作室提交(POST /api/h3/*):与 _postLtx25 同模式,422 展开首条校验信息。 */
async function _postH3(path: string, body: object): Promise<GenerateResponse> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const msg = Array.isArray(detail?.detail)
      ? ((detail.detail[0] as { msg?: string } | undefined)?.msg ?? "H3 视频请求参数校验失败")
      : typeof detail?.detail === "string"
        ? detail.detail
        : `H3 视频生成请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

/** LTX-2.5 工作室提交(POST /api/ltx25/*):走 apiFetch 统一超时/401,422 展开首条校验信息。 */
async function _postLtx25(path: string, body: object): Promise<GenerateResponse> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const msg = Array.isArray(detail?.detail)
      ? ((detail.detail[0] as { msg?: string } | undefined)?.msg ?? "LTX 视频请求参数校验失败")
      : typeof detail?.detail === "string"
        ? detail.detail
        : `LTX 视频生成请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

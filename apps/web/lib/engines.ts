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

export type EngineParamType = "text" | "textarea" | "number" | "select" | "switch" | "images";

export interface EngineParamOption {
  value: string;
  label: string;
  nsfw?: boolean;
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

export interface EngineInfo {
  id: string;
  label: string;
  kind: EngineKind;
  available: boolean;
  unavailable_reason?: string;
  nsfw: boolean;
  description?: string;
  params: EngineParam[];
}

/** 拉取引擎注册表(NSFW 引擎由后端按 R18 上下文过滤,前端不再判断)。 */
export async function fetchEngines(): Promise<EngineInfo[]> {
  const res = await apiFetch(`/api/models/engines`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载引擎列表失败 (${res.status})`);
  const data = (await res.json()) as { engines?: EngineInfo[] };
  return data.engines ?? [];
}

/** 引擎参数默认值表(动态参数区初始值)。 */
export function engineDefaults(engine: EngineInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of engine.params) {
    if (p.type !== "images") out[p.key] = p.default;
  }
  return out;
}

/** 引擎是否需要上传参考图(params 含 images 类型)。 */
export function engineNeedsImage(engine: EngineInfo): EngineParam | null {
  return engine.params.find((p) => p.type === "images") ?? null;
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
  /** 参考图(images 类型参数必填)。 */
  refImage?: RefImageHandle | null;
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

function _seed(values: Record<string, unknown>): number | null {
  const raw = _str(values, "seed").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error("随机种子须为非负整数(留空则随机)");
  return n;
}

/**
 * 按引擎 id 路由到对应既有生成 API(图像走 generate 的 txt2img/img2img,
 * 视频走 ltx2 t2v/i2v 或 H3 专用实例 /api/h3/*;R18 引擎走 NSFW 专区 /api/generate/ltx-*)。
 * 返回的 GenerateResponse 交给 useGeneration/trackJob 做 SSE 进度跟踪。
 */
export async function submitEngineGeneration(input: EngineSubmitInput): Promise<GenerateResponse> {
  const { engine, positive, values, refImage } = input;
  const id = engine.id;
  const needsImage = engineNeedsImage(engine) !== null;
  if (needsImage && !refImage) throw new Error("请先上传参考图");
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

    case "ltx2-t2v":
      return _postLtx2("/api/ltx2/t2v", _ltx2Payload(values, positive, negative, seed));

    case "ltx2-i2v":
      return _postLtx2("/api/ltx2/i2v", {
        ..._ltx2Payload(values, positive, negative, seed),
        image: refImage!.filename,
        worker: refImage!.worker,
      });

    case "ltx-nsfw-t2v":
      return generateLtxT2V(_ltxNsfwPayload(values, positive, negative, seed));

    case "ltx-nsfw-i2v":
      return generateLtxI2V({
        ..._ltxNsfwPayload(values, positive, negative, seed),
        image: refImage!.filename,
        worker: refImage!.worker,
      });

    case "h3-t2v":
      return _postH3("/api/h3/t2v", _h3Payload(values, positive, negative, seed));

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

function _ltx2Payload(values: Record<string, unknown>, positive: string, negative: string, seed: number | null) {  return {
    positive,
    negative,
    unet_name: _str(values, "unet_name", "ltx-2.3-distilled.safetensors"),
    width: _num(values, "width", 768),
    height: _num(values, "height", 384),
    length: _num(values, "length", 97),
    fps: _num(values, "fps", 16),
    steps: _num(values, "steps", 20),
    cfg: _num(values, "cfg", 1),
    seed,
    use_upscale: _bool(values, "use_upscale"),
    use_rife: _bool(values, "use_rife"),
  };
}

function _ltxNsfwPayload(values: Record<string, unknown>, positive: string, negative: string, seed: number | null) {
  return {
    positive,
    negative,
    width: _num(values, "width", 768),
    height: _num(values, "height", 384),
    length: _num(values, "length", 97),
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
  };
}

/** H3 工作室提交(POST /api/h3/*):与 _postLtx2 同模式,422 展开首条校验信息。 */
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

/** LTX2 工作室提交(POST /api/ltx2/*):走 apiFetch 统一超时/401,422 展开首条校验信息。 */
async function _postLtx2(path: string, body: object): Promise<GenerateResponse> {
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

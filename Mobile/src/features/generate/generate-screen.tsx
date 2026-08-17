import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';

import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/Icon';
import { Screen } from '@/components/ui/screen';
import { registerJobSseCreds } from '@/features/jobs/job-sse-registry';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  fetchEngines,
  optimizePrompt,
  reversePrompt,
  submitAceMusic,
  submitAvatarTalk,
  submitH3I2V,
  submitH3T2V,
  submitImg2Img,
  submitLongCatContinue,
  submitLongCatI2V,
  submitLongCatT2V,
  submitLtx25I2V,
  submitLtx25T2V,
  submitLtxNsfwI2V,
  submitLtxNsfwLipsync,
  submitLtxNsfwT2V,
  submitTxt2Img,
  submitWanAnimate,
  submitWanVace,
} from '@/lib/api';
import { useGenerationDraft } from '@/stores/generation-draft';
import type {
  AceMusicRequest,
  AvatarTalkRequest,
  EngineInfo,
  H3I2VRequest,
  H3T2VRequest,
  Img2ImgRequest,
  LongCatContinueRequest,
  LongCatI2VRequest,
  LongCatT2VRequest,
  LoraValue,
  Ltx25I2VRequest,
  Ltx25T2VRequest,
  LtxNsfwI2VRequest,
  LtxNsfwLipsyncRequest,
  LtxNsfwT2VRequest,
  Txt2ImgRequest,
  UploadedRefAudio,
  UploadedRefImage,
  UploadedRefVideo,
  WanAnimateRequest,
  WanVaceRequest,
} from '@/types/api';

import { ParamSheet, SIZE_PRESETS, defaultParamValues } from './param-sheet';
import type { ParamValues } from './param-sheet';
import { PromptBar } from './prompt-bar';

/**
 * 创作屏（M4）：Prompt-First 首屏
 * - PromptBar 贴底悬浮（拇指区）；参数抽屉由 EngineInfo.params 动态驱动（M7.4）
 * - 引擎 chips：图像类引擎（txt2img 直提；img2img 参考图选中即传后提交，M8）
 * - 提交即反馈 ≤200ms（乐观 pending）→ 成功横幅（可跳作业）/ 失败人话
 */

/** 移动端可提交：图像类引擎；参考图（images）M8 起支持，驱动音频（audio）后续里程碑接入 */
export function isSubmittableImageEngine(engine: EngineInfo): boolean {
  return engine.kind === 'image' && !engine.params.some((p) => p.type === 'audio');
}

/** 引擎是否要求参考图（params 含 images 型 → 走 img2img 提交链路） */
export function engineNeedsRefImage(engine: EngineInfo): boolean {
  return engine.params.some((p) => p.type === 'images');
}

/** 数值类参数：UI 展示即提交（所见即所得，不依赖后端默认值漂移） */
const NUMBER_KEYS = ['width', 'height', 'steps', 'cfg', 'batch_size'] as const;
/** 字符串类参数：非空才进请求体（'' 语义 = 平台默认/不使用，省略交给后端） */
const STRING_KEYS = ['negative', 'ckpt_name', 'sampler', 'scheduler', 'style_preset'] as const;
/** img2img 数值类参数（契约无 width/height/batch_size，输出尺寸随参考图） */
const I2I_NUMBER_KEYS = ['denoise', 'steps', 'cfg'] as const;

/** 由 schema 值序列化 seed（text 型）：仅非负整数时返回，其余（留空/非法）undefined = 随机 */
function serializeSeed(raw: unknown): number | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const n = Number(s);
  return s && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * 由引擎 schema + 表单值构建 txt2img 请求体：
 * - number：''/缺省回落 param.default；select/文本空串省略（后端走默认）
 * - seed（text 型）：仅非负整数时提交，其余（留空/非法）省略 = 随机
 */
export function buildTxt2ImgRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): Txt2ImgRequest {
  const req: Txt2ImgRequest = { positive };
  for (const param of engine.params) {
    const raw = values[param.key];
    if ((NUMBER_KEYS as readonly string[]).includes(param.key)) {
      const key = param.key as (typeof NUMBER_KEYS)[number];
      const n = raw === '' || raw === null || raw === undefined ? Number(param.default) : Number(raw);
      if (Number.isFinite(n)) {
        req[key] = n;
      }
    } else if ((STRING_KEYS as readonly string[]).includes(param.key)) {
      const key = param.key as (typeof STRING_KEYS)[number];
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (s) {
        req[key] = s;
      }
    } else if (param.key === 'seed') {
      const seed = serializeSeed(raw);
      if (seed !== undefined) req.seed = seed;
    }
  }
  return req;
}

/** 从表单值中取全部已上传参考图句柄：数组过滤脏数据；单图对象归一为数组；缺失/脏值空数组 */
export function readUploadedRefs(engine: EngineInfo, values: ParamValues): UploadedRefImage[] {
  const key = engine.params.find((p) => p.type === 'images')?.key;
  const raw = key ? values[key] : null;
  const isRef = (v: unknown): v is UploadedRefImage =>
    v !== null &&
    typeof v === 'object' &&
    typeof (v as UploadedRefImage).filename === 'string' &&
    typeof (v as UploadedRefImage).worker === 'string';
  if (Array.isArray(raw)) return raw.filter(isRef);
  return isRef(raw) ? [raw] : [];
}

/** 从表单值中取已上传驱动视频句柄（形状校验防脏数据，对齐 readUploadedRefs 单值语义） */
function readUploadedVideo(engine: EngineInfo, values: ParamValues): UploadedRefVideo | null {
  const key = engine.params.find((p) => p.type === 'video')?.key;
  const raw = key ? values[key] : null;
  if (
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as UploadedRefVideo).filename === 'string' &&
    typeof (raw as UploadedRefVideo).worker === 'string'
  ) {
    return raw as UploadedRefVideo;
  }
  return null;
}

/** 引擎是否要求驱动视频（params 含 video 型，M9 wan-animate 动作迁移链路） */
export function engineNeedsVideo(engine: EngineInfo): boolean {
  return engine.params.some((p) => p.type === 'video');
}

/** 从表单值中取已上传驱动音频句柄（形状校验防脏数据，对齐 readUploadedVideo 语义） */
function readUploadedAudio(engine: EngineInfo, values: ParamValues): UploadedRefAudio | null {
  const key = engine.params.find((p) => p.type === 'audio')?.key;
  const raw = key ? values[key] : null;
  if (
    raw !== null &&
    typeof raw === 'object' &&
    typeof (raw as UploadedRefAudio).filename === 'string' &&
    typeof (raw as UploadedRefAudio).worker === 'string'
  ) {
    return raw as UploadedRefAudio;
  }
  return null;
}

/** 引擎是否要求驱动音频（params 含 audio 型，M11 ltx-nsfw-lipsync；M14 avatar-talk 注册表 audio 为 text 型，移动端归一化按 audio 处理） */
export function engineNeedsAudio(engine: EngineInfo): boolean {
  if (engine.id === 'avatar-talk') return true;
  return engine.params.some((p) => p.type === 'audio');
}

/** 引擎参考图上限：取 images 参数的 max，缺省 1（wan-vace max=4 多图互钉） */
export function engineMaxRefImages(engine: EngineInfo): number {
  const param = engine.params.find((p) => p.type === 'images');
  return param && typeof param.max === 'number' && param.max > 0 ? param.max : 1;
}

/**
 * 引擎 schema 归一化（M14）：avatar-talk 注册表把驱动音频声明为 text 型
 * （engine_registry._avatar_talk_params；Web 走独立 AvatarGenPanel 面板不吃动态 schema）。
 * 移动端复用 RefAudioField 上传链路与 syncAudioWithRefImage 互钉，故把该参数归一为 audio 型；
 * 仅作用于 avatar-talk 的 audio 键且原类型为 text 时（注册表后续若改 audio 型则不动，前向兼容）
 */
export function normalizeEngineSchema(engine: EngineInfo): EngineInfo {
  if (engine.id !== 'avatar-talk') return engine;
  return {
    ...engine,
    params: engine.params.map((p) =>
      p.key === 'audio' && p.type === 'text' ? { ...p, type: 'audio' as const, default: null } : p,
    ),
  };
}

/**
 * 由引擎 schema + 表单值构建 img2img 请求体（M8）：
 * - image/worker 取自参考图句柄（选中即传的 /api/upload 响应）；未上传返回 null（调用方提示）
 * - number（denoise/steps/cfg）与字符串键规则同 txt2img；seed 仅非负整数提交
 */
export function buildImg2ImgRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): Img2ImgRequest | null {
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref) return null;
  const req: Img2ImgRequest = { positive, image: ref.filename, worker: ref.worker };
  for (const param of engine.params) {
    const raw = values[param.key];
    if ((I2I_NUMBER_KEYS as readonly string[]).includes(param.key)) {
      const key = param.key as (typeof I2I_NUMBER_KEYS)[number];
      const n = raw === '' || raw === null || raw === undefined ? Number(param.default) : Number(raw);
      if (Number.isFinite(n)) {
        req[key] = n;
      }
    } else if ((STRING_KEYS as readonly string[]).includes(param.key)) {
      const key = param.key as (typeof STRING_KEYS)[number];
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (s) {
        req[key] = s;
      }
    } else if (param.key === 'seed') {
      const seed = serializeSeed(raw);
      if (seed !== undefined) req.seed = seed;
    }
  }
  return req;
}

// ── SFW 视频引擎请求构建（M9，契约与 Web lib/engines.ts submitEngineGeneration 对齐）──

/** M9 起移动端可提交的视频引擎白名单；M10 接入 H3/LongCat；M11 接入 5 个 R18 引擎；M14 接入 avatar-talk */
const SUPPORTED_VIDEO_ENGINE_IDS: ReadonlySet<string> = new Set([
  'ltx25-t2v',
  'ltx25-i2v',
  'wan-animate',
  'wan-vace',
  'h3-t2v',
  'h3-i2v',
  'longcat-t2v',
  'longcat-i2v',
  'longcat-continue',
  'ltx-nsfw-t2v',
  'ltx-nsfw-i2v',
  'ltx-nsfw-lipsync',
  'h3-nsfw-t2v',
  'h3-nsfw-i2v',
  'avatar-talk',
]);

/** M10 起移动端可提交的音频引擎白名单（ACE-Step 文生音乐，提交路由 /api/generate/audio） */
const SUPPORTED_AUDIO_ENGINE_IDS: ReadonlySet<string> = new Set(['ace-music']);

/** 引擎是否可被移动端提交：既有图像引擎（无 audio 参数）+ M9/M10 视频引擎 + ace-music */
export function isSupportedEngine(engine: EngineInfo): boolean {
  if (engine.kind === 'image') return isSubmittableImageEngine(engine);
  if (engine.kind === 'audio') return SUPPORTED_AUDIO_ENGINE_IDS.has(engine.id);
  return SUPPORTED_VIDEO_ENGINE_IDS.has(engine.id);
}

/**
 * schema 通用序列化（视频引擎共用）：number 型 ''/缺省回落 param.default 并 clamp 到 [min,max]；
 * negative trim 后非空才进请求体；seed（text 型）仅非负整数提交。
 * 注册表 `duration`（秒）映射为路由契约 `duration_sec`（h3/ltx25/longcat/wan/avatar 统一）——
 * 键名直抄会让后端 pydantic 忽略未知字段，用户时长静默落默认值（2026-08-17 断链修复）。
 */
function applySchemaParams<T extends object>(req: T, engine: EngineInfo, values: ParamValues): void {
  const target = req as Record<string, unknown>;
  for (const param of engine.params) {
    const raw = values[param.key];
    if (param.type === 'number') {
      let n = raw === '' || raw === null || raw === undefined ? Number(param.default) : Number(raw);
      if (Number.isFinite(n)) {
        // 构建期 clamp 到 schema 边界：画幅预设直写 width/height 不经 NumberField 失焦 clamp
        //（如 16:9 预设 1344 超 wan 系 width max 1280，不 clamp 会被后端 422）
        if (typeof param.min === 'number') n = Math.max(param.min, n);
        if (typeof param.max === 'number') n = Math.min(param.max, n);
        target[param.key === 'duration' ? 'duration_sec' : param.key] = n;
      }
    } else if (param.key === 'negative') {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (s) target.negative = s;
    } else if (param.key === 'seed') {
      const seed = serializeSeed(raw);
      if (seed !== undefined) target.seed = seed;
    }
  }
}

/** LTX-2.5 文生视频请求体：schema 数值键（width/height/length/fps/steps）全量提交 */
export function buildLtx25T2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): Ltx25T2VRequest {
  const req: Ltx25T2VRequest = { positive };
  applySchemaParams(req, engine, values);
  return req;
}

/** LTX-2.5 图生视频请求体：t2v 全集（含 strength）+ 参考图落点；无参考图返回 null */
export function buildLtx25I2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): Ltx25I2VRequest | null {
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref) return null;
  const req: Ltx25I2VRequest = {
    ...buildLtx25T2VRequest(engine, values, positive),
    image: ref.filename,
    worker: ref.worker,
  };
  return req;
}

/**
 * Wan2.2-Animate 请求体：参考图 + 驱动视频缺一不可；
 * worker 取参考图落点（视频上传时已钉同机；构建期不纠跨 worker 脏值，清理由 syncVideoWithRefImage 负责）
 */
export function buildWanAnimateRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): WanAnimateRequest | null {
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref) return null;
  const video = readUploadedVideo(engine, values);
  if (!video) return null;
  const req: WanAnimateRequest = {
    positive,
    image: ref.filename,
    video: video.filename,
    worker: ref.worker,
  };
  applySchemaParams(req, engine, values);
  return req;
}

/** Wan2.1-VACE 请求体：1-4 张参考图 filename 数组，worker 取第一张落点；无参考图返回 null */
export function buildWanVaceRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): WanVaceRequest | null {
  const refs = readUploadedRefs(engine, values);
  if (refs.length === 0) return null;
  const req: WanVaceRequest = {
    positive,
    images: refs.map((r) => r.filename),
    worker: refs[0].worker,
  };
  applySchemaParams(req, engine, values);
  return req;
}

// ── H3 / LongCat / ACE 请求构建（M10，契约与 Web lib/engines.ts _h3Payload/_longcatPayload 对齐）──

/** LoRA 强度缺省值（H3 作者推荐，与 routes/h3_studio.py H3LoraInput 默认一致） */
export const LORA_DEFAULT_STRENGTH = 0.6;
/** LoRA 强度合法区间（h3_studio.py ge=0.5 le=1.0） */
export const LORA_STRENGTH_MIN = 0.5;
export const LORA_STRENGTH_MAX = 1.0;

/**
 * loras 参数值解析（对齐 Web engines.ts _loras，另加强度钳区间兜底脏数据）：
 * 非数组 → []；项缺 string name 跳过；strength 非有限数 → 0.6，再钳 0.5-1.0
 */
export function parseLoraValues(raw: unknown): LoraValue[] {
  if (!Array.isArray(raw)) return [];
  const out: LoraValue[] = [];
  for (const item of raw) {
    if (!item || typeof (item as LoraValue).name !== 'string') continue;
    const strength = (item as LoraValue).strength;
    const n =
      typeof strength === 'number' && Number.isFinite(strength) ? strength : LORA_DEFAULT_STRENGTH;
    out.push({
      name: (item as LoraValue).name,
      strength: Math.min(LORA_STRENGTH_MAX, Math.max(LORA_STRENGTH_MIN, n)),
    });
  }
  return out;
}

/** H3 文生视频请求体：schema 数值键（width/height/length/steps）全量 + loras 叠加（无 fps/cfg，模板锁定 24fps） */
export function buildH3T2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): H3T2VRequest {
  const req: H3T2VRequest = { positive };
  applySchemaParams(req, engine, values);
  req.loras = parseLoraValues(values.loras);
  return req;
}

/** H3 图生视频请求体：t2v 全集 + 参考图落点（上传 kind=h3_i2v，后端转运 H3 实例）；无参考图返回 null */
export function buildH3I2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): H3I2VRequest | null {
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref) return null;
  return {
    ...buildH3T2VRequest(engine, values, positive),
    image: ref.filename,
    worker: ref.worker,
  };
}

/** LongCat 文生视频请求体：schema 数值键（width/height/num_frames/steps/fps）全量（无 cfg，蒸馏链路固定 1.0） */
export function buildLongCatT2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): LongCatT2VRequest {
  const req: LongCatT2VRequest = { positive };
  applySchemaParams(req, engine, values);
  return req;
}

/** LongCat 图生视频请求体：t2v 全集 + 参考图落点（kind 复用 ltx_i2v，对齐 Web 回落）；无参考图返回 null */
export function buildLongCatI2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): LongCatI2VRequest | null {
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref) return null;
  return {
    ...buildLongCatT2VRequest(engine, values, positive),
    image: ref.filename,
    worker: ref.worker,
  };
}

/**
 * LongCat 视频续写请求体：video = 源视频产物 URL（注册表 text 参数，必填校验由调用方持文案）；
 * 空/空白返回 null
 */
export function buildLongCatContinueRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): LongCatContinueRequest | null {
  const video = typeof values.video === 'string' ? values.video.trim() : '';
  if (!video) return null;
  const req: LongCatContinueRequest = { positive, video };
  applySchemaParams(req, engine, values);
  return req;
}

/** ACE-Step 文生音乐请求体：positive 主提示词映射 tags 风格标签；lyrics 留空省略（纯音乐） */
export function buildAceMusicRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): AceMusicRequest {
  const req: AceMusicRequest = { tags: positive };
  applySchemaParams(req, engine, values);
  const lyrics = typeof values.lyrics === 'string' ? values.lyrics.trim() : '';
  if (lyrics) req.lyrics = lyrics;
  return req;
}

// ── R18 视频引擎请求构建（M11，契约与 Web lib/engines.ts _ltxNsfwPayload/_h3NsfwPayload 对齐）──

/** R18 分辨率预设换算：select 值 "WxH" → {width, height}；非法/缺失 → fallback 预设（对齐 Web _resolution） */
function resolutionPreset(values: ParamValues, fallback: string): { width: number; height: number } {
  const raw = typeof values.resolution === 'string' ? values.resolution : fallback;
  const m = /^(\d+)x(\d+)$/.exec(raw);
  const [w, h] = (m ? [m[1], m[2]] : fallback.split('x')).map(Number);
  return { width: w, height: h };
}

/** R18 时长预设解析：select 值即秒数，直传 duration_sec（网格/裁切由后端统一策略层负责，对齐 Web _durationSec） */
function nsfwDurationSec(values: ParamValues, fallback = 6): number {
  const raw = typeof values.duration === 'string' ? values.duration : String(fallback);
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * LTX-2.3 R18 文生视频请求体：resolution 预设换算 width/height，duration 预设直传 duration_sec
 * （注册表 select 不直传键名），fps/steps/cfg 走 schema 数值序列化；
 * use_upscale/use_rife 布尔始终携带（对齐 Web _bool）
 */
export function buildLtxNsfwT2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): LtxNsfwT2VRequest {
  const { width, height } = resolutionPreset(values, '1280x720');
  const req: LtxNsfwT2VRequest = {
    positive,
    width,
    height,
    duration_sec: nsfwDurationSec(values),
    use_upscale: values.use_upscale === true,
    use_rife: values.use_rife === true,
  };
  applySchemaParams(req, engine, values);
  return req;
}

/** LTX-2.3 R18 图生视频请求体：t2v 全集 + 参考图落点（kind=ltx_i2v，LTX2.3 同机生成无转运）；无参考图返回 null */
export function buildLtxNsfwI2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): LtxNsfwI2VRequest | null {
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref) return null;
  return {
    ...buildLtxNsfwT2VRequest(engine, values, positive),
    image: ref.filename,
    worker: ref.worker,
  };
}

/**
 * LTX-2.3 R18 口型同步请求体：t2v 全集 + 参考图/驱动音频落点（互钉同 worker，上传时完成；
 * 换 worker/移除由 syncAudioWithRefImage 清理）；id_lora trim 空串省略（留空不用）；缺参考图/音频返回 null
 */
export function buildLtxNsfwLipsyncRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): LtxNsfwLipsyncRequest | null {
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref) return null;
  const audio = readUploadedAudio(engine, values);
  if (!audio) return null;
  const req: LtxNsfwLipsyncRequest = {
    ...buildLtxNsfwT2VRequest(engine, values, positive),
    image: ref.filename,
    audio: audio.filename,
    worker: ref.worker,
  };
  const idLora = typeof values.id_lora === 'string' ? values.id_lora.trim() : '';
  if (idLora) req.id_lora = idLora;
  return req;
}

/**
 * R18 H3 文生视频请求体：resolution 预设换算 32 对齐宽高 + duration 预设直传 duration_sec
 * （对齐 Web _h3NsfwPayload；帧网格/裁切由后端统一策略层负责，含新增 4s/8s 档）；
 * loras 叠加同 SFW H3；无 fps/cfg（H3 模板内锁定 24fps）
 */
export function buildH3NsfwT2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): H3T2VRequest {
  const { width, height } = resolutionPreset(values, '1280x736');
  const req: H3T2VRequest = {
    positive,
    width,
    height,
    duration_sec: nsfwDurationSec(values),
  };
  applySchemaParams(req, engine, values);
  req.loras = parseLoraValues(values.loras);
  return req;
}

/** R18 H3 图生视频请求体：t2v 全集 + 参考图落点（kind=h3_i2v，pool 存文件后端转运 H3 实例）；无参考图返回 null */
export function buildH3NsfwI2VRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): H3I2VRequest | null {
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref) return null;
  return {
    ...buildH3NsfwT2VRequest(engine, values, positive),
    image: ref.filename,
    worker: ref.worker,
  };
}

// ── LongCat-Avatar 数字人请求构建（M14，契约与 routes/avatar_studio.py AvatarTalkRequest 对齐）──

/** 16 对齐向下取整（与后端 _snap16 同语义；注册表 width/height step=16，构建期 snap 保证所见即所得） */
function snap16(n: number): number {
  return Math.floor(n / 16) * 16;
}

/**
 * LongCat-Avatar 数字人请求体：人像首帧 + 驱动音频缺一不可（null 由 buildEngineSubmit 映射本地校验文案）；
 * worker 取人像落点（音频上传时已钉同机；换 worker/移除由 syncAudioWithRefImage 清理，构建期不纠跨 worker 脏值）；
 * 数值键（width/height/duration/fps/steps）走 schema 序列化（duration 映射 duration_sec），宽高再 snap16（对齐后端非对齐向下取整）；
 * shift/cfg/dmd_lora_strength 注册表未暴露，省略由后端默认（12.0/1.0/1.0）
 */
export function buildAvatarTalkRequest(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): AvatarTalkRequest | null {
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref) return null;
  const audio = readUploadedAudio(engine, values);
  if (!audio) return null;
  const req: AvatarTalkRequest = {
    positive,
    image: ref.filename,
    audio: audio.filename,
    worker: ref.worker,
  };
  applySchemaParams(req, engine, values);
  if (typeof req.width === 'number') req.width = snap16(req.width);
  if (typeof req.height === 'number') req.height = snap16(req.height);
  return req;
}

/**
 * 参考图变更联动（对齐 Web GenerateView）：驱动视频钉参考图落点 worker ——
 * 参考图换 worker 或被移除时，已上传驱动视频强制清空重传（跨 worker 无法生成）
 */
export function syncVideoWithRefImage(
  engine: EngineInfo,
  values: ParamValues,
  changedKey: string,
): ParamValues {
  const videoParam = engine.params.find((p) => p.type === 'video');
  const imagesParam = engine.params.find((p) => p.type === 'images');
  if (!videoParam || !imagesParam || changedKey !== imagesParam.key) return values;
  const video = readUploadedVideo(engine, values);
  if (!video) return values;
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref || ref.worker !== video.worker) {
    return { ...values, [videoParam.key]: null };
  }
  return values;
}

/**
 * 参考图变更联动（M11 ltx-nsfw-lipsync，对齐 syncVideoWithRefImage 语义）：
 * 驱动音频钉参考图落点 worker —— 参考图换 worker 或被移除时，已上传驱动音频强制清空重传
 */
export function syncAudioWithRefImage(
  engine: EngineInfo,
  values: ParamValues,
  changedKey: string,
): ParamValues {
  const audioParam = engine.params.find((p) => p.type === 'audio');
  const imagesParam = engine.params.find((p) => p.type === 'images');
  if (!audioParam || !imagesParam || changedKey !== imagesParam.key) return values;
  const audio = readUploadedAudio(engine, values);
  if (!audio) return values;
  const ref = readUploadedRefs(engine, values)[0];
  if (!ref || ref.worker !== audio.worker) {
    return { ...values, [audioParam.key]: null };
  }
  return values;
}

/** 提交载荷：图像/视频/音频引擎分支类型（显式包一层防 TanStack 透传契约外参数） */
export type SubmitPayload =
  | { type: 'txt2img'; req: Txt2ImgRequest }
  | { type: 'img2img'; req: Img2ImgRequest }
  | { type: 'ltx25-t2v'; req: Ltx25T2VRequest }
  | { type: 'ltx25-i2v'; req: Ltx25I2VRequest }
  | { type: 'wan-animate'; req: WanAnimateRequest }
  | { type: 'wan-vace'; req: WanVaceRequest }
  | { type: 'h3-t2v'; req: H3T2VRequest }
  | { type: 'h3-i2v'; req: H3I2VRequest }
  | { type: 'longcat-t2v'; req: LongCatT2VRequest }
  | { type: 'longcat-i2v'; req: LongCatI2VRequest }
  | { type: 'longcat-continue'; req: LongCatContinueRequest }
  | { type: 'ace-music'; req: AceMusicRequest }
  | { type: 'ltx-nsfw-t2v'; req: LtxNsfwT2VRequest }
  | { type: 'ltx-nsfw-i2v'; req: LtxNsfwI2VRequest }
  | { type: 'ltx-nsfw-lipsync'; req: LtxNsfwLipsyncRequest }
  | { type: 'h3-nsfw-t2v'; req: H3T2VRequest }
  | { type: 'h3-nsfw-i2v'; req: H3I2VRequest }
  | { type: 'avatar-talk'; req: AvatarTalkRequest };

/** 提交构建结果：成功携路由载荷；失败携本地校验人话（文案对齐 Web submitEngineGeneration） */
export type EngineSubmitResult =
  | { ok: true; payload: SubmitPayload }
  | { ok: false; error: string };

/**
 * 按引擎 id 路由构建提交载荷（对齐 Web submitEngineGeneration）：
 * - M9/M10 视频/音频引擎各归其位；未知引擎兜底：带 images 走 img2img，否则 txt2img
 * - 本地校验顺序：参考图先于驱动视频；wan-vace 多图文案「请先上传参考图(至少 1 张)」；
 *   longcat-continue 源视频 URL 必填文案「请填写源视频产物 URL(/api/images?...)」
 */
export function buildEngineSubmit(
  engine: EngineInfo,
  values: ParamValues,
  positive: string,
): EngineSubmitResult {
  switch (engine.id) {
    case 'ltx25-t2v':
      return {
        ok: true,
        payload: { type: 'ltx25-t2v', req: buildLtx25T2VRequest(engine, values, positive) },
      };
    case 'ltx25-i2v': {
      const req = buildLtx25I2VRequest(engine, values, positive);
      if (!req) return { ok: false, error: '请先上传参考图' };
      return { ok: true, payload: { type: 'ltx25-i2v', req } };
    }
    case 'wan-animate': {
      // 校验顺序对齐 Web：先参考图后驱动视频
      if (readUploadedRefs(engine, values).length === 0) {
        return { ok: false, error: '请先上传参考图' };
      }
      const req = buildWanAnimateRequest(engine, values, positive);
      if (!req) return { ok: false, error: '请先上传驱动视频' };
      return { ok: true, payload: { type: 'wan-animate', req } };
    }
    case 'wan-vace': {
      const req = buildWanVaceRequest(engine, values, positive);
      if (!req) return { ok: false, error: '请先上传参考图(至少 1 张)' };
      return { ok: true, payload: { type: 'wan-vace', req } };
    }
    case 'h3-t2v':
      return {
        ok: true,
        payload: { type: 'h3-t2v', req: buildH3T2VRequest(engine, values, positive) },
      };
    case 'h3-i2v': {
      const req = buildH3I2VRequest(engine, values, positive);
      if (!req) return { ok: false, error: '请先上传参考图' };
      return { ok: true, payload: { type: 'h3-i2v', req } };
    }
    case 'longcat-t2v':
      return {
        ok: true,
        payload: { type: 'longcat-t2v', req: buildLongCatT2VRequest(engine, values, positive) },
      };
    case 'longcat-i2v': {
      const req = buildLongCatI2VRequest(engine, values, positive);
      if (!req) return { ok: false, error: '请先上传参考图' };
      return { ok: true, payload: { type: 'longcat-i2v', req } };
    }
    case 'longcat-continue': {
      const req = buildLongCatContinueRequest(engine, values, positive);
      // 校验文案对齐 Web submitEngineGeneration（源视频产物 URL 必填）
      if (!req) return { ok: false, error: '请填写源视频产物 URL(/api/images?...)' };
      return { ok: true, payload: { type: 'longcat-continue', req } };
    }
    case 'ace-music':
      return {
        ok: true,
        payload: { type: 'ace-music', req: buildAceMusicRequest(engine, values, positive) },
      };
    case 'ltx-nsfw-t2v':
      return {
        ok: true,
        payload: { type: 'ltx-nsfw-t2v', req: buildLtxNsfwT2VRequest(engine, values, positive) },
      };
    case 'ltx-nsfw-i2v': {
      const req = buildLtxNsfwI2VRequest(engine, values, positive);
      if (!req) return { ok: false, error: '请先上传参考图' };
      return { ok: true, payload: { type: 'ltx-nsfw-i2v', req } };
    }
    case 'ltx-nsfw-lipsync': {
      // 校验顺序对齐 Web submitEngineGeneration：先参考图后驱动音频
      if (readUploadedRefs(engine, values).length === 0) {
        return { ok: false, error: '请先上传参考图' };
      }
      const req = buildLtxNsfwLipsyncRequest(engine, values, positive);
      if (!req) return { ok: false, error: '请先上传驱动音频' };
      return { ok: true, payload: { type: 'ltx-nsfw-lipsync', req } };
    }
    case 'h3-nsfw-t2v':
      return {
        ok: true,
        payload: { type: 'h3-nsfw-t2v', req: buildH3NsfwT2VRequest(engine, values, positive) },
      };
    case 'h3-nsfw-i2v': {
      const req = buildH3NsfwI2VRequest(engine, values, positive);
      if (!req) return { ok: false, error: '请先上传参考图' };
      return { ok: true, payload: { type: 'h3-nsfw-i2v', req } };
    }
    case 'avatar-talk': {
      // 校验顺序对齐 lipsync：先人象首帧后驱动音频
      if (readUploadedRefs(engine, values).length === 0) {
        return { ok: false, error: '请先上传人像首帧' };
      }
      const req = buildAvatarTalkRequest(engine, values, positive);
      if (!req) return { ok: false, error: '请先上传驱动音频' };
      return { ok: true, payload: { type: 'avatar-talk', req } };
    }
    default:
      if (engineNeedsRefImage(engine)) {
        const req = buildImg2ImgRequest(engine, values, positive);
        if (!req) return { ok: false, error: '请先上传参考图' };
        return { ok: true, payload: { type: 'img2img', req } };
      }
      return {
        ok: true,
        payload: { type: 'txt2img', req: buildTxt2ImgRequest(engine, values, positive) },
      };
  }
}

function lightHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** M17 反推体积上限（与后端 config reverse_max_image_mb / reverse_max_video_mb 同源） */
const REVERSE_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const REVERSE_MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export function GenerateScreen() {
  const { colors, spacing, typography, radius } = useAppTheme();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState('');
  const [engineId, setEngineId] = useState<string | null>(null);
  const [paramsVisible, setParamsVisible] = useState(false);
  // schema 驱动的表单值；formEngineId 记录值归属的引擎（切换即整体重置）
  const [formEngineId, setFormEngineId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<ParamValues>({});
  // 本地表单校验错误（如 img2img 未上传参考图）；与 mutation.error 同横幅展示
  const [formError, setFormError] = useState<string | null>(null);
  // M17 反推提示词：VLM 长任务进行中文案/禁用态
  const [reversing, setReversing] = useState(false);
  // M18 优化提示词：LLM 调用进行中文案/禁用态
  const [optimizing, setOptimizing] = useState(false);

  const enginesQuery = useQuery({ queryKey: ['engines'], queryFn: fetchEngines });
  // M9.3 起列表放开图像+视频；M10 起 ace-music 接入（音频引擎也展示）；
  // 未接入（白名单外）或后端不可用引擎禁用态；
  // M14 归一化：avatar-talk 注册表 audio 为 text 型 → audio 型，复用 RefAudioField 上传/互钉链路
  const engines = (enginesQuery.data ?? []).map(normalizeEngineSchema);
  const selectedEngineId =
    engineId ?? engines.find((e) => isSupportedEngine(e) && e.available)?.id ?? null;
  const selectedEngine = engines.find((e) => e.id === selectedEngineId) ?? null;

  // React 19 渲染期间状态调整：引擎切换即把表单重置为新引擎 schema 默认值
  if (selectedEngine && selectedEngine.id !== formEngineId) {
    setFormEngineId(selectedEngine.id);
    setFormValues(defaultParamValues(selectedEngine));
    setFormError(null);
  }

  // 作品库「复用」回填：tab 常驻挂载，用 focus 时机消费一次性草稿
  useFocusEffect(
    useCallback(() => {
      const draft = useGenerationDraft.getState().consumeDraft();
      if (draft?.prompt) setPrompt(draft.prompt);
    }, []),
  );

  const mutation = useMutation({
    // 显式包一层：TanStack v5 会把 { client, meta, mutationKey } 作为第二参透传，
    // 防止 API 函数收到契约外参数（也让调用断言可验证纯请求体）
    mutationFn: (payload: SubmitPayload) => {
      switch (payload.type) {
        case 'img2img':
          return submitImg2Img(payload.req);
        case 'ltx25-t2v':
          return submitLtx25T2V(payload.req);
        case 'ltx25-i2v':
          return submitLtx25I2V(payload.req);
        case 'wan-animate':
          return submitWanAnimate(payload.req);
        case 'wan-vace':
          return submitWanVace(payload.req);
        case 'h3-t2v':
          return submitH3T2V(payload.req);
        case 'h3-i2v':
          return submitH3I2V(payload.req);
        case 'longcat-t2v':
          return submitLongCatT2V(payload.req);
        case 'longcat-i2v':
          return submitLongCatI2V(payload.req);
        case 'longcat-continue':
          return submitLongCatContinue(payload.req);
        case 'ace-music':
          return submitAceMusic(payload.req);
        case 'ltx-nsfw-t2v':
          return submitLtxNsfwT2V(payload.req);
        case 'ltx-nsfw-i2v':
          return submitLtxNsfwI2V(payload.req);
        case 'ltx-nsfw-lipsync':
          return submitLtxNsfwLipsync(payload.req);
        case 'h3-nsfw-t2v':
          // h3-nsfw-* 与 SFW 同一 POST /api/h3/* 链路（专区内自带 X-NSFW 头，后端打标）
          return submitH3T2V(payload.req);
        case 'h3-nsfw-i2v':
          return submitH3I2V(payload.req);
        case 'avatar-talk':
          return submitAvatarTalk(payload.req);
        default:
          return submitTxt2Img(payload.req);
      }
    },
    onSuccess: (res) => {
      // M29：登记会话内 SSE 凭据（作业屏追踪经 SSE 推确定性进度；其余作业仍走轮询）
      registerJobSseCreds(res);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPrompt('');
      setFormError(null);
      // 作业屏轮询载体：失效后下次进入立即拉最新
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    },
  });

  const submit = () => {
    const positive = prompt.trim();
    if (!positive || mutation.isPending) return;
    if (!selectedEngine) {
      // 引擎未加载完成的兜底：仍按 1:1 默认画幅提交（后端默认 512 过小）
      mutation.mutate({
        type: 'txt2img',
        req: { positive, width: SIZE_PRESETS[0].width, height: SIZE_PRESETS[0].height },
      });
      return;
    }
    const result = buildEngineSubmit(selectedEngine, formValues, positive);
    if (!result.ok) {
      // 客户端校验文案与 Web submitEngineGeneration 一致（缺参考图/驱动视频）
      setFormError(result.error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    mutation.mutate(result.payload);
  };

  /**
   * M17 反推提示词：相册选图/视频 → POST /api/reverse → VLM 反推英文 prompt 回填
   * （覆盖语义对齐 Web ReverseButton → GenerateView 回填；negative 有值则写入表单 negative 参数）
   * 客户端先验体积（图片 ≤20MB / 视频 ≤50MB，与后端 reverse_max_*_mb 同源），超限不进网络
   */
  const reverse = async () => {
    if (reversing || mutation.isPending) return;
    setFormError(null);
    lightHaptic();

    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 1,
      });
    } catch {
      setFormError('无法打开相册，请重试');
      return;
    }
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    // 客户端先验：体积（fileSize 可得时；expo asset.type 区分图片/视频）
    const isVideo = asset.type === 'video';
    const limit = isVideo ? REVERSE_MAX_VIDEO_BYTES : REVERSE_MAX_IMAGE_BYTES;
    if (asset.fileSize !== undefined && asset.fileSize > limit) {
      setFormError(isVideo ? '视频超过 50MB 上限' : '图片超过 20MB 上限');
      return;
    }

    setReversing(true);
    try {
      const r = await reversePrompt({
        uri: asset.uri,
        fileName: asset.fileName,
        mimeType: asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
      });
      setPrompt(r.prompt);
      if (r.negative) {
        setFormValues((prev) => ({ ...prev, negative: r.negative as string }));
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '反推失败，请重试');
    } finally {
      setReversing(false);
    }
  };

  /**
   * M18 优化提示词：口语输入 → POST /api/optimize → LLM 扩写专业英文 prompt 回填
   * （覆盖语义对齐 Web OptimizeButton：prompt 覆盖 + negative 有值写入表单 negative 参数）
   * kind 跟随当前选中引擎（image/video/audio 直通后端题材判定）；空 prompt 不发起（按钮态同步禁用）
   */
  const optimize = async () => {
    if (optimizing || reversing || mutation.isPending) return;
    const text = prompt.trim();
    if (!text) return;
    setFormError(null);
    lightHaptic();
    setOptimizing(true);
    try {
      const r = await optimizePrompt({ prompt: text, kind: selectedEngine?.kind ?? 'image' });
      setPrompt(r.optimized);
      if (r.negative) {
        setFormValues((prev) => ({ ...prev, negative: r.negative as string }));
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '优化失败，请重试');
    } finally {
      setOptimizing(false);
    }
  };

  const errorMessage =
    formError ??
    (mutation.error && (mutation.error as Error).name === 'ApiError'
      ? (mutation.error as Error).message
      : mutation.error
        ? '提交失败，请稍后重试'
        : null);

  return (
    <Screen edges={['top', 'left', 'right']} testID="screen-generate">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, paddingHorizontal: spacing[4] }}>
          {/* 标题行：创作 + 对话助手入口（M19，MessageCircle → /assistant 栈页） */}
          <View
            style={{
              marginTop: spacing[4],
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text
              style={{
                color: colors.text,
                fontSize: typography.title.fontSize,
                lineHeight: typography.title.lineHeight,
                fontWeight: '700',
                letterSpacing: typography.title.letterSpacing,
              }}
            >
              创作
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="打开对话助手"
              onPress={() => {
                lightHaptic();
                router.push('/assistant');
              }}
              hitSlop={8}
              testID="generate-assistant-button"
              style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="MessageCircle" size={24} color={colors.text} />
            </Pressable>
          </View>

          {/* 引擎 chips（单选，选中写入本地状态） */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, marginTop: spacing[3] }}
            contentContainerStyle={{ gap: spacing[2] }}
            testID="engine-list"
          >
            {engines.map((engine) => {
              const active = engine.id === selectedEngineId;
              // 未接入（白名单外）或后端不可用：禁用态展示，不可选中
              const disabled = !isSupportedEngine(engine) || !engine.available;
              return (
                <Pressable
                  key={engine.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled }}
                  disabled={disabled}
                  onPress={() => {
                    lightHaptic();
                    setEngineId(engine.id);
                  }}
                  testID={`engine-chip-${engine.id}`}
                  style={{
                    minHeight: 40,
                    paddingHorizontal: spacing[4],
                    borderRadius: radius.full,
                    borderWidth: 1,
                    borderColor: active ? colors.accent : colors.border,
                    backgroundColor: active ? colors.accentSoft : colors.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'row',
                    gap: spacing[1],
                    opacity: disabled ? 0.45 : 1,
                  }}
                >
                  <Text
                    style={{
                      color: active ? colors.accent : colors.textSecondary,
                      fontSize: typography.body.fontSize,
                      lineHeight: typography.body.lineHeight,
                      fontWeight: active ? '600' : '400',
                    }}
                  >
                    {engine.label}
                  </Text>
                  {/* R18 徽标（对齐 Web GenerateView Badge tone=warn）：nsfw 引擎专区可见标识 */}
                  {engine.nsfw ? (
                    <Text
                      testID={`engine-chip-${engine.id}-r18`}
                      style={{
                        color: colors.warning,
                        fontSize: typography.caption.fontSize - 2,
                        lineHeight: typography.caption.lineHeight,
                        fontWeight: '700',
                      }}
                    >
                      R18
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              icon="Wand2"
              title="开始第一次创作"
              description="一句话描述想要的画面，剩下的交给引擎"
              testID="empty-generate"
            />
          </View>

          {/* 提交反馈：成功横幅（可跳作业）/ 失败人话 */}
          {mutation.isSuccess ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/jobs')}
              testID="submit-success-banner"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: colors.accentSoft,
                borderRadius: radius.md,
                paddingHorizontal: spacing[3],
                paddingVertical: spacing[2],
                marginBottom: spacing[2],
              }}
            >
              <Icon name="CircleCheck" size={20} color={colors.accent} />
              <Text
                style={{
                  marginLeft: spacing[2],
                  flex: 1,
                  color: colors.text,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                已提交，作业排队中 · 查看作业
              </Text>
              <Icon name="ChevronRight" size={20} color={colors.accent} />
            </Pressable>
          ) : null}

          {errorMessage ? (
            <View
              testID="submit-error-banner"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.danger,
                borderRadius: radius.md,
                paddingHorizontal: spacing[3],
                paddingVertical: spacing[2],
                marginBottom: spacing[2],
              }}
            >
              <Icon name="CircleAlert" size={20} color={colors.danger} />
              <Text
                style={{
                  marginLeft: spacing[2],
                  flex: 1,
                  color: colors.danger,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                {errorMessage}
              </Text>
            </View>
          ) : null}
        </View>

        <PromptBar
          value={prompt}
          onChange={setPrompt}
          onSubmit={submit}
          onOpenParams={() => {
            lightHaptic();
            setParamsVisible(true);
          }}
          onReverse={() => void reverse()}
          reversing={reversing}
          onOptimize={() => void optimize()}
          optimizing={optimizing}
          submitting={mutation.isPending}
        />
      </KeyboardAvoidingView>

      <ParamSheet
        visible={paramsVisible}
        onClose={() => setParamsVisible(false)}
        engine={selectedEngine}
        values={formValues}
        onValueChange={(key, value) =>
          setFormValues((prev) => {
            const next = { ...prev, [key]: value };
            if (!selectedEngine) return next;
            // 参考图变更联动：驱动视频/驱动音频钉参考图落点，换 worker/移除即清空重传（对齐 Web）
            return syncAudioWithRefImage(
              selectedEngine,
              syncVideoWithRefImage(selectedEngine, next, key),
              key,
            );
          })
        }
      />
    </Screen>
  );
}

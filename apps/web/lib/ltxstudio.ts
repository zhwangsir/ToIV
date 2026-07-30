"use client";

import { API_BASE, authHeaders } from "./api";
import type { GenerateResponse, JobItem } from "./types";

// ── LTX-2.3 工作室(/api/ltx2/*)──
// 独立于 NSFW 专区 /api/generate/ltx-*:底模白名单可选(SFW 无门槛),
// 支持 loras/ltx2.3/ 目录 LoRA 叠加(最多 3 个)。

export interface Ltx2UnetInfo {
  name: string;
  nsfw: boolean;
  available: boolean;
}

export interface Ltx2LoraInfo {
  name: string;
  available: boolean;
}

export interface Ltx2ModelsResponse {
  unets: Ltx2UnetInfo[];
  loras: Ltx2LoraInfo[];
  gemma: string;
  vae: string;
}

export interface Ltx2LoraSelection {
  name: string;
  strength: number;
}

export interface Ltx2T2VParams {
  positive: string;
  negative?: string;
  unet_name: string;
  loras?: Ltx2LoraSelection[];
  width: number;
  height: number;
  length: number;
  fps: number;
  steps: number;
  cfg: number;
  seed?: number | null;
  use_upscale: boolean;
  use_rife: boolean;
}

export interface Ltx2I2VParams extends Ltx2T2VParams {
  image: string; // 已上传的参考图文件名
  worker: string; // 参考图所在 worker
}

async function postJson<T>(path: string, body: object, errLabel: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    // 422 时 detail 是校验错误数组,展开首条可读信息
    const msg = Array.isArray(detail?.detail)
      ? (detail.detail[0]?.msg ?? errLabel)
      : (detail?.detail ?? `${errLabel} (${res.status})`);
    throw new Error(msg);
  }
  return res.json();
}

/** 板块资产清单(白名单底模 + ltx2.3 LoRA,带 worker 可用性)。契约:GET /api/ltx2/models。 */
export async function getLtx2Models(): Promise<Ltx2ModelsResponse> {
  const res = await fetch(`${API_BASE}/api/ltx2/models`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载 LTX 模型清单失败 (${res.status})`);
  return res.json();
}

/** 文生视频。契约:POST /api/ltx2/t2v。 */
export function generateLtx2T2V(params: Ltx2T2VParams): Promise<GenerateResponse> {
  return postJson("/api/ltx2/t2v", params, "LTX 文生视频请求失败");
}

/** 图生视频。契约:POST /api/ltx2/i2v。 */
export function generateLtx2I2V(params: Ltx2I2VParams): Promise<GenerateResponse> {
  return postJson("/api/ltx2/i2v", params, "LTX 图生视频请求失败");
}

/** 按 prompt_id 查作业状态(轮询用)。契约:GET /api/jobs;未出现在近期列表返回 null。 */
export async function fetchLtx2Job(promptId: string): Promise<JobItem | null> {
  const res = await fetch(`${API_BASE}/api/jobs?limit=50`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`查询作业状态失败 (${res.status})`);
  const jobs = (await res.json()) as JobItem[];
  return jobs.find((j) => j.prompt_id === promptId) ?? null;
}

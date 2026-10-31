"use client";

/**
 * H3 智能加速档位(2026-09-12):off|lossless|balanced|extreme。
 * 倍率优先取后端实测规格(GET /api/h3/acceleration/profiles,规格文件可读时
 * source=measured);接口失败/档位缺失时回落社区参考值(source=reference,
 * 选择器注明「参考」)。默认关闭(原生提交)。
 */

import { apiFetch, authHeaders } from "./api";
import { CACHE_KEYS, TTL, swr } from "./swr-cache";

export type H3AccelLevel = "off" | "lossless" | "balanced" | "extreme";

export const H3_ACCEL_LEVELS: readonly H3AccelLevel[] = ["off", "lossless", "balanced", "extreme"];

export interface H3AccelProfileInfo {
  level: H3AccelLevel;
  label: string;
  /** 加速倍率;off 档为 null。 */
  speedup: number | null;
  /** measured=后端规格文件实测;reference=社区参考值(规格缺失)。 */
  source: "measured" | "reference";
  /** false=基准方下架,前端置灰「暂不可用」(缺省 true)。 */
  recommended: boolean;
}

/** 社区参考值(后端规格文件缺失时的兜底展示,选择器注明「参考」)。 */
export const H3_ACCEL_REFERENCE: readonly H3AccelProfileInfo[] = [
  { level: "off", label: "关闭", speedup: null, source: "reference", recommended: true },
  { level: "lossless", label: "无损加速", speedup: 1.4, source: "reference", recommended: true },
  { level: "balanced", label: "甜点位", speedup: 2.0, source: "reference", recommended: true },
  { level: "extreme", label: "极限加速", speedup: 3.2, source: "reference", recommended: true },
];

function normalizeProfiles(data: unknown): H3AccelProfileInfo[] {
  const raw = (data as { levels?: unknown } | null)?.levels;
  if (!Array.isArray(raw)) return [...H3_ACCEL_REFERENCE];
  const byLevel = new Map<H3AccelLevel, H3AccelProfileInfo>();
  for (const item of raw) {
    const p = item as Partial<H3AccelProfileInfo>;
    if (!p || typeof p.level !== "string") continue;
    if (!(H3_ACCEL_LEVELS as readonly string[]).includes(p.level)) continue;
    byLevel.set(p.level as H3AccelLevel, {
      level: p.level as H3AccelLevel,
      label: typeof p.label === "string" && p.label ? p.label : p.level,
      speedup: typeof p.speedup === "number" && Number.isFinite(p.speedup) ? p.speedup : null,
      source: p.source === "measured" ? "measured" : "reference",
      recommended: p.recommended !== false,
    });
  }
  // 档位缺一口径不整 → 全量回落参考值(宁缺毋滥)
  if (byLevel.size !== H3_ACCEL_LEVELS.length) return [...H3_ACCEL_REFERENCE];
  return H3_ACCEL_LEVELS.map((l) => byLevel.get(l)!);
}

async function fetchProfilesRaw(): Promise<H3AccelProfileInfo[]> {
  try {
    const res = await apiFetch("/api/h3/acceleration/profiles", { headers: authHeaders() });
    if (!res.ok) return [...H3_ACCEL_REFERENCE];
    return normalizeProfiles(await res.json().catch(() => null));
  } catch {
    return [...H3_ACCEL_REFERENCE];
  }
}

/** 档位清单(SWR 缓存 60s;任何失败静默回落社区参考值,不挡运行表单)。 */
export function fetchH3AccelProfiles(): Promise<H3AccelProfileInfo[]> {
  return swr(CACHE_KEYS.h3Accel, fetchProfilesRaw, TTL.h3Accel);
}

/** 引擎/应用是否 H3 家族(后端 422 口径一致:id 前缀 h3- 或图含 H3 节点家族)。 */
export function isH3EngineId(engineId: string): boolean {
  return engineId.startsWith("h3-");
}

export interface H3AccelOption {
  value: H3AccelLevel;
  label: string;
  hint: string;
  /** true=规格文件 recommended=false(基准方下架),置灰不可选。 */
  unavailable?: boolean;
}

const QUALITY_NOTE: Record<Exclude<H3AccelLevel, "off">, string> = {
  lossless: "质量基本无损,小幅加速",
  balanced: "质量与速度平衡(推荐档)",
  extreme: "速度优先,质量可能有可见损失",
};

/** 选择器选项:label 带倍率(实测/参考注明),hint 说明质量影响。 */
export function h3AccelOptions(profiles: readonly H3AccelProfileInfo[]): H3AccelOption[] {
  return profiles.map((p) => {
    if (p.level === "off" || p.speedup == null) {
      return { value: p.level, label: "关闭 · 原速", hint: "按原生参数提交,不加速" };
    }
    const tag = p.source === "measured" ? "实测" : "参考";
    const opt: H3AccelOption = {
      value: p.level,
      label: `${p.label} · ~${p.speedup}x(${tag})`,
      hint: QUALITY_NOTE[p.level],
    };
    if (p.recommended === false) {
      opt.unavailable = true;
      opt.label = `${opt.label} · 暂不可用`;
      opt.hint = "该档位已被基准方下架,暂不可用;提交将按原生参数执行";
    }
    return opt;
  });
}

/**
 * Ordinary H3 视频时长诚实度 + 提交后展示(2026-08-30)。
 *
 * Native H3 单段约 15s@24fps;15–60s 是末帧 i2v 分段续写再 concat,不是一镜到底。
 * 普通(非 advanced) h3-t2v / h3-i2v:预设钉在 4–15s,超 15s 须显式打开「分段续写」。
 * 主体封面切到 i2v 后,历史/进度条按实际 payload 显示「图生视频」,不继续挂文生标签。
 * 时长链 concat 回写在提交返回的父 prompt_id 上;h3_extend_i2v 只是段作业,tracker 不改绑。
 */
import type { EngineInfo, EngineParam, EngineParamOption } from "./engines";

export const H3_NATIVE_MAX_SEC = 15;

/** 普通 H3 文生/图生(注册表 ordinary_default;不含 multishot / advanced)。 */
export const H3_ORDINARY_IDS: ReadonlySet<string> = new Set(["h3-t2v", "h3-i2v"]);

export const H3_NATIVE_DURATION_VALUES = ["4", "5", "6", "8", "10", "15"] as const;

export const H3_EXTEND_DURATION_OPTIONS: readonly EngineParamOption[] = [
  { value: "20", label: "20 秒 · 分段续写" },
  { value: "30", label: "30 秒 · 分段续写" },
  { value: "45", label: "45 秒 · 分段续写" },
  { value: "60", label: "60 秒 · 分段续写" },
];

export function isOrdinaryH3Video(engineId: string): boolean {
  return H3_ORDINARY_IDS.has(engineId);
}

export function h3DurationSec(values: Record<string, unknown>, fallback = 5): number {
  const n = parseFloat(String(values["duration"] ?? fallback));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 关闭分段续写时把超 15s 的时长钳回原生上限(就近 15)。 */
export function clampH3ValuesOnExtendToggle(
  values: Record<string, unknown>,
  extendOn: boolean,
): Record<string, unknown> {
  if (extendOn) return { segment_extend: true };
  const sec = h3DurationSec(values);
  const next: Record<string, unknown> = { segment_extend: false };
  if (sec > H3_NATIVE_MAX_SEC) next.duration = String(H3_NATIVE_MAX_SEC);
  return next;
}

/**
 * 给普通 H3 时长下拉叠 15–60 档:仅当「分段续写」打开。
 * 注册表只声明原生 4–15,避免普通路径把 60s 当一镜能力。
 */
export function overlayOrdinaryH3DurationParams(
  engine: Pick<EngineInfo, "id" | "params">,
  values: Record<string, unknown>,
): EngineParam[] {
  if (!isOrdinaryH3Video(engine.id)) return engine.params;
  const extendOn = Boolean(values["segment_extend"]);
  return engine.params.map((p) => {
    if (p.key !== "duration" || p.type !== "select") return p;
    const native = p.options ?? [];
    if (!extendOn) return { ...p, options: native };
    const seen = new Set(native.map((o) => o.value));
    const extra = H3_EXTEND_DURATION_OPTIONS.filter((o) => !seen.has(o.value));
    return { ...p, options: [...native, ...extra] };
  });
}

export function isH3I2vKind(kind: string | undefined | null): boolean {
  return kind === "h3_i2v" || kind === "h3-i2v" || kind === "h3-nsfw-i2v";
}

export function isH3ExtendChildKind(kind: string | undefined | null): boolean {
  return typeof kind === "string" && kind.startsWith("h3_extend");
}

/**
 * 提交后历史/进度条文案。wentI2v 时显示图生,但 engineId 仍用所选引擎,
 * 方便失败重试走同一条封面→i2v 路径(改成 h3-i2v 会因缺参考图槽失败)。
 */
export function h3HistoryPresentation(
  engine: Pick<EngineInfo, "id" | "label">,
  opts: { wentI2v: boolean },
): { engineId: string; engineLabel: string } {
  if (!opts.wentI2v) return { engineId: engine.id, engineLabel: engine.label };
  if (engine.id === "h3-t2v") {
    return { engineId: engine.id, engineLabel: "MiniMax H3 图生视频" };
  }
  if (engine.id === "h3-nsfw-t2v") {
    return { engineId: engine.id, engineLabel: "MiniMax H3 图生视频(R18)" };
  }
  return { engineId: engine.id, engineLabel: engine.label };
}

/** payload 走了 i2v:后端 kind,或前端 h3-t2v 带着参考图/封面提交到 /api/h3/i2v。 */
export function h3PayloadWentI2v(opts: {
  engineId: string;
  backendKind?: string | null;
  hasRefImage?: boolean;
}): boolean {
  if (isH3I2vKind(opts.backendKind)) return true;
  if (opts.hasRefImage && (opts.engineId === "h3-t2v" || opts.engineId === "h3-nsfw-t2v")) {
    return true;
  }
  return false;
}

/**
 * 生成 tracker 始终跟提交返回的父 prompt_id。
 * 超 15s 时 concat 回写该父作业;段作业 kind=h3_extend_i2v 只进作品库,不改绑。
 */
export function h3TrackerParentPromptId(submitPromptId: string, backendKind?: string | null): string {
  void backendKind;
  return submitPromptId;
}

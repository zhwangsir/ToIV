import type { EngineParam } from "@/lib/engines";

/**
 * 宽高联动比例纠正(2026-08-17):生成内容宽高超出模型训练分布会出主体被裁/
 * 文字溢出画面。width 参数带 ar 安全域(视频 9:16~16:9,SD 图像 1:2~2:1),
 * 用户改任一维度时联动把另一维度抬回界内(保长边、抬短边,step 对齐),
 * 与后端 clamp_aspect_ratio 同规则——前端即时反馈,后端静默兜底。
 */

/** 纯数字输入(允许 "1024" / "10.5");空串/带尾点等中间输入态返回 null 不干预。 */
const isNumericInput = (v: unknown): v is number | string => {
  const s = String(v ?? "").trim();
  return /^\d+(\.\d+)?$/.test(s);
};

const parseNum = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
};

const snapFloor = (v: number, p: EngineParam): number => {
  const step = p.step || 1;
  const min = p.min ?? 0;
  const max = p.max ?? Infinity;
  return Math.min(max, Math.max(min, Math.floor(v / step) * step));
};

const snapCeil = (v: number, p: EngineParam): number => {
  const step = p.step || 1;
  const min = p.min ?? 0;
  const max = p.max ?? Infinity;
  return Math.min(max, Math.max(min, Math.ceil(v / step) * step));
};

/** 宽高联动结果:value 为本键钳位后的值;other 联动键新值(未联动则等于原值)。 */
export interface AspectPairResult {
  key: "width" | "height";
  value: number;
  otherKey: "width" | "height";
  otherValue: number;
}

/**
 * 按当前引擎参数 schema 纠正 width/height 输入。
 * 仅当 width 参数带 ar 安全域时生效;输入先钳回自身 [min,max] 并 step 对齐,
 * 比例越界时抬短边(ceil 保比例落在界内),撞 max 再压长边。
 */
export function applyAspectPair(
  key: string,
  raw: unknown,
  values: Record<string, unknown>,
  params: EngineParam[],
): AspectPairResult | null {
  if (key !== "width" && key !== "height") return null;
  const wParam = params.find((p) => p.key === "width");
  const hParam = params.find((p) => p.key === "height");
  if (!wParam || !hParam || !wParam.ar) return null;
  if (!isNumericInput(raw)) return null; // 中间输入态(""/"10.")交由原逻辑保存字符串
  const [lo, hi] = wParam.ar;

  const self = key === "width" ? wParam : hParam;
  const other = key === "width" ? hParam : wParam;
  const selfNum = Number(String(raw).trim());

  let w = snapFloor(selfNum, self);
  let h = snapFloor(parseNum(values[other.key], other.default as number), other);
  if (key === "height") {
    // 统一成 w/h 语义:输入的是 h,existing 是 w
    const tmp = h;
    h = w;
    w = tmp;
  }

  if (w / h > hi) {
    h = snapCeil(w / hi, hParam);
    if (h >= (hParam.max ?? Infinity) && w / h > hi) w = snapFloor(h * hi, wParam);
  } else if (w / h < lo) {
    w = snapCeil(h * lo, wParam);
    if (w >= (wParam.max ?? Infinity) && w / h < lo) h = snapFloor(w / lo, hParam);
  }

  const otherAfter = key === "width" ? h : w;
  return {
    key,
    value: key === "width" ? w : h,
    otherKey: other.key as "width" | "height",
    otherValue: otherAfter,
  };
}

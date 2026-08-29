/**
 * 任务中心纯函数呈现逻辑(2026-08-29 全量进度体系)。
 *
 * 独立成模块的原因:node:test 加载器把 @/lib/api 替换为 studio mock(无
 * fetchActiveJobs),含运行时 api 依赖的组件无法被单测直接 import。
 * 本模块零运行时依赖(ActiveJobItem 为 type-only import,转译后擦除)。
 */
import type { ActiveJobItem } from "@/lib/api";

/** kind → 中文显示名(任务中心条目首行)。未命中按前缀归类,再回落原样。 */
const KIND_LABELS: Record<string, string> = {
  txt2img: "文生图",
  img2img: "图生图",
  qwen_edit: "智能编辑",
  upscale: "图像超分",
  controlnet: "ControlNet",
  inpaint: "局部重绘",
  facedetailer: "脸部修复",
  removebg: "抠图",
  drama_char_reference_front: "角色三视图·正",
  drama_char_reference_side: "角色三视图·侧",
  drama_char_reference_back: "角色三视图·背",
  ltx25_multishot: "LTX 多镜头",
  studio_script_parse: "剧本拆解",
  h3_t2v: "文生视频",
  h3_i2v: "图生视频",
  h3_multishot: "多镜头",
  h3_extend_i2v: "长视频续写",
};

const KIND_PREFIX_LABELS: Array<[string, string]> = [
  ["h3_extend", "H3 续写"],
  ["h3_", "H3 视频"],
  ["wan_", "Wan 视频"],
  ["longcat", "LongCat 视频"],
  ["phantom", "Phantom 视频"],
  ["ovi_", "Ovi 视频"],
  ["ltx", "LTX 视频"],
  ["threed", "3D"],
  ["avatar", "数字人"],
  ["drama_", "短剧"],
  ["audio", "音频"],
];

export function kindLabel(kind: string): string {
  const exact = KIND_LABELS[kind];
  if (exact) return exact;
  for (const [prefix, label] of KIND_PREFIX_LABELS) {
    if (kind.startsWith(prefix)) return label;
  }
  return kind;
}

/** 秒 → "m:ss" / "h:mm:ss"(等待/ETA 时长显示)。 */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** ETA 粗估 → 人话("约 4 分钟" / "约 1 小时")。 */
export function fmtEta(sec: number): string {
  if (sec < 90) return "约 1 分钟";
  const min = Math.round(sec / 60);
  if (min < 60) return `约 ${min} 分钟`;
  const h = Math.round((min / 60) * 10) / 10;
  return `约 ${h} 小时`;
}

/** 单条目的状态行文案(纯函数,供单测)。 */
export function statusLineOf(item: ActiveJobItem): string {
  if (item.status === "held") {
    return item.hold_reason ? `资源排队中 · ${item.hold_reason}` : "资源排队中";
  }
  const { pct, step, total, queue_pos } = item.progress;
  if (item.status === "queued" && queue_pos && queue_pos > 0) {
    return `排队第 ${queue_pos} 位`;
  }
  if (pct !== null) {
    const steps = step !== null && total !== null ? ` (${step}/${total} 步)` : "";
    return `生成中 ${pct}%${steps}`;
  }
  return "生成中";
}

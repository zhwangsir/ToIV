"use client";

/**
 * Motion Brush 局部动效标记(对标 Runway Motion Brush / 海螺 H3)—— 纯函数层 + 提交链路。
 *
 * 后端契约(POST /api/motion-brush/mask,routes/motion_brush.py):
 * 在源图(视频首帧/参考图)上涂抹的笔画列表 → 服务端栅格化 RGBA mask PNG
 * (灰度=运动强度,alpha=方向角)→ 上传到源图所在 worker input 目录,
 * 返回 mask 文件名;视频引擎提交(/api/wan/vace、/api/generate/transition)
 * 经 motion_mask 参数引用,接 VACEEncode.input_masks(0=静止,255=运动)。
 *
 * 坐标系:mask 画布 = 引擎生成分辨率(maskWidth×maskHeight),编辑器画布与其
 * 1:1(源图按 cover 居中裁切绘制,与 ImageResizeKJv2 keep_proportion=crop 同语义)。
 */
import { apiFetch, authHeaders } from "./api";

export const BRUSH_MIN_RADIUS = 5;
export const BRUSH_MAX_RADIUS = 100;
export const BRUSH_MAX_STROKES = 64;
/** 拖拽距离短于此值视为「只标区域不定向」(方向零向量)。 */
export const DIRECTION_MIN_PX = 8;
/** 同一手势内采样 dab 的间距系数(× 半径),越小涂抹越连续。 */
export const DAB_SPACING_RATIO = 0.6;

/** 单个 dab(= 后端 BrushStroke):圆心(mask 像素)+ 半径 + 方向 + 强度。 */
export interface BrushDab {
  cx: number;
  cy: number;
  radius: number;
  dx: number;
  dy: number;
  strength: number;
  /** 所属手势 id(撤销/列表按手势分组;一次 pointerdown→up 可产生多个 dab)。 */
  gesture: number;
}

/** 方向矢量归一化:模长 >1 归一到单位圆;近零 → [0,0] 无方向(与后端同规则)。 */
export function normalizeDirection(dx: number, dy: number): [number, number] {
  const mag = Math.hypot(dx, dy);
  if (mag < 1e-6) return [0, 0];
  if (mag > 1) return [dx / mag, dy / mag];
  return [dx, dy];
}

/** 拖拽起止点 → 方向矢量:短于阈值 → [0,0](只标区域);否则归一化。 */
export function dragDirection(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): [number, number] {
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (Math.hypot(dx, dy) < DIRECTION_MIN_PX) return [0, 0];
  return normalizeDirection(dx, dy);
}

/** 半径钳制到 5-100px(滑块/后端同源约束)。 */
export function clampRadius(r: number): number {
  return Math.min(BRUSH_MAX_RADIUS, Math.max(BRUSH_MIN_RADIUS, Math.round(r)));
}

/** dab 圆心须在画布内(后端同规则;编辑器 pointer 映射天然在界内,此为防御)。 */
export function dabInCanvas(d: BrushDab, width: number, height: number): boolean {
  return d.cx >= 0 && d.cx < width && d.cy >= 0 && d.cy < height;
}

/** 撤销一步:移除最后一个手势的全部 dab(空数组原样返回)。 */
export function undoLastGesture(dabs: BrushDab[]): BrushDab[] {
  if (dabs.length === 0) return dabs;
  const last = dabs[dabs.length - 1].gesture;
  return dabs.filter((d) => d.gesture !== last);
}

/** 手势分组(列表/箭头展示用;保持首现序)。 */
export function groupByGesture(dabs: BrushDab[]): BrushDab[][] {
  const out: BrushDab[][] = [];
  const idx = new Map<number, number>();
  for (const d of dabs) {
    const at = idx.get(d.gesture);
    if (at === undefined) {
      idx.set(d.gesture, out.length);
      out.push([d]);
    } else {
      out[at].push(d);
    }
  }
  return out;
}

/** 手势代表方向角(度,0=右,顺时针;无方向 → null)。取该手势首个有向 dab。 */
export function gestureDirectionDeg(dabs: BrushDab[]): number | null {
  const d = dabs.find((x) => Math.hypot(x.dx, x.dy) >= 1e-6);
  if (!d) return null;
  return Math.round((Math.atan2(d.dy, d.dx) * 180) / Math.PI);
}

/** 提交门控:有笔画/非 busy/笔画未超上限(后端仍有同源校验兜底)。 */
export function motionBrushSubmittable(input: {
  dabs: number;
  busy: boolean;
}): boolean {
  return input.dabs > 0 && input.dabs <= BRUSH_MAX_STROKES && !input.busy;
}

export interface MotionBrushMaskResponse {
  /** mask 文件名(worker input 目录;视频引擎 motion_mask 参数引用它)。 */
  mask: string;
  width: number;
  height: number;
  strokes: number;
  /** 调试/预览回读 URL(/api/images?type=input)。 */
  url: string;
}

/** 提交笔画列表生成 mask:POST /api/motion-brush/mask(与 _postWan 同模式,422 展开)。 */
export async function submitMotionBrushMask(input: {
  sourceImage: string;
  worker: string;
  dabs: BrushDab[];
  width: number;
  height: number;
}): Promise<MotionBrushMaskResponse> {
  if (input.dabs.length === 0) throw new Error("请先在画面上涂抹标记运动区域");
  if (input.dabs.length > BRUSH_MAX_STROKES) {
    throw new Error(`笔画最多 ${BRUSH_MAX_STROKES} 个(当前 ${input.dabs.length},请撤销部分后重试)`);
  }
  const body = {
    source_image: input.sourceImage,
    worker: input.worker,
    width: input.width,
    height: input.height,
    strokes: input.dabs.map((d) => ({
      center_x: Math.round(d.cx * 100) / 100,
      center_y: Math.round(d.cy * 100) / 100,
      radius: d.radius,
      direction_x: Math.round(d.dx * 1000) / 1000,
      direction_y: Math.round(d.dy * 1000) / 1000,
      strength: d.strength,
    })),
  };
  const res = await apiFetch("/api/motion-brush/mask", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const msg = Array.isArray(detail?.detail)
      ? ((detail.detail[0] as { msg?: string } | undefined)?.msg ?? "Motion Brush 请求参数校验失败")
      : typeof detail?.detail === "string"
        ? detail.detail
        : `Motion Brush mask 生成失败 (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

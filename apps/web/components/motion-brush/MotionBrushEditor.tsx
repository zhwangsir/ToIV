"use client";

/**
 * Motion Brush 局部动效编辑器(弹窗):在源图(视频首帧/参考图)上涂抹标记运动区域,
 * 拖拽方向即运动方向;生成 mask 后由 GenerateView 把文件名填入视频引擎的 motion_mask。
 *
 * 画布内部分辨率 = 引擎生成分辨率(maskWidth×maskHeight),源图按 cover 居中裁切绘制
 * (与后端 ImageResizeKJv2 keep_proportion=crop 同语义),涂抹坐标 1:1 落进 mask。
 * 预览叠加层:半透明红色圆点 + 方向箭头;笔画数据见 lib/motionBrush。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  BRUSH_MAX_RADIUS,
  BRUSH_MAX_STROKES,
  BRUSH_MIN_RADIUS,
  DAB_SPACING_RATIO,
  clampRadius,
  dragDirection,
  gestureDirectionDeg,
  groupByGesture,
  motionBrushSubmittable,
  submitMotionBrushMask,
  undoLastGesture,
  type BrushDab,
} from "@/lib/motionBrush";

interface MotionBrushEditorProps {
  open: boolean;
  onClose: () => void;
  /** 源图预览 URL(参考图第一张;blob: 或签名 /api/images URL 均可)。 */
  sourceImageUrl: string;
  /** 源图上传句柄(mask 上传到同一 worker,提交时与参考图同路转运到 VACE 实例)。 */
  sourceRef: { filename: string; worker: string } | null;
  /** mask 栅格化尺寸(= 引擎当前 width/height 值)。 */
  maskWidth: number;
  maskHeight: number;
  /** mask 生成成功回调(文件名,填入引擎 motion_mask)。 */
  onApply: (maskName: string) => void;
}

/** canvas  cover 绘制源图(ImageResizeKJv2 crop 同语义:等比放大至覆盖,居中裁切)。 */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
): void {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

export function MotionBrushEditor({
  open,
  onClose,
  sourceImageUrl,
  sourceRef,
  maskWidth,
  maskHeight,
  onApply,
}: MotionBrushEditorProps) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(false);
  const [dabs, setDabs] = useState<BrushDab[]>([]);
  const [radius, setRadius] = useState(24);
  const [strength, setStrength] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gestureSeq = useRef(0);
  const drawing = useRef<{ id: number; startX: number; startY: number; lastX: number; lastY: number } | null>(null);

  // 打开时重置会话(上次 mask 已应用/废弃,笔画不跨会话保留)
  useEffect(() => {
    if (open) {
      setDabs([]);
      setError(null);
      setBusy(false);
      drawing.current = null;
    }
  }, [open]);

  // 源图加载(blob:/签名 URL 均可;失败不阻塞涂抹,坐标系与图像无关)
  useEffect(() => {
    if (!open || !sourceImageUrl) return;
    setImgReady(false);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgReady(true);
    };
    img.onerror = () => {
      imgRef.current = null;
      setImgReady(true); // 占位底也要触发首绘
    };
    img.src = sourceImageUrl;
    return () => {
      imgRef.current = null;
    };
  }, [open, sourceImageUrl]);

  // 重绘:底图(cover)+ 全部 dab(半透明红)+ 各手势方向箭头
  useEffect(() => {
    if (!open || !imgReady) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (imgRef.current) {
      drawCover(ctx, imgRef.current, w, h);
    } else {
      ctx.fillStyle = "#1a1a1e";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = `${Math.max(14, Math.round(h / 24))}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("源图预览不可用,仍可正常涂抹", w / 2, h / 2);
    }
    for (const d of dabs) {
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, d.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(235, 60, 60, ${0.18 + d.strength * 0.3})`;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, d.radius * 0.08);
      ctx.strokeStyle = "rgba(255, 90, 90, 0.9)";
      ctx.stroke();
    }
    // 方向箭头:每手势取首个 dab 圆心,沿方向画线 + 箭头头
    for (const group of groupByGesture(dabs)) {
      const deg = gestureDirectionDeg(group);
      if (deg === null) continue;
      const first = group[0];
      const rad = (deg * Math.PI) / 180;
      const len = first.radius * 1.8;
      const x2 = first.cx + Math.cos(rad) * len;
      const y2 = first.cy + Math.sin(rad) * len;
      ctx.beginPath();
      ctx.moveTo(first.cx, first.cy);
      ctx.lineTo(x2, y2);
      ctx.lineWidth = Math.max(2, first.radius * 0.12);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.stroke();
      const headLen = Math.max(6, first.radius * 0.45);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLen * Math.cos(rad - Math.PI / 6), y2 - headLen * Math.sin(rad - Math.PI / 6));
      ctx.lineTo(x2 - headLen * Math.cos(rad + Math.PI / 6), y2 - headLen * Math.sin(rad + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.fill();
    }
  }, [open, imgReady, dabs]);

  /** pointer 事件 → canvas(mask)坐标。 */
  const toCanvasPos = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }, []);

  function addDab(x: number, y: number, gesture: number) {
    setDabs((prev) => {
      if (prev.length >= BRUSH_MAX_STROKES) return prev;
      return [...prev, { cx: x, cy: y, radius, dx: 0, dy: 0, strength, gesture }];
    });
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 || busy) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pos = toCanvasPos(e);
    const gid = ++gestureSeq.current;
    drawing.current = { id: gid, startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y };
    addDab(pos.x, pos.y, gid);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const cur = drawing.current;
    if (!cur) return;
    const pos = toCanvasPos(e);
    // 按间距采样 dab(涂抹连续);间距 = 半径 × DAB_SPACING_RATIO
    if (Math.hypot(pos.x - cur.lastX, pos.y - cur.lastY) >= radius * DAB_SPACING_RATIO) {
      cur.lastX = pos.x;
      cur.lastY = pos.y;
      addDab(pos.x, pos.y, cur.id);
    }
  }

  function finishGesture(e: React.PointerEvent<HTMLCanvasElement>) {
    const cur = drawing.current;
    if (!cur) return;
    drawing.current = null;
    const pos = toCanvasPos(e);
    // 拖拽方向 = 手势起点 → 终点(短于阈值 = 只标区域不定向);整手势 dab 统一赋值
    const [dx, dy] = dragDirection(cur.startX, cur.startY, pos.x, pos.y);
    if (Math.hypot(dx, dy) < 1e-6) return;
    const gid = cur.id;
    setDabs((prev) => prev.map((d) => (d.gesture === gid ? { ...d, dx, dy } : d)));
  }

  async function onSubmit() {
    if (!sourceRef || !motionBrushSubmittable({ dabs: dabs.length, busy })) return;
    setBusy(true);
    setError(null);
    try {
      const r = await submitMotionBrushMask({
        sourceImage: sourceRef.filename,
        worker: sourceRef.worker,
        dabs,
        width: maskWidth,
        height: maskHeight,
      });
      toast.success(`动效 mask 已生成(${r.strokes} 个标记点)`);
      onApply(r.mask);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "mask 生成失败");
    } finally {
      setBusy(false);
    }
  }

  const gestures = groupByGesture(dabs);
  const capped = dabs.length >= BRUSH_MAX_STROKES;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Motion Brush 局部动效"
      width={720}
      preventClose={busy}
      footer={
        <>
          <span className="mb-foot-hint">
            {dabs.length > 0
              ? `${gestures.length} 笔 · ${dabs.length}/${BRUSH_MAX_STROKES} 标记点`
              : "在画面上涂抹要动的区域,拖拽方向即运动方向"}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!sourceRef || !motionBrushSubmittable({ dabs: dabs.length, busy })}
            onClick={() => void onSubmit()}
          >
            生成 mask
          </Button>
        </>
      }
    >
      <div className="mb-toolbar">
        <label className="mb-field">
          <span className="mb-field-label">画笔 {radius}px</span>
          <input
            type="range"
            min={BRUSH_MIN_RADIUS}
            max={BRUSH_MAX_RADIUS}
            step={1}
            value={radius}
            disabled={busy}
            aria-label="画笔大小"
            onChange={(e) => setRadius(clampRadius(Number(e.target.value)))}
          />
        </label>
        <label className="mb-field">
          <span className="mb-field-label">强度 {Math.round(strength * 100)}%</span>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={strength}
            disabled={busy}
            aria-label="运动强度"
            onChange={(e) => setStrength(Number(e.target.value))}
          />
        </label>
        <div className="mb-actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="undo" size={13} />}
            disabled={busy || dabs.length === 0}
            onClick={() => setDabs((prev) => undoLastGesture(prev))}
          >
            撤销
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="delete" size={13} />}
            disabled={busy || dabs.length === 0}
            onClick={() => setDabs([])}
          >
            清空
          </Button>
        </div>
      </div>
      <div className="mb-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="mb-canvas"
          width={maskWidth}
          height={maskHeight}
          aria-label="Motion Brush 涂抹画布"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
        />
      </div>
      {capped && <p className="mb-hint mb-hint-warn">已达标记点上限,请撤销部分笔画后再涂抹</p>}
      {error ? <p className="mb-hint mb-hint-err">{error}</p> : (
        <p className="mb-hint">
          红色 = 运动区域,其余保持静止;箭头 = 运动方向(不拖拽则引擎自由演绎)。
          mask 尺寸 {maskWidth}×{maskHeight}(跟随当前引擎宽高)。
        </p>
      )}
      <style jsx>{`
        .mb-toolbar {
          display: flex;
          align-items: flex-end;
          gap: var(--space-4);
          flex-wrap: wrap;
          margin-bottom: var(--space-3);
        }
        .mb-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          flex: 1;
          min-width: 140px;
        }
        .mb-field-label {
          font-size: 11px;
          color: var(--text-muted);
        }
        .mb-actions {
          display: flex;
          gap: var(--space-2);
        }
        .mb-canvas-wrap {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          overflow: hidden;
          background: #101014;
          line-height: 0;
        }
        .mb-canvas {
          width: 100%;
          height: auto;
          display: block;
          cursor: crosshair;
          touch-action: none;
        }
        .mb-hint {
          margin: var(--space-2) 0 0;
          font-size: 11px;
          color: var(--text-muted);
          line-height: 1.5;
        }
        .mb-hint-warn {
          color: var(--warn, #e0a030);
        }
        .mb-hint-err {
          color: var(--err);
        }
        .mb-foot-hint {
          margin-right: auto;
          font-size: 11px;
          color: var(--text-muted);
          align-self: center;
        }
      `}</style>
    </Modal>
  );
}

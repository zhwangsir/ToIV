"use client";

/**
 * 局部重绘遮罩涂抹器(2026-09-27):市场局部重绘卡的图槽里直接涂要重绘的区域。
 *
 * 两层画布同尺寸叠放:底层画原图,上层是遮罩(用强调色显示,半透明)。
 * 画笔 = source-over 涂遮罩,橡皮 = destination-out 擦遮罩。
 * 确认时把遮罩覆盖度写进原图 alpha(透明 = 重绘区,ComfyUI LoadImage MASK = 1 - alpha),
 * 导出 PNG 交给调用方上传。原图已带透明度时,透明部分直接成为初始遮罩,可继续修改。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import {
  MASK_UNDO_LIMIT,
  brushDiameterPx,
  composeMaskedPixels,
  maskCoverage,
  maskFromAlpha,
  maskedFileName,
} from "@/lib/inpaintMask";

/** 画布上限:长边超过则等比缩小(4K 以内保持原尺寸)。 */
const MAX_SIDE = 4096;
const SIZE_MIN = 1;
const SIZE_MAX = 25;

type Tool = "brush" | "eraser";

interface InpaintMaskPainterProps {
  open: boolean;
  onClose: () => void;
  /** 原图 URL(blob: 或 /api 图片地址;跨域图需服务端带 CORS 头)。 */
  sourceUrl: string;
  sourceName: string;
  /** 上次涂好的遮罩图(其 alpha 作为初始遮罩;RGB 仍取原图,避免透明区颜色丢失)。 */
  maskUrl?: string | null;
  /** 确认:交出合成好的 PNG(调用方负责上传与回填表单)。 */
  onApply: (file: File) => Promise<void>;
}

/** 读主题强调色(遮罩显示色;取不到时用中性白)。 */
function accentRgb(): [number, number, number] {
  if (typeof window === "undefined") return [255, 255, 255];
  const probe = document.createElement("span");
  probe.style.color = "var(--accent)";
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const m = c.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 255, 255];
}

export function InpaintMaskPainter({ open, onClose, sourceUrl, sourceName, maskUrl, onApply }: InpaintMaskPainterProps) {
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const maskImgRef = useRef<HTMLImageElement | null>(null);
  const undoRef = useRef<ImageData[]>([]);
  const redoRef = useRef<ImageData[]>([]);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const colorRef = useRef<[number, number, number]>([255, 255, 255]);

  const [ready, setReady] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const [tool, setTool] = useState<Tool>("brush");
  const [sizePct, setSizePct] = useState(5);
  const [showMask, setShowMask] = useState(true);
  const [coverage, setCoverage] = useState(0);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const [ring, setRing] = useState<{ x: number; y: number; d: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diameter = brushDiameterPx(Math.max(dims.w, dims.h), sizePct);

  const refreshStats = useCallback(() => {
    const m = maskRef.current;
    const ctx = m?.getContext("2d");
    if (!m || !ctx) return;
    setCoverage(maskCoverage(ctx.getImageData(0, 0, m.width, m.height).data));
    setHistory({ undo: undoRef.current.length, redo: redoRef.current.length });
  }, []);

  // 打开即加载原图,初始化两层画布
  useEffect(() => {
    if (!open || !sourceUrl) return;
    setReady(false);
    setError(null);
    setBusy(false);
    undoRef.current = [];
    redoRef.current = [];
    colorRef.current = accentRgb();
    maskImgRef.current = null;
    const img = new Image();
    if (!sourceUrl.startsWith("blob:") && !sourceUrl.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      setDims({ w, h });
      requestAnimationFrame(() => {
        const base = baseRef.current;
        const mask = maskRef.current;
        const bctx = base?.getContext("2d");
        const mctx = mask?.getContext("2d");
        if (!base || !mask || !bctx || !mctx) return;
        base.width = mask.width = w;
        base.height = mask.height = h;
        bctx.drawImage(img, 0, 0, w, h);
        const seed = maskImgRef.current;
        try {
          // 初始遮罩:上次的遮罩图优先,否则取原图自带透明区
          let alphaSrc = bctx.getImageData(0, 0, w, h).data;
          if (seed) {
            const tmp = document.createElement("canvas");
            tmp.width = w;
            tmp.height = h;
            const tctx = tmp.getContext("2d");
            if (tctx) {
              tctx.drawImage(seed, 0, 0, w, h);
              alphaSrc = tctx.getImageData(0, 0, w, h).data;
            }
          }
          const init = maskFromAlpha(alphaSrc);
          const [r, g, b] = colorRef.current;
          for (let i = 0; i < init.length; i += 4) {
            init[i] = r;
            init[i + 1] = g;
            init[i + 2] = b;
          }
          mctx.putImageData(new ImageData(init, w, h), 0, 0);
        } catch {
          setError("这张图来自外部地址，浏览器不允许直接涂抹。请先下载到本地，再点“上传参考图”后涂抹。");
        }
        setReady(true);
        refreshStats();
      });
    };
    img.onerror = () => setError("原图加载失败，请重新上传后再涂抹。");
    if (maskUrl) {
      const seed = new Image();
      seed.onload = () => {
        maskImgRef.current = seed;
        img.src = sourceUrl;
      };
      seed.onerror = () => {
        img.src = sourceUrl;
      };
      seed.src = maskUrl;
    } else {
      img.src = sourceUrl;
    }
    return () => {
      imgRef.current = null;
    };
  }, [open, sourceUrl, maskUrl, refreshStats]);

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const m = maskRef.current!;
    const rect = m.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * m.width,
      y: ((clientY - rect.top) / rect.height) * m.height,
      scale: rect.width / m.width,
      left: clientX - rect.left,
      top: clientY - rect.top,
    };
  }, []);

  function strokeTo(x: number, y: number) {
    const ctx = maskRef.current?.getContext("2d");
    if (!ctx) return;
    const [r, g, b] = colorRef.current;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = diameter;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const last = lastRef.current;
    if (!last) {
      ctx.beginPath();
      ctx.arc(x, y, diameter / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    lastRef.current = { x, y };
  }

  function snapshot() {
    const m = maskRef.current;
    const ctx = m?.getContext("2d");
    if (!m || !ctx) return;
    undoRef.current.push(ctx.getImageData(0, 0, m.width, m.height));
    if (undoRef.current.length > MASK_UNDO_LIMIT) undoRef.current.shift();
    redoRef.current = [];
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 || busy || !ready || error) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    snapshot();
    lastRef.current = null;
    const p = toCanvas(e.clientX, e.clientY);
    strokeTo(p.x, p.y);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = toCanvas(e.clientX, e.clientY);
    setRing({ x: p.left, y: p.top, d: diameter * p.scale });
    if (!lastRef.current) return;
    const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
    if (events.length > 1) {
      for (const ev of events) {
        const q = toCanvas(ev.clientX, ev.clientY);
        strokeTo(q.x, q.y);
      }
    } else {
      strokeTo(p.x, p.y);
    }
  }

  function endStroke() {
    if (!lastRef.current) return;
    lastRef.current = null;
    refreshStats();
  }

  const restore = useCallback(
    (from: ImageData[], to: ImageData[]) => {
      const m = maskRef.current;
      const ctx = m?.getContext("2d");
      const prev = from.pop();
      if (!m || !ctx || !prev) return;
      to.push(ctx.getImageData(0, 0, m.width, m.height));
      ctx.globalCompositeOperation = "source-over";
      ctx.putImageData(prev, 0, 0);
      refreshStats();
    },
    [refreshStats],
  );
  const undo = useCallback(() => restore(undoRef.current, redoRef.current), [restore]);
  const redo = useCallback(() => restore(redoRef.current, undoRef.current), [restore]);

  function clearMask() {
    const m = maskRef.current;
    const ctx = m?.getContext("2d");
    if (!m || !ctx) return;
    snapshot();
    ctx.clearRect(0, 0, m.width, m.height);
    refreshStats();
  }

  // 快捷键:B 画笔 / E 橡皮 / [ ] 调大小 / ⌘Z 撤销 / ⇧⌘Z 重做
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (!mod && e.key.toLowerCase() === "b") setTool("brush");
      else if (!mod && e.key.toLowerCase() === "e") setTool("eraser");
      else if (e.key === "[") setSizePct((s) => Math.max(SIZE_MIN, s - 1));
      else if (e.key === "]") setSizePct((s) => Math.min(SIZE_MAX, s + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, undo, redo]);

  async function apply() {
    const img = imgRef.current;
    const m = maskRef.current;
    const mctx = m?.getContext("2d");
    if (!img || !m || !mctx || coverage === 0) return;
    setBusy(true);
    setError(null);
    try {
      const out = document.createElement("canvas");
      out.width = m.width;
      out.height = m.height;
      const octx = out.getContext("2d");
      if (!octx) throw new Error("浏览器不支持画布导出");
      octx.drawImage(img, 0, 0, m.width, m.height);
      const src = octx.getImageData(0, 0, m.width, m.height);
      const px = composeMaskedPixels(src.data, mctx.getImageData(0, 0, m.width, m.height).data);
      octx.putImageData(new ImageData(px, m.width, m.height), 0, 0);
      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
      if (!blob) throw new Error("导出 PNG 失败");
      await onApply(new File([blob], maskedFileName(sourceName), { type: "image/png" }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "遮罩保存失败");
    } finally {
      setBusy(false);
    }
  }

  const pct = Math.round(coverage * 1000) / 10;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="涂抹重绘区域"
      width={860}
      preventClose={busy}
      footer={
        <>
          <span className="imp-foot-hint">
            {coverage > 0 ? `已涂抹 ${pct < 0.1 ? "<0.1" : pct}% 的画面` : "在图上涂出要重绘的地方"}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready || coverage === 0 || Boolean(error)} onClick={() => void apply()}>
            使用这个遮罩
          </Button>
        </>
      }
    >
      <div className="imp-toolbar" role="toolbar" aria-label="遮罩工具">
        <div className="imp-seg">
          <button type="button" className="imp-seg-btn" aria-pressed={tool === "brush"} onClick={() => setTool("brush")} title="画笔 (B)">
            <Icon name="brush" size={14} />
            画笔
          </button>
          <button type="button" className="imp-seg-btn" aria-pressed={tool === "eraser"} onClick={() => setTool("eraser")} title="橡皮 (E)">
            <Icon name="eraser" size={14} />
            橡皮
          </button>
        </div>
        <label className="imp-size">
          <span className="imp-size-label">大小</span>
          <input
            type="range"
            min={SIZE_MIN}
            max={SIZE_MAX}
            step={1}
            value={sizePct}
            aria-label="笔刷大小"
            onChange={(e) => setSizePct(Number(e.target.value))}
          />
          <span className="imp-size-dot" style={{ width: 6 + sizePct, height: 6 + sizePct }} aria-hidden />
        </label>
        <div className="imp-actions">
          <Button variant="ghost" size="sm" icon={<Icon name="undo" size={13} />} disabled={busy || history.undo === 0} onClick={undo} aria-label="撤销" title="撤销 (⌘Z)" />
          <Button variant="ghost" size="sm" icon={<Icon name="redo" size={13} />} disabled={busy || history.redo === 0} onClick={redo} aria-label="重做" title="重做 (⇧⌘Z)" />
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="eye" size={13} />}
            aria-pressed={!showMask}
            onClick={() => setShowMask((v) => !v)}
            title="切换查看原图 / 遮罩"
          >
            {showMask ? "看原图" : "看遮罩"}
          </Button>
          <Button variant="ghost" size="sm" icon={<Icon name="delete" size={13} />} disabled={busy || coverage === 0} onClick={clearMask}>
            清空
          </Button>
        </div>
      </div>
      <div className="imp-stage">
        <div
          ref={wrapRef}
          className="imp-canvas-wrap"
          style={{
            aspectRatio: `${dims.w} / ${dims.h}`,
            width: `min(100%, calc((62vh - 2 * var(--space-3)) * ${(dims.w / dims.h).toFixed(4)}))`,
          }}
          data-ready={ready ? "1" : undefined}
        >
          <canvas ref={baseRef} className="imp-canvas imp-base" aria-hidden />
          <canvas
            ref={maskRef}
            className="imp-canvas imp-mask"
            data-hidden={showMask ? undefined : "1"}
            data-tool={tool}
            aria-label="遮罩涂抹画布"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={() => setRing(null)}
          />
          {ring && ready && (
            <span
              className="imp-ring"
              data-tool={tool}
              style={{ left: ring.x, top: ring.y, width: ring.d, height: ring.d }}
              aria-hidden
            />
          )}
          {!ready && !error && <span className="imp-loading">载入原图…</span>}
        </div>
      </div>
      {error ? (
        <p className="imp-hint imp-hint-err">{error}</p>
      ) : (
        <p className="imp-hint">
          涂上颜色的地方会被重新生成，其余保持不变。快捷键：B 画笔、E 橡皮、[ ] 调大小、⌘Z 撤销。
        </p>
      )}
      <style jsx>{`
        .imp-toolbar {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          flex-wrap: wrap;
          margin-bottom: var(--space-3);
        }
        .imp-seg {
          display: inline-flex;
          padding: 2px;
          gap: 2px;
          border-radius: var(--radius-control);
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
        }
        .imp-seg-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 28px;
          padding: 0 var(--space-3);
          border: 0;
          border-radius: calc(var(--radius-control) - 2px);
          background: transparent;
          color: var(--text-secondary);
          font-size: var(--text-aux);
          cursor: pointer;
          transition: background var(--duration-instant, 120ms) var(--ease-out-strong, ease-out),
            color var(--duration-instant, 120ms) var(--ease-out-strong, ease-out);
        }
        .imp-seg-btn:hover {
          color: var(--text-primary);
        }
        .imp-seg-btn[aria-pressed="true"] {
          background: var(--bg-surface-1);
          color: var(--text-primary);
          box-shadow: 0 0 0 1px var(--border-strong, var(--border-subtle));
        }
        .imp-seg-btn:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
        .imp-size {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          flex: 1;
          min-width: 180px;
        }
        .imp-size input {
          flex: 1;
          accent-color: var(--accent);
        }
        .imp-size-label {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .imp-size-dot {
          display: inline-block;
          border-radius: 50%;
          background: var(--text-secondary);
          flex-shrink: 0;
        }
        .imp-actions {
          display: inline-flex;
          gap: var(--space-1, 4px);
          margin-left: auto;
        }
        .imp-stage {
          display: flex;
          justify-content: center;
          align-items: center;
          max-height: 62vh;
          padding: var(--space-3);
          border-radius: var(--radius-control);
          border: 1px solid var(--border-subtle);
          background-color: var(--overlay-stage);
          overflow: hidden;
        }
        .imp-canvas-wrap {
          position: relative;
          line-height: 0;
          opacity: 0;
          transition: opacity 180ms var(--ease-out-strong, ease-out);
        }
        .imp-canvas-wrap[data-ready] {
          opacity: 1;
        }
        .imp-canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }
        .imp-mask {
          opacity: 0.55;
          cursor: none;
          touch-action: none;
          transition: opacity var(--duration-instant, 120ms) linear;
        }
        .imp-mask[data-hidden] {
          opacity: 0;
        }
        .imp-ring {
          position: absolute;
          transform: translate(-50%, -50%);
          border-radius: 50%;
          border: 1.5px solid var(--text-on-media, white);
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
          pointer-events: none;
        }
        .imp-ring[data-tool="eraser"] {
          border-style: dashed;
        }
        .imp-loading {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.4;
        }
        .imp-hint {
          margin: var(--space-2) 0 0;
          font-size: 11px;
          color: var(--text-muted);
          line-height: 1.5;
        }
        .imp-hint-err {
          color: var(--err);
        }
        .imp-foot-hint {
          margin-right: auto;
          font-size: 11px;
          color: var(--text-muted);
          align-self: center;
          font-variant-numeric: tabular-nums;
        }
        @media (prefers-reduced-motion: reduce) {
          .imp-canvas-wrap,
          .imp-seg-btn,
          .imp-mask {
            transition: none;
          }
        }
      `}</style>
    </Modal>
  );
}

"use client";

import { useCallback, useId, useRef, useState } from "react";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 受控回调:返回吸附到 step 后的新值。 */
  onChange: (v: number) => void;
  /** 数值格式化(气泡/右侧读数),默认按 step 推断小数位。 */
  format?: (v: number) => string;
  /** 数值右侧单位后缀,如 "帧" "步"。 */
  suffix?: string;
  disabled?: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 把任意值吸附到 step 网格并夹紧到 [min,max]。 */
function snap(v: number, min: number, max: number, step: number): number {
  const snapped = Math.round((v - min) / step) * step + min;
  // 消除浮点误差(step=0.05 等)
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(clamp(snapped, min, max).toFixed(decimals));
}

function defaultFormat(step: number): (v: number) => string {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return (v: number) => (decimals ? v.toFixed(decimals) : String(v));
}

/**
 * 精致可拖动滑块:track + 暖金 fill + 圆润 thumb + 实时数值气泡。
 * - 受控:value/onChange,内部不持有数值真相。
 * - 跟手:基于轨道几何换算,Pointer Events 捕获,拖出轨道也连续跟随。
 * - 性能:fill/thumb 用 left 百分比(布局廉价的轨道内定位),气泡/thumb 缩放走 transform。
 * - 无障碍:role=slider + 方向键/Home/End/PageUp·Down,reduced-motion 由 CSS 降级。
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  suffix,
  disabled = false,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [dragging, setDragging] = useState(false);

  const fmt = format ?? defaultFormat(step);
  const pct = max > min ? ((clamp(value, min, max) - min) / (max - min)) * 100 : 0;

  const valueFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return value;
      const rect = el.getBoundingClientRect();
      const ratio = rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
      return snap(min + ratio * (max - min), min, max, step);
    },
    [value, min, max, step],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);
      onChange(valueFromClientX(e.clientX));
    },
    [disabled, valueFromClientX, onChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || disabled) return;
      onChange(valueFromClientX(e.clientX));
    },
    [dragging, disabled, valueFromClientX, onChange],
  );

  const endDrag = useCallback(() => setDragging(false), []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const big = Math.max(step, (max - min) / 10);
      let next = value;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowUp":
          next = value + step;
          break;
        case "ArrowLeft":
        case "ArrowDown":
          next = value - step;
          break;
        case "PageUp":
          next = value + big;
          break;
        case "PageDown":
          next = value - big;
          break;
        case "Home":
          next = min;
          break;
        case "End":
          next = max;
          break;
        default:
          return;
      }
      e.preventDefault();
      onChange(snap(next, min, max, step));
    },
    [disabled, value, min, max, step, onChange],
  );

  const readout = `${fmt(value)}${suffix ? ` ${suffix}` : ""}`;

  return (
    <div className={`field slider-field${disabled ? " is-disabled" : ""}`}>
      <label htmlFor={id} id={`${id}-label`}>
        {label}
        <span className="hint slider-readout">{readout}</span>
      </label>
      <div
        ref={trackRef}
        className={`slider-track${dragging ? " is-dragging" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="slider-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
        <div className="slider-thumb" style={{ left: `${pct}%` }} aria-hidden="true">
          <span className="slider-bubble">{readout}</span>
        </div>
        <div
          id={id}
          className="slider-handle-hit"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-labelledby={`${id}-label`}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={readout}
          aria-disabled={disabled || undefined}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}

"use client";

import { useCallback, useId, useRef, useState } from "react";

import "./range-slider.css";

export interface RangeValue {
  /** 下界(<= high)。 */
  low: number;
  /** 上界(>= low)。 */
  high: number;
}

interface RangeSliderProps {
  label: string;
  value: RangeValue;
  min: number;
  max: number;
  step?: number;
  /** 受控回调:返回吸附到 step、且 low<=high 的新区间。 */
  onChange: (v: RangeValue) => void;
  /** 数值格式化(气泡/读数),默认按 step 推断小数位。 */
  format?: (v: number) => string;
  /** 数值单位后缀,如 "步" "px"。 */
  suffix?: string;
  disabled?: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 把任意值吸附到 step 网格并夹紧到 [min,max]。 */
function snap(v: number, min: number, max: number, step: number): number {
  const snapped = Math.round((v - min) / step) * step + min;
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(clamp(snapped, min, max).toFixed(decimals));
}

function defaultFormat(step: number): (v: number) => string {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return (v: number) => (decimals ? v.toFixed(decimals) : String(v));
}

type Thumb = "low" | "high";

/**
 * 双拇指范围滑块:沿用单 Slider 的视觉语言与交互手感。
 * - 受控:value{low,high}/onChange,内部不持有数值真相;始终保证 low<=high。
 * - 跟手:基于轨道几何换算,Pointer Events 捕获;点轨道选最近的拇指开始拖。
 * - 无障碍:两个把手各自 role=slider + 方向键/Home/End/PageUp·Down,各自数值气泡。
 * - 性能:fill/thumb 用百分比定位(轨道内布局廉价),气泡/缩放走 transform;reduced-motion 由 CSS 降级。
 */
export function RangeSlider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  suffix,
  disabled = false,
}: RangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [grabbed, setGrabbed] = useState<Thumb | null>(null);

  const fmt = format ?? defaultFormat(step);
  const span = max > min ? max - min : 1;
  const lowPct = ((clamp(value.low, min, max) - min) / span) * 100;
  const highPct = ((clamp(value.high, min, max) - min) / span) * 100;

  const valueFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return min;
      const rect = el.getBoundingClientRect();
      const ratio = rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
      return snap(min + ratio * span, min, max, step);
    },
    [min, max, step, span],
  );

  // 不可变更新:写入一个拇指,夹紧使 low<=high
  const setThumb = useCallback(
    (thumb: Thumb, raw: number) => {
      const v = snap(raw, min, max, step);
      if (thumb === "low") {
        onChange({ low: Math.min(v, value.high), high: value.high });
      } else {
        onChange({ low: value.low, high: Math.max(v, value.low) });
      }
    },
    [min, max, step, value.low, value.high, onChange],
  );

  // 点轨道:挑离落点更近的拇指开始拖
  const nearestThumb = useCallback(
    (raw: number): Thumb => {
      const dLow = Math.abs(raw - value.low);
      const dHigh = Math.abs(raw - value.high);
      if (dLow === dHigh) return raw < value.low ? "low" : "high";
      return dLow < dHigh ? "low" : "high";
    },
    [value.low, value.high],
  );

  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      const raw = valueFromClientX(e.clientX);
      const thumb = nearestThumb(raw);
      setGrabbed(thumb);
      setThumb(thumb, raw);
    },
    [disabled, valueFromClientX, nearestThumb, setThumb],
  );

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, thumb: Thumb) => {
      if (disabled) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setGrabbed(thumb);
    },
    [disabled],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!grabbed || disabled) return;
      setThumb(grabbed, valueFromClientX(e.clientX));
    },
    [grabbed, disabled, valueFromClientX, setThumb],
  );

  const endDrag = useCallback(() => setGrabbed(null), []);

  const onHandleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, thumb: Thumb) => {
      if (disabled) return;
      const big = Math.max(step, span / 10);
      const cur = thumb === "low" ? value.low : value.high;
      let next = cur;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowUp":
          next = cur + step;
          break;
        case "ArrowLeft":
        case "ArrowDown":
          next = cur - step;
          break;
        case "PageUp":
          next = cur + big;
          break;
        case "PageDown":
          next = cur - big;
          break;
        case "Home":
          next = thumb === "low" ? min : value.low;
          break;
        case "End":
          next = thumb === "high" ? max : value.high;
          break;
        default:
          return;
      }
      e.preventDefault();
      setThumb(thumb, next);
    },
    [disabled, step, span, value.low, value.high, min, max, setThumb],
  );

  const sfx = suffix ? ` ${suffix}` : "";
  const lowRead = `${fmt(value.low)}${sfx}`;
  const highRead = `${fmt(value.high)}${sfx}`;
  const readout = `${fmt(value.low)} – ${fmt(value.high)}${sfx}`;

  const handleProps = (thumb: Thumb, pct: number, read: string, val: number, ariaMin: number, ariaMax: number) => (
    <>
      <button
        type="button"
        className={`range-handle${grabbed === thumb ? " is-grabbed" : ""}`}
        style={{ left: `${pct}%` }}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label} · ${thumb === "low" ? "下界" : "上界"}`}
        aria-valuemin={ariaMin}
        aria-valuemax={ariaMax}
        aria-valuenow={val}
        aria-valuetext={read}
        aria-disabled={disabled || undefined}
        onPointerDown={(e) => onHandlePointerDown(e, thumb)}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => onHandleKeyDown(e, thumb)}
      />
      <div className="slider-thumb" style={{ left: `${pct}%` }} aria-hidden="true">
        <span className="slider-bubble">{read}</span>
      </div>
    </>
  );

  return (
    <div className={`field slider-field range-field${disabled ? " is-disabled" : ""}`}>
      <label id={`${id}-label`}>
        {label}
        <span className="hint slider-readout range-readout">{readout}</span>
      </label>
      <div
        ref={trackRef}
        className={`slider-track${grabbed ? " is-dragging" : ""}`}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="slider-fill"
          style={
            {
              ["--range-left" as string]: `${lowPct}%`,
              ["--range-width" as string]: `${Math.max(0, highPct - lowPct)}%`,
            } as React.CSSProperties
          }
          aria-hidden="true"
        />
        {handleProps("low", lowPct, lowRead, value.low, min, value.high)}
        {handleProps("high", highPct, highRead, value.high, value.low, max)}
      </div>
    </div>
  );
}

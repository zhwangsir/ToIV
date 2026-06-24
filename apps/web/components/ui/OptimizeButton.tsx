"use client";

import { useState } from "react";

import { optimizePrompt } from "@/lib/api";

interface OptimizeButtonProps {
  /** 当前提示词文本 */
  value: string;
  /** 优化的功能类型:image / image_edit / video / audio / threed */
  kind: string;
  /** 拿到优化结果后回填正向提示词 */
  onResult: (optimized: string) => void;
  /** 图像类:同时回填负面提示词(可选) */
  onNegative?: (negative: string) => void;
  disabled?: boolean;
}

/** 一键把简单输入扩写成该功能的专业提示词(由 LLM 完成);图像类同时优化正向+负面。 */
export function OptimizeButton({ value, kind, onResult, onNegative, disabled }: OptimizeButtonProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await optimizePrompt(text, kind);
      onResult(res.optimized);
      if (res.negative && onNegative) onNegative(res.negative);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="optimize-btn"
      onClick={run}
      disabled={disabled || busy || !value.trim()}
      title={err ?? "用 AI 把提示词扩写得更专业"}
    >
      {busy ? (
        "优化中…"
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.34rem" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l1.7 5.5L19.2 9l-5.5 1.5L12 16l-1.7-5.5L4.8 9l5.5-1.5z" />
          </svg>
          优化提示词
        </span>
      )}
    </button>
  );
}

"use client";

import { useState } from "react";

import { optimizePrompt } from "@/lib/api";

interface OptimizeButtonProps {
  /** 当前提示词文本 */
  value: string;
  /** 优化的功能类型:image / image_edit / video / audio / threed */
  kind: string;
  /** 拿到优化结果后回填 */
  onResult: (optimized: string) => void;
  disabled?: boolean;
}

/** 一键把简单输入扩写成该功能的专业提示词(由 LLM 完成)。 */
export function OptimizeButton({ value, kind, onResult, disabled }: OptimizeButtonProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(null);
    try {
      onResult(await optimizePrompt(text, kind));
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
      {busy ? "优化中…" : "✨ 优化提示词"}
    </button>
  );
}

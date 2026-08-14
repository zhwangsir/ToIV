"use client";

import { useRef, useState } from "react";

import { reversePrompt } from "@/lib/api";
import { friendlyError } from "@/lib/friendlyError";

import { Icon } from "./Icon";
import { useToast } from "./Toast";

interface ReverseButtonProps {
  /** 反推成功回调:与 OptimizeButton 的 onOptimized 同签名,
   *  直接复用 GenerateView 的回填 + 负向自动填入机制。 */
  onOptimized: (text: string, negative?: string) => void;
  disabled?: boolean;
  label?: string;
}

/** 反推接受的文件类型(与后端 _EXT_KIND 对齐):图片/视频/音频。 */
const ACCEPT = "image/*,video/*,audio/*";

/**
 * 「反推提示词」按钮:选图/视频/音频 → POST /api/reverse →
 * VLM(Qwen3-VL,视觉)或 SenseVoice(音频)反推出提示词 → onOptimized 回填。
 * 与 OptimizeButton 并排在 PromptBar 内,样式对齐(ob-btn 语言)。
 */
export function ReverseButton({
  onOptimized,
  disabled = false,
  label = "反推",
}: ReverseButtonProps) {
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();

  const isDisabled = disabled || loading;

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setLoading(true);
    try {
      const r = await reversePrompt(file);
      onOptimized(r.prompt, r.negative ?? undefined);
      toast.success(
        r.kind === "audio"
          ? "已反推音频内容并填入提示词"
          : "已反推画面内容并填入提示词",
      );
    } catch (e) {
      const fe = friendlyError(e instanceof Error ? e.message : String(e));
      toast.error(fe.message || "反推失败,请重试");
    } finally {
      setLoading(false);
      // 允许连续选同一文件触发 change
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="rb-root">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      <button
        type="button"
        className={`rb-btn${loading ? " is-loading" : ""}`}
        onClick={() => inputRef.current?.click()}
        disabled={isDisabled}
        title="上传图片/视频/音频,反推出提示词"
      >
        {loading ? (
          <span className="loading-spinner">
            <Icon name="loading" size={13} />
          </span>
        ) : (
          <Icon name="wand" size={13} />
        )}
        {loading ? "反推中…" : label}
      </button>

      <style jsx>{`
        .rb-root {
          position: relative;
          display: inline-flex;
        }
        .rb-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          height: 26px;
          padding: 0 var(--space-3);
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-control);
          color: var(--accent);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .rb-btn:hover:not(:disabled) {
          background: var(--accent-soft);
          border-color: var(--accent-glow);
        }
        .rb-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .rb-btn.is-loading {
          color: var(--text-muted);
          cursor: progress;
        }
      `}</style>
    </div>
  );
}

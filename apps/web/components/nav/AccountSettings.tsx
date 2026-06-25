"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useNsfw } from "./NsfwContext";

/**
 * 账户设置 popover —— 从灵动岛账户区一颗齿轮按钮点开。
 * 内含「成人内容 (R18)」软开关(沿用 .switch pill 样式)+ 一句说明 + 切换反馈。
 * Studio Noir 风,键盘可达(Esc 关闭、外点关闭、焦点环)。
 */
export function AccountSettings() {
  const { enabled, setEnabled, loading } = useNsfw();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 切换后的轻量 toast 文案(aria-live 朗读);自动消隐。
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const switchId = useId();

  // 外点 / Esc 关闭(键盘可达)。
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // toast 自动消隐。
  useEffect(() => {
    if (!feedback) return undefined;
    const id = window.setTimeout(() => setFeedback(null), 2600);
    return () => window.clearTimeout(id);
  }, [feedback]);

  const toggleR18 = useCallback(async () => {
    if (busy) return;
    const next = !enabled;
    setBusy(true);
    try {
      const confirmed = await setEnabled(next);
      setFeedback({
        kind: "ok",
        text: confirmed ? "已开启成人内容 (R18)" : "已关闭成人内容 (R18)",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "保存设置失败";
      setFeedback({ kind: "err", text: msg });
    } finally {
      setBusy(false);
    }
  }, [busy, enabled, setEnabled]);

  return (
    <div className="island-settings" ref={rootRef}>
      <button
        type="button"
        className="logout island-settings-btn"
        aria-label="账户设置"
        title="账户设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div
          id={panelId}
          className="settings-pop"
          role="dialog"
          aria-label="账户设置"
          aria-modal="false"
        >
          <div className="settings-pop-head">
            <h2>账户设置</h2>
          </div>

          <div className={`settings-r18${enabled ? " is-on" : ""}`}>
            <div className="switch-row">
              <label className="switch-label" htmlFor={switchId}>
                成人内容 (R18)
                {enabled && <span className="nsfw-badge">18+</span>}
                <span className="switch-sub">开启后显示成人向模型与作品 (R18)</span>
              </label>
              <button
                id={switchId}
                type="button"
                className="switch"
                role="switch"
                aria-checked={enabled}
                aria-label="成人内容 (R18)"
                disabled={busy || loading}
                onClick={toggleR18}
              />
            </div>
            {enabled && (
              <p className="nsfw-note">
                请确认你已年满 18 周岁并遵守平台规范。关闭后将隐藏全部成人向内容。
              </p>
            )}
          </div>

          <p
            className={`settings-feedback${feedback ? " is-visible" : ""}${
              feedback?.kind === "err" ? " is-err" : ""
            }`}
            role="status"
            aria-live="polite"
          >
            {feedback?.text ?? ""}
          </p>
        </div>
      )}
    </div>
  );
}

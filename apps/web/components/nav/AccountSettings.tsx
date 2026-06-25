"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ThemeToggle } from "@/components/ui/ThemeToggle";

import { useNsfw } from "./NsfwContext";

interface AccountSettingsProps {
  /** 账户邮箱(菜单内展示)。 */
  account?: string;
  /** 退出回调。 */
  onLogout: () => void;
}

/**
 * 常驻账户菜单 —— 灵动岛里常显一颗账户按钮(不靠 hover),点击开浮层菜单。
 * 菜单 = 邮箱 + 成人内容 (R18) 软开关 + 主题切换 + 退出。
 *
 * 关键:菜单用 createPortal 渲染到 body,**不受灵动岛 hover 收起影响**
 * —— 修复「设置/R18 打不开」(原齿轮埋在岛 hover 展开区,hover 不稳点不到)。
 */
export function AccountSettings({ account, onLogout }: AccountSettingsProps) {
  const { enabled, setEnabled, loading } = useNsfw();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // portal 浮层按触发按钮位置定位(fixed)。
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const switchId = useId();

  // 打开时按触发按钮位置算浮层坐标(右对齐、下挂)。
  useEffect(() => {
    if (!open) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) {
      setPos({
        top: Math.round(r.bottom + 8),
        right: Math.round(Math.max(8, window.innerWidth - r.right)),
      });
    }
  }, [open]);

  // 外点 / Esc 关闭(检查触发按钮 + portal 浮层两处,避免点菜单内即关)。
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
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

  // 切换反馈自动消隐。
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
      setFeedback({ kind: "err", text: err instanceof Error ? err.message : "保存设置失败" });
    } finally {
      setBusy(false);
    }
  }, [busy, enabled, setEnabled]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`island-account-btn${open ? " is-open" : ""}`}
        aria-label="账户与设置"
        title="账户与设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      </button>

      {open && pos && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            id={panelId}
            className="account-menu"
            role="dialog"
            aria-label="账户与设置"
            style={{ position: "fixed", top: pos.top, right: pos.right }}
          >
            {account && (
              <div className="account-menu-email" title={account}>
                {account}
              </div>
            )}

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
            </div>

            <div className="account-menu-row">
              <span className="account-menu-row-label">主题</span>
              <ThemeToggle />
            </div>

            <button
              type="button"
              className="account-menu-logout"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
            >
              退出登录
            </button>

            <p
              className={`settings-feedback${feedback ? " is-visible" : ""}${
                feedback?.kind === "err" ? " is-err" : ""
              }`}
              role="status"
              aria-live="polite"
            >
              {feedback?.text ?? ""}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}

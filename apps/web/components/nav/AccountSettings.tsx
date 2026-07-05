"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ThemeToggle } from "@/components/ui/ThemeToggle";

interface AccountSettingsProps {
  /** 账户邮箱(菜单内展示)。 */
  account?: string;
  /** 退出回调。 */
  onLogout: () => void;
  /** 自定义触发按钮 className。 */
  className?: string;
}

/**
 * 常驻账户菜单 —— 灵动岛里常显一颗账户按钮(不靠 hover),点击开浮层菜单。
 * 菜单 = 邮箱 + 主题切换 + 退出。
 *
 * 注:成人内容 (R18) 不在主站出现任何入口 —— R18 内容与开关只在独立 /nsfw 专页,
 * 主站(toiv.dgmt.top)零 R18 痕迹(见 apps/api/app/nsfw_ctx.py)。
 *
 * 菜单用 createPortal 渲染到 body,不受灵动岛 hover 收起影响。
 */
export function AccountSettings({ account, onLogout, className }: AccountSettingsProps) {
  const [open, setOpen] = useState(false);
  // portal 浮层按触发按钮位置定位(fixed)。
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${className ?? "island-account-btn"}${open ? " is-open" : ""}`}
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
          </div>,
          document.body,
        )}
    </>
  );
}

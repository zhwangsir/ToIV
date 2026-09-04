"use client";
import { ReactNode, useRef, useEffect } from "react";
import { Icon } from "./Icon";
import { useFocusTrap } from "@/hooks/useFocusTrap";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** 危险态(确认删除等),标题区显示红色 */
  danger?: boolean;
  /** 关闭时是否阻止(如提交中) */
  preventClose?: boolean;
  /** 自定义宽度,默认 480px */
  width?: number;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  danger,
  preventClose,
  width = 480,
}: ModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open, preventClose ? undefined : onClose);

  // Esc 关闭
  useEffect(() => {
    if (!open || preventClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, preventClose, onClose]);

  // body 滚动锁
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !preventClose) onClose();
      }}
    >
      <div
        className="modal-card"
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth: width }}
      >
        <div className="modal-head">
          <h3 className={`modal-title ${danger ? "modal-title-danger" : ""}`}>
            {title}
          </h3>
          {!preventClose && (
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              aria-label="关闭"
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
      <style jsx>{`
        .modal-overlay {
          position: fixed;
          inset: 0;
          z-index: var(--z-modal);
          background: var(--overlay-light);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          /* 小屏留边:卡片不贴视口边缘 */
          padding: var(--space-4);
          animation: fadeIn var(--duration-base) var(--ease-standard);
        }
        .modal-card {
          width: 100%;
          /* 内容超出视口时头/脚固定,body 内部滚动 */
          max-height: 100%;
          display: flex;
          flex-direction: column;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          /* 2026-09-04 美化 W1:浮层统一 --shadow-pop + 弹簧入场(scale .98→1 + y 4px,≤320ms) */
          box-shadow: var(--shadow-pop);
          animation: slideUp var(--duration-slow) var(--ease-spring);
        }
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(4px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .modal-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--space-4) var(--space-5);
          border-bottom: 1px solid var(--border-subtle);
        }
        .modal-title {
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          margin: 0;
        }
        .modal-title-danger {
          color: var(--err);
        }
        .modal-close {
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          border-radius: var(--radius-control);
          color: var(--text-muted);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .modal-close:hover {
          background: var(--bg-surface-2);
          color: var(--text-primary);
        }
        .modal-body {
          padding: var(--space-5);
          overflow-y: auto;
        }
        .modal-foot {
          padding: var(--space-4) var(--space-5);
          border-top: 1px solid var(--border-subtle);
          display: flex;
          justify-content: flex-end;
          gap: var(--space-3);
          flex-wrap: wrap;
        }
        .modal-head,
        .modal-foot {
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}

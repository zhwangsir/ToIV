"use client";
import {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { Icon } from "./Icon";

type ToastType = "success" | "error" | "info";

/** 可操作 toast 的动作按钮(如删除后的「撤销」);带动作的 toast 停留更久。 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  action?: ToastAction;
}
interface ToastContextValue {
  show: (type: ToastType, message: string, action?: ToastAction) => void;
  success: (msg: string, action?: ToastAction) => void;
  error: (msg: string) => void;
  info: (msg: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 ToastProvider 内使用");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (type: ToastType, message: string, action?: ToastAction) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { id, type, message, action }]);
      // 带动作按钮(如「撤销」)的 toast 停留 60s,给足反应时间;普通 3.5s
      setTimeout(() => remove(id), action ? 60_000 : 3_500);
    },
    [remove],
  );

  const ctx: ToastContextValue = {
    show,
    success: (msg, action) => show("success", msg, action),
    error: (msg) => show("error", msg),
    info: (msg, action) => show("info", msg, action),
  };

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div
        className="toast-container"
        role="region"
        aria-label="通知"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.type}`}
            onClick={() => remove(t.id)}
          >
            <Icon
              name={
                t.type === "success"
                  ? "success"
                  : t.type === "error"
                    ? "error"
                    : "info"
              }
              size={16}
            />
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={(e) => {
                  e.stopPropagation();
                  t.action?.onClick();
                  remove(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="toast-close"
              onClick={(e) => {
                e.stopPropagation();
                remove(t.id);
              }}
              aria-label="关闭"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
      <style jsx>{`
        .toast-container {
          position: fixed;
          top: var(--space-4);
          right: var(--space-4);
          z-index: var(--z-toast);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          pointer-events: none;
        }
        .toast {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          border-radius: var(--radius-control);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          box-shadow: var(--shadow-float);
          color: var(--text-primary);
          font-size: var(--text-body);
          min-width: 280px;
          max-width: 400px;
          pointer-events: auto;
          cursor: pointer;
          animation: slideIn var(--duration-base) var(--ease-standard);
        }
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(20px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        .toast-success {
          border-left: 3px solid var(--ok);
        }
        .toast-error {
          border-left: 3px solid var(--err);
        }
        .toast-info {
          border-left: 3px solid var(--accent);
        }
        .toast-msg {
          flex: 1;
          min-width: 0;
          line-height: 1.5;
          word-break: break-word;
        }
        /* 可操作动作按钮(如删除后「撤销」):accent 描边轻按钮,hover 提亮 */
        .toast-action {
          flex-shrink: 0;
          padding: var(--space-1) var(--space-3);
          background: transparent;
          border: 1px solid var(--accent);
          color: var(--accent);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          border-radius: var(--radius-control);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .toast-action:hover {
          background: var(--accent);
          color: var(--bg-surface-1);
        }
        .toast-close {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          background: transparent;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          border-radius: var(--radius-badge);
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .toast-close:hover {
          color: var(--text-primary);
          background: var(--bg-surface-2);
        }
        /* 窄屏:通知横向拉满,避免 400px 上限溢出小视口 */
        @media (max-width: 767px) {
          .toast-container {
            left: var(--space-4);
          }
          .toast {
            min-width: 0;
            max-width: none;
            width: 100%;
          }
        }
      `}</style>
    </ToastContext.Provider>
  );
}

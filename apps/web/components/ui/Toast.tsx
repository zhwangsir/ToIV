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
interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}
interface ToastContextValue {
  show: (type: ToastType, message: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
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
    (type: ToastType, message: string) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { id, type, message }]);
      setTimeout(() => remove(id), 3500);
    },
    [remove],
  );

  const ctx: ToastContextValue = {
    show,
    success: (msg) => show("success", msg),
    error: (msg) => show("error", msg),
    info: (msg) => show("info", msg),
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
                    : "search"
              }
              size={16}
            />
            <span className="toast-msg">{t.message}</span>
            <button
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
          top: 16px;
          right: 16px;
          z-index: var(--z-toast);
          display: flex;
          flex-direction: column;
          gap: 8px;
          pointer-events: none;
        }
        .toast {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 16px;
          border-radius: var(--radius-md);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.3);
          color: var(--text-primary);
          font-size: 0.875rem;
          min-width: 280px;
          max-width: 400px;
          pointer-events: auto;
          cursor: pointer;
          animation: slideIn 0.2s ease-out;
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
        }
        .toast-close {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          border-radius: var(--radius-sm);
        }
        .toast-close:hover {
          color: var(--text-primary);
          background: var(--bg-surface-2);
        }
      `}</style>
    </ToastContext.Provider>
  );
}

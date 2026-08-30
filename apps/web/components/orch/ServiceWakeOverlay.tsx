"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { ORCH_SERVICE_LABELS, useOrchStatus } from "@/lib/orch";

interface ServiceWakeOverlayProps {
  /** 冷层服务名(注册表 key):i2l / trainer / lipsync / hy3dtex。 */
  serviceName: string;
  /** 受控显隐(由调用方根据 503 捕获或自主状态管理)。 */
  visible: boolean;
  /** 取消当前在途请求(调用方持有 AbortController,点击取消时 abort)。 */
  onCancel?: () => void;
  /** 手动关闭(仅当 onCancel 未传或取消后仍想关闭 overlay)。 */
  onClose?: () => void;
}

/**
 * 「服务唤醒中」全屏遮罩(半透明 overlay + 居中进度卡片)。
 *
 * 设计要点(对齐 §7 动效规范):
 * - 时长 fade 300ms(--duration-slow),pulse 1200ms(infinite)
 * - 零 hex,全 token;reduced-motion 停止 pulse、缩短信至 0
 * - z-index modal 档(300),不与 toast(400)冲突
 */
export function ServiceWakeOverlay({
  serviceName,
  visible,
  onCancel,
  onClose,
}: ServiceWakeOverlayProps) {
  const { isWaking, statusOf, wake, pollError } = useOrchStatus();
  const [dismissed, setDismissed] = useState(false);
  const [exiting, setExiting] = useState(false);

  const status = statusOf(serviceName);
  const isError = status === "error";
  const label = ORCH_SERVICE_LABELS[serviceName] || serviceName;

  // 服务 running 时自动淡出(300ms),完成后彻底卸载
  useEffect(() => {
    if (!visible) return;
    if (status === "running" && !dismissed) {
      setExiting(true);
      const t = setTimeout(() => {
        setDismissed(true);
        onClose?.();
      }, 300);
      return () => clearTimeout(t);
    }
  }, [status, visible, dismissed, onClose]);

  // visible 重新置 true 时重置 dismissed/exiting
  useEffect(() => {
    if (visible) {
      setDismissed(false);
      setExiting(false);
    }
  }, [visible]);

  const handleCancel = useCallback(() => {
    onCancel?.();
    setExiting(true);
    const t = setTimeout(() => {
      setDismissed(true);
      onClose?.();
    }, 300);
    return () => clearTimeout(t);
  }, [onCancel, onClose]);

  const handleManualWake = useCallback(async () => {
    try {
      await wake(serviceName);
    } catch {
      /* 错误由 pollError / 局部状态兜底;不额外 toast */
    }
  }, [wake, serviceName]);

  const shouldShow = visible && !dismissed;
  if (!shouldShow) return null;

  return (
    <div
      className={`sw-overlay${exiting ? " is-exiting" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={`${label} 唤醒中`}
    >
      <div className="sw-card">
        <div className="sw-icon">
          <Icon name="cpu" size={32} />
        </div>
        <p className="sw-title">
          {isError ? `${label} 唤醒失败` : `正在唤醒 ${label}…`}
        </p>

        {!isError && (
          <>
            <div className="sw-progress">
              <div className="sw-progress-track">
                <div className="sw-progress-bar" />
              </div>
            </div>
            <p className="sw-hint">
              首次调用可能需要 1-2 分钟
            </p>
          </>
        )}

        {isError && (
          <div className="sw-error">
            <ErrorBar
              message={`${label} 唤醒失败${pollError ? ` · ${pollError}` : ""}`}
              onClose={() => {
                setExiting(true);
                setTimeout(() => {
                  setDismissed(true);
                  onClose?.();
                }, 300);
              }}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={handleManualWake}
              className="sw-wake-btn"
            >
              <Icon name="refresh" size={14} />
              手动唤醒
            </Button>
          </div>
        )}

        {onCancel && !isError && (
          <button type="button" className="sw-cancel" onClick={handleCancel}>
            取消
          </button>
        )}
      </div>

      <style jsx>{`
        .sw-overlay {
          position: fixed;
          inset: 0;
          z-index: var(--z-modal);
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--overlay-light);
          backdrop-filter: blur(4px);
          animation: sw-fade-in 300ms var(--ease-standard) forwards;
        }
        .sw-overlay.is-exiting {
          animation: sw-fade-out 300ms var(--ease-standard) forwards;
        }

        @keyframes sw-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes sw-fade-out {
          from { opacity: 1; }
          to { opacity: 0; }
        }

        .sw-card {
          width: min(360px, calc(100vw - var(--space-6)));
          padding: var(--space-6);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          box-shadow: var(--shadow-float);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-4);
          text-align: center;
        }

        .sw-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 64px;
          height: 64px;
          border-radius: var(--radius-full);
          background: var(--accent-soft);
          color: var(--accent);
        }

        .sw-title {
          margin: 0;
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          line-height: 1.3;
        }

        .sw-progress {
          width: 100%;
        }
        .sw-progress-track {
          height: 8px;
          background: var(--bg-surface-2);
          border-radius: var(--radius-full);
          overflow: hidden;
        }
        .sw-progress-bar {
          height: 100%;
          width: 60%;
          background: var(--accent);
          border-radius: var(--radius-full);
          animation: sw-pulse 1200ms var(--ease-standard) infinite;
        }
        @keyframes sw-pulse {
          0% { opacity: 0.5; transform: translateX(-10%); }
          50% { opacity: 1; transform: translateX(60%); }
          100% { opacity: 0.5; transform: translateX(-10%); }
        }

        .sw-hint {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.5;
        }

        .sw-error {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          align-items: center;
        }
        .sw-error :global(.ui-error-bar) {
          width: 100%;
        }

        .sw-wake-btn {
          min-height: 44px;
        }

        .sw-cancel {
          font-size: var(--text-aux);
          color: var(--text-muted);
          background: transparent;
          border: none;
          cursor: pointer;
          padding: var(--space-1) var(--space-2);
          border-radius: var(--radius-control);
          transition: color var(--duration-fast) var(--ease-standard);
        }
        .sw-cancel:hover {
          color: var(--text-primary);
        }

        @media (prefers-reduced-motion: reduce) {
          .sw-progress-bar {
            animation: none;
            opacity: 1;
            transform: none;
            width: 100%;
          }
        }
      `}</style>
    </div>
  );
}

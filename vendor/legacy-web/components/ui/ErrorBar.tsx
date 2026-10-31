"use client";

import { Icon } from "./Icon";

interface ErrorBarProps {
  /** 错误文案(空值不渲染) */
  message: string | null;
  /** 关闭回调(受控:调用方负责清空 message,与 StudioView hook clearError 范式一致) */
  onClose: () => void;
  className?: string;
}

/**
 * 可关闭错误条(StudioView studio-error-bar 范式提炼,受控组件):
 * role=alert、err-soft 底、reduced-motion 无入场动画。
 * 视觉原样复刻:ui-error-bar* 样式见 app/styles/effects.css。
 */
export function ErrorBar({ message, onClose, className }: ErrorBarProps) {
  if (!message) return null;
  return (
    <p className={["ui-error-bar", className].filter(Boolean).join(" ")} role="alert">
      <span className="ui-error-bar-text">{message}</span>
      <button type="button" className="ui-error-bar-close" aria-label="关闭错误提示" onClick={onClose}>
        <Icon name="close" size={12} />
      </button>
    </p>
  );
}

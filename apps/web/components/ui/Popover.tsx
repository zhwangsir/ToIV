"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface PopoverProps {
  open: boolean;
  /** 锚点元素(弹层下缘对齐其底部,右缘不足时自动左收) */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  /** 弹层最小宽度,用于右缘翻转计算(默认 220) */
  width?: number;
  /** 与锚点的垂直间距(默认 6) */
  gap?: number;
  className?: string;
  /** a11y:弹层角色(listbox/menu/dialog 等) */
  role?: string;
  ariaLabel?: string;
}

/**
 * 统一弹层基座(Studio Slate W1):portal 到 body,逃逸祖先 overflow:hidden 截断。
 *
 * Why:此前各视图手写 getBoundingClientRect + fixed 定位(OptimizeButton 等),
 * 逻辑重复且行为不一(有的不跟滚动重定位、有的无 Esc 关闭)。收敛为单基座:
 * - 定位:锚点正下方,右侧空间不足时向左收;开窗/滚动/缩放实时重算
 * - 关闭:外部 mousedown / Esc;内部点击不冒泡关闭
 * - 动效:fadeIn ≤200ms,遵守 prefers-reduced-motion(由全局 anim 承载)
 *
 * 视觉样式不在基座内 —— 由调用方 className + 局部 styled-jsx 提供
 * (基座只管定位/关闭/portal,不绑设计)。
 */
export function Popover({
  open,
  anchorRef,
  onClose,
  children,
  width = 220,
  gap = 6,
  className,
  role,
  ariaLabel,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    let left = rect.left;
    if (left + width > window.innerWidth - 16) {
      left = Math.max(16, rect.right - width);
    }
    setPos({ top: rect.bottom + gap, left });
  }, [anchorRef, width, gap]);

  useEffect(() => {
    if (!open) return;
    reposition();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return; // 锚点自身点击由调用方处理开合
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition, onClose, anchorRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      className={className}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        zIndex: "var(--z-sticky)",
        minWidth: width,
        animation: "fadeIn var(--duration-base) var(--ease-standard)",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

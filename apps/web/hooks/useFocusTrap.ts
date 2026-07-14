import { useEffect, RefObject } from "react";

/**
 * 焦点陷阱 hook:将 Tab 键焦点限制在容器内。
 * 用于 Modal / Dialog / Drawer,WCAG 2.1 AA 合规。
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  isActive: boolean,
  onEscape?: () => void,
): void {
  useEffect(() => {
    if (!isActive || !containerRef.current) return;
    const container = containerRef.current;

    // 记录触发元素,关闭后焦点返回
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // 聚焦容器内首个可聚焦元素
    const focusable = getFocusable(container);
    if (focusable.length > 0) {
      focusable[0].focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onEscape) {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;

      const currentFocusable = getFocusable(container);
      if (currentFocusable.length === 0) return;

      const first = currentFocusable[0];
      const last = currentFocusable[currentFocusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [isActive, containerRef, onEscape]);
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  const selectors = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ];
  return Array.from(
    container.querySelectorAll<HTMLElement>(selectors.join(",")),
  ).filter((el) => el.offsetParent !== null); // 过滤不可见元素
}

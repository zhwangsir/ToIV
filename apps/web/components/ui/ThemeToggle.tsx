"use client";

import { useCallback, useEffect, useState } from "react";

type Theme = "dark" | "light";

const STORAGE_KEY = "toiv_theme";

/**
 * 暗 ⇄ 亮 主题切换。
 * - 状态源:document.documentElement.dataset.theme(light 时设值,dark 时移除)。
 * - 持久化:localStorage('toiv_theme')。首屏无闪烁由 layout 内联脚本保证。
 * - 沿用顶栏按钮 token(.logout 样式)。
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  // 挂载后读取真实 DOM 状态(内联脚本已在首屏前设好),避免水合不一致。
  useEffect(() => {
    const current: Theme =
      document.documentElement.dataset.theme === "light" ? "light" : "dark";
    setTheme(current);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "light" ? "dark" : "light";
      const root = document.documentElement;
      if (next === "light") {
        root.dataset.theme = "light";
      } else {
        delete root.dataset.theme;
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // 隐私模式 / 存储不可用:仅本次会话生效,静默降级。
      }
      return next;
    });
  }, []);

  const isLight = theme === "light";

  return (
    <button
      type="button"
      className="logout theme-toggle"
      onClick={toggle}
      aria-label={isLight ? "切换到暗色主题" : "切换到亮色主题"}
      title={isLight ? "暗色" : "亮色"}
    >
      {isLight ? (
        // 月亮:当前亮色,点击转暗
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
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        // 太阳:当前暗色,点击转亮
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
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )}
    </button>
  );
}

"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { applyTheme, getCurrentTheme, THEMES, type ThemeId } from "@/lib/theme";

/**
 * 主题五色行:每主题一个 accent+surface 双色圆点 + 名称,当前主题打勾。
 * 用于 CornerNav 账户 Popover(桌面)与 BottomNav「更多」抽屉(窄屏);
 * 切换写 localStorage + dataset.theme,不刷新页面。
 * 样式在 globals.css(.theme-picker/.theme-swatch),不含组件级 styled-jsx。
 */
export function ThemePicker() {
  // SSR/首帧先渲染默认,挂载后同步 localStorage 真实值,避免水合不一致
  const [current, setCurrent] = useState<ThemeId>("paper");

  useEffect(() => {
    setCurrent(getCurrentTheme());
  }, []);

  const select = (id: ThemeId) => {
    setCurrent(id);
    applyTheme(id);
  };

  return (
    <div className="theme-picker" role="radiogroup" aria-label="主题">
      <div className="theme-picker-label">主题</div>
      <div className="theme-picker-row">
        {THEMES.map((t) => {
          const active = t.id === current;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={`theme-swatch${active ? " is-active" : ""}`}
              onClick={() => select(t.id)}
              title={t.name}
            >
              <span
                className="theme-swatch-dot"
                style={{ background: `linear-gradient(135deg, ${t.accent} 0 50%, ${t.surface} 50% 100%)` }}
                aria-hidden="true"
              >
                {active && (
                  <span className="theme-swatch-check">
                    <Icon name="check" size={10} />
                  </span>
                )}
              </span>
              <span className="theme-swatch-name">{t.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

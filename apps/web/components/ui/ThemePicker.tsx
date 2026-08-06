"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { applyTheme, getCurrentTheme, THEMES, type ThemeId } from "@/lib/theme";

/**
 * 主题五色行:每主题一个 accent+surface 双色圆点 + 名称,当前主题打勾。
 * 用于 IslandNav 账户 Popover(桌面)与 BottomNav「更多」抽屉(窄屏);
 * 切换写 localStorage + dataset.theme,不刷新页面。
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
      <style jsx>{`
        .theme-picker {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-1) 0;
        }
        .theme-picker-label {
          font-size: var(--text-label);
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
          padding: 0 var(--space-1);
        }
        .theme-picker-row {
          display: flex;
          align-items: flex-start;
          gap: var(--space-1);
        }
        .theme-swatch {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: var(--space-1);
          border-radius: var(--radius-control);
          color: var(--text-secondary);
          font-size: var(--text-label);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .theme-swatch:hover {
          background: var(--bg-surface-2);
          color: var(--text-primary);
        }
        .theme-swatch.is-active {
          color: var(--accent);
          font-weight: 600;
        }
        .theme-swatch-dot {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          border: 1px solid var(--border-subtle);
          box-shadow: var(--shadow-sm);
        }
        .theme-swatch.is-active .theme-swatch-dot {
          border-color: var(--accent);
          box-shadow: inset 0 0 0 1px var(--accent);
        }
        .theme-swatch-check {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--accent);
          color: var(--text-on-accent);
        }
      `}</style>
    </div>
  );
}

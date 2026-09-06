"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import { useCrossTabSync } from "@/lib/crossTab";
import {
  ACCENT_STORAGE_KEY,
  applyAccent,
  applyAccentDom,
  applyCustom,
  applyCustomDom,
  applyMode,
  applyModeDataset,
  applyTheme,
  applyThemeDataset,
  CUSTOM_STORAGE_KEY,
  getCurrentMode,
  getCurrentTheme,
  getCustom,
  getCustomAccent,
  MODE_STORAGE_KEY,
  THEME_CHANGED_EVENT,
  THEME_PRESETS,
  THEME_STORAGE_KEY,
  type Mode,
  type ThemeChangedDetail,
  type ThemeCustom,
  type ThemePreset,
} from "@/lib/theme";

/** 快捷强调色板(预设 accent 定义本身,非装饰色,豁免硬编码纪律;
   第一枚 = cinema 荧光绿,最后一枚 = minimal 墨色) */
const ACCENT_SWATCHES = ["#C9F24F", "#8B5CF6", "#3B82F6", "#F59E0B", "#EF4444", "#17181A"];

/**
 * 主题选择器 v9(2026-09-07 主题系统):
 *   预设主题四色卡网格(minimal/cinema/paper/graphite,缩略 = 底色块 + accent 点);
 *   明暗段控与纯黑开关仅对亮基底主题(minimal/paper)生效(暗基底主题隐藏);
 *   自定义强调色(input[type=color] + 快捷色板 + 清除)覆盖任意主题 accent。
 * 用于 Settings 界面卡 / AccountButton 弹层 / BottomNav「更多」抽屉三处;
 * 切换写 localStorage + DOM,不刷新页面;四 key 均接入跨标签页同步
 * (他页变更只写 DOM 不回写 localStorage——他页已写过,回写会在多页间形成事件乒乓)。
 */
export function ThemePicker() {
  // SSR/首帧先渲染默认(minimal + light),挂载后同步 localStorage 真实值,避免水合不一致
  const [theme, setTheme] = useState<ThemePreset>("minimal");
  const [mode, setMode] = useState<Mode>("light");
  const [custom, setCustom] = useState<ThemeCustom>({});
  const [accent, setAccent] = useState<string | null>(null);

  useEffect(() => {
    setTheme(getCurrentTheme());
    setMode(getCurrentMode());
    setCustom(getCustom());
    setAccent(getCustomAccent());
  }, []);

  // P1-8 跨标签页同步:他页切换 → 本页即时跟随
  useCrossTabSync(THEME_STORAGE_KEY, () => {
    const t = getCurrentTheme();
    applyThemeDataset(t);
    setTheme(t);
  });
  useCrossTabSync(MODE_STORAGE_KEY, () => {
    // localStorage 跨页共享,他页写入对本页即时可见,直接回读校验后的真值
    const m = getCurrentMode();
    applyModeDataset(m);
    setMode(m);
  });
  useCrossTabSync(CUSTOM_STORAGE_KEY, () => {
    const c = getCustom();
    applyCustomDom(c);
    setCustom(c);
  });
  useCrossTabSync(ACCENT_STORAGE_KEY, () => {
    const a = getCustomAccent();
    applyAccentDom(a);
    setAccent(a);
  });

  // 同页多实例同步:本页另一 ThemePicker 实例切换 → apply* 广播,本实例按 detail 刷新
  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<ThemeChangedDetail>).detail;
      if (!d) return;
      if (d.theme) setTheme(d.theme);
      if (d.mode) setMode(d.mode);
      if (d.custom) setCustom(d.custom);
      if (d.accent !== undefined) setAccent(d.accent);
    };
    window.addEventListener(THEME_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChanged);
  }, []);

  const darkBased = THEME_PRESETS.find((p) => p.id === theme)?.darkBased === true;

  return (
    <div className="theme-picker">
      <div className="theme-picker-label">主题</div>
      <div className="theme-preset-grid" role="radiogroup" aria-label="预设主题">
        {THEME_PRESETS.map((p) => {
          const active = p.id === theme;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={`theme-preset-card${active ? " is-active" : ""}`}
              onClick={() => {
                setTheme(p.id);
                applyTheme(p.id);
              }}
            >
              <span className="theme-preset-thumb" style={{ background: p.swatchBg }}>
                <span className="theme-preset-dot" style={{ background: p.swatchAccent }} />
              </span>
              <span className="theme-preset-name">{p.name}</span>
              {active && (
                <span className="theme-preset-check" aria-hidden="true">
                  <Icon name="check" size={12} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 明暗/纯黑仅对亮基底主题生效(cinema/graphite 自带暗基底) */}
      {!darkBased && (
        <>
          <div className="theme-picker-label">模式</div>
          <div className="at-seg theme-mode-seg" role="radiogroup" aria-label="界面模式">
            {(["light", "dark"] as Mode[]).map((m) => {
              const active = m === mode;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`at-seg-btn theme-mode-btn${active ? " is-active" : ""}`}
                  onClick={() => {
                    setMode(m);
                    applyMode(m);
                  }}
                >
                  <Icon name={m === "dark" ? "moon" : "sun"} size={12} />
                  {m === "dark" ? "暗色" : "亮色"}
                </button>
              );
            })}
          </div>

          {mode === "dark" && (
            <div className="theme-custom-pureblack">
              <Switch
                checked={custom.pureBlack === true}
                onChange={(on) => {
                  const next: ThemeCustom = { pureBlack: on };
                  setCustom(next);
                  applyCustom(next);
                }}
                label="纯黑背景"
                ariaLabel="纯黑背景"
              />
            </div>
          )}
        </>
      )}

      <div className="theme-picker-label">强调色</div>
      <div className="theme-accent-row">
        <input
          type="color"
          className="theme-accent-input"
          aria-label="自定义强调色"
          value={accent ?? THEME_PRESETS.find((p) => p.id === theme)?.swatchAccent ?? "#17181A"}
          onChange={(e) => {
            const v = e.target.value.toUpperCase();
            setAccent(v);
            applyAccent(v);
          }}
        />
        <div className="theme-accent-swatches">
          {ACCENT_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              className={`theme-accent-swatch${accent === hex ? " is-active" : ""}`}
              style={{ background: hex }}
              aria-label={`强调色 ${hex}`}
              onClick={() => {
                setAccent(hex);
                applyAccent(hex);
              }}
            />
          ))}
        </div>
        {accent && (
          <button
            type="button"
            className="theme-accent-clear"
            onClick={() => {
              setAccent(null);
              applyAccent(null);
            }}
          >
            清除自定义
          </button>
        )}
      </div>

      <style jsx global>{`
        .theme-picker {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .theme-preset-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: var(--space-2);
        }
        .theme-preset-card {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-2);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          cursor: pointer;
          color: var(--text-secondary);
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .theme-preset-card:hover {
          border-color: var(--border-strong);
        }
        .theme-preset-card.is-active {
          border-color: var(--accent-glow);
          box-shadow: 0 0 0 1px var(--accent-glow);
          color: var(--text-primary);
        }
        .theme-preset-thumb {
          position: relative;
          width: 100%;
          aspect-ratio: var(--media-ar-thumb);
          border-radius: var(--radius-badge);
          border: 1px solid var(--border-subtle);
        }
        .theme-preset-dot {
          position: absolute;
          left: 50%;
          top: 50%;
          width: 10px;
          height: 10px;
          border-radius: var(--radius-full);
          transform: translate(-50%, -50%);
        }
        .theme-preset-name {
          font-size: var(--text-aux);
        }
        .theme-preset-check {
          position: absolute;
          top: var(--space-1);
          right: var(--space-1);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          border-radius: var(--radius-full);
          background: var(--accent);
          color: var(--text-on-accent);
        }
        .theme-mode-seg {
          align-self: flex-start;
        }
        .theme-mode-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
        }
        .theme-custom-pureblack {
          padding: var(--space-1) var(--space-1) 0;
        }
        .theme-accent-row {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .theme-accent-input {
          width: 32px;
          height: 32px;
          padding: 0;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          background: var(--bg-surface-1);
          cursor: pointer;
        }
        .theme-accent-swatches {
          display: flex;
          gap: var(--space-1);
        }
        .theme-accent-swatch {
          width: 20px;
          height: 20px;
          border-radius: var(--radius-full);
          border: 1px solid var(--border-subtle);
          cursor: pointer;
          padding: 0;
        }
        .theme-accent-swatch.is-active {
          box-shadow: 0 0 0 2px var(--bg-canvas), 0 0 0 3px var(--accent-glow);
        }
        .theme-accent-clear {
          border: none;
          background: none;
          padding: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          cursor: pointer;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .theme-accent-clear:hover {
          color: var(--accent-glow);
        }
        @media (max-width: 575px) {
          .theme-preset-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
      `}</style>
    </div>
  );
}

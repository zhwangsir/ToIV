"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import { useCrossTabSync } from "@/lib/crossTab";
import {
  applyCustom,
  applyCustomDom,
  applyMode,
  applyModeDataset,
  applyTheme,
  applyThemeDataset,
  CUSTOM_ACCENT_PRESETS,
  CUSTOM_STORAGE_KEY,
  getCurrentMode,
  getCurrentTheme,
  getCustom,
  MODE_STORAGE_KEY,
  THEME_CHANGED_EVENT,
  THEME_STORAGE_KEY,
  THEMES,
  type Mode,
  type ThemeChangedDetail,
  type ThemeCustom,
  type ThemeId,
} from "@/lib/theme";

/**
 * 主题选择器 v7(2026-08-16,模式 × 色板 × 自定义三层):
 *   上:模式段控「亮色/暗色」(复用全局 .at-seg);
 *   中:既有 5 色板 swatch 行(radio 语义保留);
 *   下:自定义区——预设色丸 + 自由取色 + 恢复默认;暗色模式下加「纯黑背景」开关。
 * 用于 Settings 界面卡 / CornerNav 账户 Popover / BottomNav「更多」抽屉三处;
 * 切换写 localStorage + DOM,不刷新页面;三 key 均接入跨标签页同步
 * (他页变更只写 DOM 不回写 localStorage——他页已写过,回写会在多页间形成事件乒乓)。
 * 色板行样式在 globals.css(.theme-picker/.theme-swatch);新增区块样式走组件内
 * styled-jsx global(零 hex,全 token),随组件到达三处入口。
 */
export function ThemePicker() {
  // SSR/首帧先渲染默认,挂载后同步 localStorage 真实值,避免水合不一致
  const [current, setCurrent] = useState<ThemeId>("paper");
  const [mode, setMode] = useState<Mode>("light");
  const [custom, setCustom] = useState<ThemeCustom>({});

  useEffect(() => {
    setCurrent(getCurrentTheme());
    setMode(getCurrentMode());
    setCustom(getCustom());
  }, []);

  // P1-8 跨标签页同步:他页切换主题/模式/自定义 → 本页即时跟随
  useCrossTabSync(THEME_STORAGE_KEY, (newValue) => {
    const hit = THEMES.find((x) => x.id === newValue);
    const id: ThemeId = hit ? hit.id : "paper";
    applyThemeDataset(id);
    setCurrent(id); // 值相同 React 自动跳过重渲染,无需手动去重
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

  // 同页多实例同步(2026-08-16 审计):本页另一 ThemePicker 实例切换 → apply* 广播
  // toiv:theme-changed,本实例按 detail 刷新选中态(DOM 已由发起方写好,不重复写,
  // 自己的 setState 与广播值相同,React 自动跳过重渲染);跨标签页仍走上方 storage 通道
  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<ThemeChangedDetail>).detail;
      if (!d) return;
      if (d.theme) setCurrent(d.theme);
      if (d.mode) setMode(d.mode);
      if (d.custom) setCustom(d.custom);
    };
    window.addEventListener(THEME_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChanged);
  }, []);

  const selectMode = (m: Mode) => {
    setMode(m);
    applyMode(m);
  };

  // 点选色板即回到「板载 accent」:自定义 accent 覆盖随之清除(pureBlack 保留),
  // 否则色板选中态与实际 accent 不一致会造成困惑
  const select = (id: ThemeId) => {
    setCurrent(id);
    applyTheme(id);
    if (custom.accent) {
      const next: ThemeCustom = {};
      if (custom.pureBlack) next.pureBlack = true;
      setCustom(next);
      applyCustom(next);
    }
  };

  const selectAccent = (accent: string) => {
    const next: ThemeCustom = { ...custom, accent };
    setCustom(next);
    applyCustom(next);
  };

  // 恢复默认仅清除自定义 accent;pureBlack 由其独立开关控制
  const resetAccent = () => {
    const next: ThemeCustom = {};
    if (custom.pureBlack) next.pureBlack = true;
    setCustom(next);
    applyCustom(next);
  };

  const togglePureBlack = (on: boolean) => {
    const next: ThemeCustom = { ...custom, pureBlack: on };
    setCustom(next);
    applyCustom(next);
  };

  return (
    <div className="theme-picker">
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
              onClick={() => selectMode(m)}
            >
              <Icon name={m === "dark" ? "moon" : "sun"} size={12} />
              {m === "dark" ? "暗色" : "亮色"}
            </button>
          );
        })}
      </div>

      <div className="theme-picker-label">色板</div>
      <div className="theme-picker-row" role="radiogroup" aria-label="色板">
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

      <div className="theme-picker-label">自定义</div>
      <div className="theme-custom">
        <div className="theme-custom-row" role="radiogroup" aria-label="自定义强调色">
          {CUSTOM_ACCENT_PRESETS.map((p) => {
            const active = custom.accent?.toLowerCase() === p.color.toLowerCase();
            return (
              <button
                key={p.color}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`强调色 ${p.name}`}
                title={p.name}
                className={`theme-custom-dot${active ? " is-active" : ""}`}
                style={{ background: p.color }}
                onClick={() => selectAccent(p.color)}
              >
                {active && (
                  <span className="theme-swatch-check theme-custom-check" aria-hidden="true">
                    <Icon name="check" size={9} />
                  </span>
                )}
              </button>
            );
          })}
          <label className="theme-custom-color" title="自由取色">
            <input
              type="color"
              value={custom.accent ?? CUSTOM_ACCENT_PRESETS[0].color}
              onChange={(e) => selectAccent(e.target.value)}
              aria-label="自由取色"
            />
            <Icon name="palette" size={11} />
          </label>
          {custom.accent && (
            <button type="button" className="theme-custom-reset" onClick={resetAccent}>
              <Icon name="undo" size={11} />
              恢复默认
            </button>
          )}
        </div>
        {mode === "dark" && (
          <div className="theme-custom-row theme-custom-pureblack">
            <Switch
              checked={custom.pureBlack === true}
              onChange={togglePureBlack}
              label="纯黑背景"
              ariaLabel="纯黑背景"
            />
          </div>
        )}
      </div>

      <style jsx global>{`
        /* ThemePicker v7 新增区块(模式段控/自定义区);色板行样式仍在 globals.css */
        .theme-mode-seg {
          align-self: flex-start;
          margin-bottom: var(--space-1);
        }
        .theme-mode-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
        }
        .theme-custom {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .theme-custom-row {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: var(--space-2);
          padding: 0 var(--space-1);
        }
        .theme-custom-dot {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          border: 1px solid var(--border-subtle);
          box-shadow: var(--shadow-sm);
          cursor: pointer;
          transition: transform var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .theme-custom-dot:hover {
          transform: scale(1.08);
        }
        .theme-custom-dot.is-active {
          box-shadow:
            0 0 0 2px var(--bg-surface-1),
            0 0 0 4px var(--accent);
        }
        .theme-custom-check {
          width: 12px;
          height: 12px;
          /* 预设丸底色即 accent,对勾反色用 accent 上的文字色 */
          background: var(--text-on-accent);
          color: var(--accent);
        }
        .theme-custom-color {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          border: 1px dashed var(--border-strong);
          /* 与预设色丸同盒(20px + shadow-sm),视觉尺寸对齐(2026-08-16 审计) */
          box-shadow: var(--shadow-sm);
          color: var(--text-muted);
          cursor: pointer;
          overflow: hidden;
          transition: color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .theme-custom-color:hover {
          color: var(--text-primary);
          border-color: var(--accent);
        }
        .theme-custom-color input[type="color"] {
          position: absolute;
          inset: 0;
          opacity: 0;
          cursor: pointer;
        }
        .theme-custom-reset {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: 2px var(--space-2);
          border-radius: var(--radius-full);
          border: 1px solid var(--border-subtle);
          color: var(--text-secondary);
          font-size: var(--text-label);
          cursor: pointer;
          transition: color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .theme-custom-reset:hover {
          color: var(--text-primary);
          border-color: var(--border-strong);
        }
        .theme-custom-pureblack {
          padding-top: var(--space-1);
        }
        @media (prefers-reduced-motion: reduce) {
          .theme-custom-dot:hover {
            transform: none;
          }
        }
      `}</style>
    </div>
  );
}

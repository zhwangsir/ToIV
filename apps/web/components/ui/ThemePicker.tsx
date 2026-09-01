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
  CUSTOM_STORAGE_KEY,
  getCurrentMode,
  getCustom,
  MODE_STORAGE_KEY,
  THEME_CHANGED_EVENT,
  type Mode,
  type ThemeChangedDetail,
  type ThemeCustom,
} from "@/lib/theme";

/**
 * 主题选择器 v8(2026-08-31,Studio Console 单色中性系):
 *   模式段控「亮色/暗色」;暗色下加「纯黑背景」开关。
 *   五色板与自定义强调色已退役(v7 → v8 收敛,见 lib/theme.ts)。
 * 用于 Settings 界面卡 / AccountButton 弹层 / BottomNav「更多」抽屉三处;
 * 切换写 localStorage + DOM,不刷新页面;两 key 均接入跨标签页同步
 * (他页变更只写 DOM 不回写 localStorage——他页已写过,回写会在多页间形成事件乒乓)。
 */
export function ThemePicker() {
  // SSR/首帧先渲染默认,挂载后同步 localStorage 真实值,避免水合不一致
  const [mode, setMode] = useState<Mode>("light");
  const [custom, setCustom] = useState<ThemeCustom>({});

  useEffect(() => {
    setMode(getCurrentMode());
    setCustom(getCustom());
  }, []);

  // P1-8 跨标签页同步:他页切换模式/纯黑 → 本页即时跟随
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

  // 同页多实例同步:本页另一 ThemePicker 实例切换 → apply* 广播,本实例按 detail 刷新
  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<ThemeChangedDetail>).detail;
      if (!d) return;
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

  const togglePureBlack = (on: boolean) => {
    const next: ThemeCustom = { pureBlack: on };
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

      {mode === "dark" && (
        <div className="theme-custom-pureblack">
          <Switch
            checked={custom.pureBlack === true}
            onChange={togglePureBlack}
            label="纯黑背景"
            ariaLabel="纯黑背景"
          />
        </div>
      )}

      <style jsx global>{`
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
      `}</style>
    </div>
  );
}

"use client";

import { useRef, useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { MagnetFollow } from "@/components/ui/MagnetFollow";
import { Ripple } from "@/components/ui/Ripple";
import { ThemePicker } from "@/components/ui/ThemePicker";
import { useFocusTrap } from "@/hooks/useFocusTrap";

export interface BottomNavItem {
  key: string;
  label: string;
  icon: IconName;
  isCta?: boolean;
}

interface BottomNavProps {
  /** 主入口(≤5 个,含可选 CTA) */
  items: BottomNavItem[];
  /** 「更多」抽屉承载的其余入口 */
  moreItems?: BottomNavItem[];
  current: string;
  onSelect: (key: string) => void;
  ctaAction?: () => void;
}

/**
 * 窄屏(<1024px)底部导航:主入口 ≤5 + 「更多」抽屉承载其余。
 * 样式走主题 token(激活态 accent);抽屉复用全局 .sheet。
 */
export function BottomNav({ items, moreItems = [], current, onSelect, ctaAction }: BottomNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  // 「更多」抽屉 a11y(2026-08-30 UX 批 C):Esc 关闭 + Tab 焦点陷阱 + 关闭后焦点回位
  useFocusTrap(sheetRef, moreOpen, () => setMoreOpen(false));

  const select = (key: string) => {
    setMoreOpen(false);
    onSelect(key);
  };

  return (
    <>
      <nav className="app-bottom-nav" role="navigation" aria-label="底部导航">
        {items.map((item) => {
          const isActive = item.key === current;
          if (item.isCta) {
            // 主 CTA(UI-A 动效原语接入):MagnetFollow 微吸附 + Ripple 水波纹;
            // 纯叠加包裹,按钮既有样式/行为不变;reduced-motion 自动退化
            return (
              <MagnetFollow key={item.key}>
                <Ripple radius="full">
                  <button
                    type="button"
                    className="bottom-nav-cta"
                    onClick={ctaAction ?? (() => onSelect(item.key))}
                    aria-label={item.label}
                  >
                    <Icon name={item.icon} size={22} />
                  </button>
                </Ripple>
              </MagnetFollow>
            );
          }
          return (
            <button
              key={item.key}
              type="button"
              className={`bottom-nav-item${isActive ? " is-active" : ""}`}
              onClick={() => select(item.key)}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon name={item.icon} size={20} />
              <span className="bottom-nav-label">{item.label}</span>
            </button>
          );
        })}
        {moreItems.length > 0 && (
          <button
            type="button"
            className={`bottom-nav-item${moreOpen ? " is-active" : ""}`}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label="更多"
          >
            <Icon name="menu" size={20} />
            <span className="bottom-nav-label">更多</span>
          </button>
        )}
      </nav>

      <div
        className={`drawer-overlay bottom-nav-overlay${moreOpen ? " is-open" : ""}`}
        onClick={() => setMoreOpen(false)}
        aria-hidden="true"
      />
      {/* bottom-nav-sheet:桌面 ≥1024px 整体 display:none(globals.css 断点门控);
          闭合态 visibility:hidden,视口外按钮不再进 tab 序(2026-08-16 审计修复) */}
      <div
        ref={sheetRef}
        className={`sheet bottom-nav-sheet${moreOpen ? " is-open" : ""}`}
        role="dialog"
        aria-label="更多入口"
        aria-modal={moreOpen || undefined}
        aria-hidden={!moreOpen}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-body">
          {moreItems.map((item) => {
            const isActive = item.key === current;
            return (
              <button
                key={item.key}
                type="button"
                className={`more-nav-item${isActive ? " is-active" : ""}`}
                onClick={() => select(item.key)}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
          <ThemePicker />
        </div>
      </div>
    </>
  );
}

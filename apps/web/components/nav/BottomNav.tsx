"use client";

import { useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";

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
 * 样式走 Obsidian token(激活态 accent);抽屉复用全局 .sheet。
 */
export function BottomNav({ items, moreItems = [], current, onSelect, ctaAction }: BottomNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);

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
            return (
              <button
                key={item.key}
                type="button"
                className="bottom-nav-cta"
                onClick={ctaAction ?? (() => onSelect(item.key))}
                aria-label={item.label}
              >
                <Icon name={item.icon} size={22} />
              </button>
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
              <span>{item.label}</span>
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
            <span>更多</span>
          </button>
        )}
      </nav>

      <div
        className={`drawer-overlay${moreOpen ? " is-open" : ""}`}
        onClick={() => setMoreOpen(false)}
        aria-hidden="true"
      />
      <div className={`sheet${moreOpen ? " is-open" : ""}`} role="dialog" aria-label="更多入口">
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
        </div>
      </div>
    </>
  );
}

"use client";

import { useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";

export interface CornerNavItem {
  key: string;
  label: string;
  icon: IconName;
}

interface CornerNavProps {
  items: CornerNavItem[];
  current: string;
  onSelect: (key: string) => void;
  /** 悬停/聚焦预热目标视图 chunk */
  onItemIntent?: (key: string) => void;
}

/**
 * 左上角悬停展开导航(浅色五色板 · 白玻璃;2026-08-17 起纯导航,账户已拆至右上角 AccountButton):
 * 收起态只有左上角一枚玻璃触发器(品牌点 + ToIV + 当前模块 + 展开箭头),不遮挡内容;
 * 悬停/聚焦/点击触发器后,向下展开竖向玻璃面板(图标 + 文字标签逐行列出全部模块);
 * 移出即收起,点击触发器可钉住展开态(触屏/触控板友好)。
 * 窄屏 <1024px 隐藏,由底部导航接管;横屏低高度仍显示(触发器占地极小,面板限高滚动)。
 */
export function CornerNav({ items, current, onSelect, onItemIntent }: CornerNavProps) {
  const [pinned, setPinned] = useState(false);

  const currentItem = items.find((i) => i.key === current);

  return (
    <div className={`cornernav${pinned ? " is-pinned" : ""}`}>
      <button
        type="button"
        className="cornernav-trigger"
        onClick={() => setPinned((v) => !v)}
        aria-expanded={pinned}
        aria-label="主导航"
        title="导航"
      >
        <span className="cornernav-brand-dot" aria-hidden="true" />
        <span className="cornernav-brand-text">ToIV</span>
        {currentItem && (
          <span className="cornernav-current">
            <Icon name={currentItem.icon} size={13} />
            {currentItem.label}
          </span>
        )}
        <Icon name="chevron-down" size={12} className="cornernav-chevron" />
      </button>

      <nav className="cornernav-panel" aria-label="主导航">
        <div className="cornernav-panel-inner">
          <div className="cornernav-items" role="tablist" aria-label="切换模块">
            {items.map((item) => {
              const active = item.key === current;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`cornernav-item${active ? " is-active" : ""}`}
                  onClick={(e) => {
                    e.currentTarget.blur(); /* 点击后释放焦点,避免 focus-within 钉住面板 */
                    setPinned(false);
                    onSelect(item.key);
                  }}
                  onMouseEnter={() => onItemIntent?.(item.key)}
                  onFocus={() => onItemIntent?.(item.key)}
                >
                  <span className="cornernav-item-icon">
                    <Icon name={item.icon} size={16} />
                  </span>
                  <span className="cornernav-item-label">{item.label}</span>
                  {active && <span className="cornernav-item-dot" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      </nav>
    </div>
  );
}

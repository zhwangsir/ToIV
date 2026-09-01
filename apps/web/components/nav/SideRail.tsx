"use client";

import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import "@/app/styles/siderail.css";

export interface RailItem {
  key: string;
  label: string;
  icon: IconName;
}

interface SideRailProps {
  /** 主导航项(上段) */
  items: readonly RailItem[];
  current: string;
  onSelect: (key: string) => void;
  /** 悬停/聚焦预热目标视图 chunk */
  onItemIntent?: (key: string) => void;
  /** 管理项(仅 admin 注入,渲染在主导航与底部槽位之间的分隔后) */
  adminItems?: readonly RailItem[];
  /** 唤起 ⌘K 命令面板 */
  onOpenPalette: () => void;
  /** 底部槽位:任务中心 / 设置 / 账户 */
  bottom?: ReactNode;
}

function RailButton({
  item,
  active,
  onSelect,
  onItemIntent,
}: {
  item: RailItem;
  active: boolean;
  onSelect: (key: string) => void;
  onItemIntent?: (key: string) => void;
}) {
  return (
    <button
      type="button"
      className={`siderail-item${active ? " is-active" : ""}`}
      onClick={() => onSelect(item.key)}
      onMouseEnter={() => onItemIntent?.(item.key)}
      onFocus={() => onItemIntent?.(item.key)}
      aria-current={active ? "page" : undefined}
      aria-label={item.label}
    >
      <Icon name={item.icon} size={17} strokeWidth={1.8} />
      <span className="siderail-tip" role="tooltip">
        {item.label}
      </span>
    </button>
  );
}

/**
 * Studio Console v1(2026-08-31)左侧 52px 常驻图标栏,取代左上角灵动岛:
 * 仅图标 + hover tooltip,当前项左侧 2px 指示条;顶部搜索钮唤起 ⌘K 命令面板;
 * 管理项(admin)独立分隔区;底部槽位收任务中心/设置/账户。
 * 窄屏 <1024px 隐藏(siderail.css 媒体查询),由底部导航接管。
 */
export function SideRail({
  items,
  current,
  onSelect,
  onItemIntent,
  adminItems,
  onOpenPalette,
  bottom,
}: SideRailProps) {
  return (
    <nav className="siderail" aria-label="主导航">
      <button
        type="button"
        className="siderail-item siderail-search"
        onClick={onOpenPalette}
        aria-label="搜索与命令面板(⌘K)"
      >
        <Icon name="search" size={17} strokeWidth={1.8} />
        <span className="siderail-tip" role="tooltip">
          搜索 · ⌘K
        </span>
      </button>

      <div className="siderail-group">
        {items.map((item) => (
          <RailButton
            key={item.key}
            item={item}
            active={item.key === current}
            onSelect={onSelect}
            onItemIntent={onItemIntent}
          />
        ))}
      </div>

      {adminItems?.length ? (
        <div className="siderail-group siderail-group--admin">
          {adminItems.map((item) => (
            <RailButton
              key={item.key}
              item={item}
              active={item.key === current}
              onSelect={onSelect}
              onItemIntent={onItemIntent}
            />
          ))}
        </div>
      ) : null}

      <div className="siderail-bottom">{bottom}</div>
    </nav>
  );
}

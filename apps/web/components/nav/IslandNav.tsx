"use client";

import { useRef, useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { Popover } from "@/components/ui/Popover";

export interface IslandNavItem {
  key: string;
  label: string;
  icon: IconName;
}

interface IslandNavProps {
  items: IslandNavItem[];
  current: string;
  onSelect: (key: string) => void;
  /** 悬停/聚焦预热目标视图 chunk */
  onItemIntent?: (key: string) => void;
  account?: string | null;
  onLogout?: () => void;
}

/**
 * 灵动岛悬浮导航(Studio Slate 版型):顶部居中胶囊,脱离边缘浮于内容之上。
 * 紧凑态:logo 点 + 当前模块名 + 纯图标排 + 账户头像;
 * 悬停/聚焦展开:图标旁滑出文字标签,岛体投出浮层阴影(纯 CSS 过渡,无 JS 动画库);
 * 账户菜单走 Popover 基座(portal,脱离岛 hover 生命周期,点击开关)。
 * 窄屏 <1024px 隐藏,由底部导航接管;横屏低高度仍显示(高度占地极小)。
 */
export function IslandNav({ items, current, onSelect, onItemIntent, account, onLogout }: IslandNavProps) {
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const currentItem = items.find((i) => i.key === current);

  return (
    <div className="island-dock">
      <nav className="island" aria-label="主导航">
        <span className="island-brand">
          <span className="island-brand-dot" aria-hidden="true" />
          <span className="island-brand-text">ToIV</span>
        </span>

        {currentItem && (
          <span className="island-current" aria-hidden="true">
            {currentItem.label}
          </span>
        )}

        <span className="island-sep" aria-hidden="true" />

        <div className="island-items" role="tablist" aria-label="切换模块">
          {items.map((item) => {
            const active = item.key === current;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                className={`island-item${active ? " is-active" : ""}`}
                onClick={() => onSelect(item.key)}
                onMouseEnter={() => onItemIntent?.(item.key)}
                onFocus={() => onItemIntent?.(item.key)}
                aria-label={item.label}
                title={item.label}
              >
                <span className="island-item-icon">
                  <Icon name={item.icon} size={16} />
                </span>
                <span className="island-item-label">{item.label}</span>
              </button>
            );
          })}
        </div>

        {account && (
          <>
            <span className="island-sep" aria-hidden="true" />
            <button
              ref={avatarRef}
              type="button"
              className="island-avatar"
              onClick={() => setAccountOpen((v) => !v)}
              aria-label={`账户 ${account}`}
              aria-expanded={accountOpen}
              title={account}
            >
              {account.charAt(0).toUpperCase()}
            </button>
            <Popover
              open={accountOpen}
              anchorRef={avatarRef}
              onClose={() => setAccountOpen(false)}
              width={200}
              role="menu"
              ariaLabel="账户菜单"
            >
              <div className="island-account-pop">
                <div className="island-account-email" title={account} translate="no">
                  {account}
                </div>
                {onLogout && (
                  <button type="button" className="island-account-logout" onClick={onLogout}>
                    <Icon name="close" size={13} />
                    退出登录
                  </button>
                )}
              </div>
            </Popover>
          </>
        )}
      </nav>
    </div>
  );
}

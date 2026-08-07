"use client";

import { useRef, useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { Popover } from "@/components/ui/Popover";
import { ThemePicker } from "@/components/ui/ThemePicker";

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
  account?: string | null;
  onLogout?: () => void;
}

/**
 * 左上角悬停展开导航(浅色五色板 · 白玻璃):
 * 收起态只有左上角一枚玻璃触发器(品牌点 + ToIV + 当前模块 + 展开箭头),不遮挡内容;
 * 悬停/聚焦/点击触发器后,向下展开竖向玻璃面板(图标 + 文字标签逐行列出全部模块,
 * 底部为账户行);移出即收起,点击触发器可钉住展开态(触屏/触控板友好);
 * 账户菜单走 Popover 基座(portal,脱离面板 hover 生命周期,点击开关)。
 * 窄屏 <1024px 隐藏,由底部导航接管;横屏低高度仍显示(触发器占地极小,面板限高滚动)。
 */
export function CornerNav({ items, current, onSelect, onItemIntent, account, onLogout }: CornerNavProps) {
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
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

          {account && (
            <>
              <span className="cornernav-sep" aria-hidden="true" />
              <button
                ref={avatarRef}
                type="button"
                className="cornernav-account"
                onClick={() => setAccountOpen((v) => !v)}
                aria-label={`账户 ${account}`}
                aria-expanded={accountOpen}
                title={account}
              >
                <span className="cornernav-avatar">{account.charAt(0).toUpperCase()}</span>
                <span className="cornernav-account-email" translate="no">
                  {account}
                </span>
                <Icon name="chevron-right" size={12} className="cornernav-account-go" />
              </button>
              <Popover
                open={accountOpen}
                anchorRef={avatarRef}
                onClose={() => setAccountOpen(false)}
                width={240}
                role="menu"
                ariaLabel="账户菜单"
              >
                <div className="cornernav-account-pop">
                  <div className="cornernav-account-pop-email" title={account} translate="no">
                    {account}
                  </div>
                  <ThemePicker />
                  <button
                    type="button"
                    className="cornernav-account-action"
                    onClick={() => {
                      setAccountOpen(false);
                      setPinned(false);
                      onSelect("settings");
                    }}
                  >
                    <Icon name="settings" size={13} />
                    设置
                  </button>
                  {onLogout && (
                    <button type="button" className="cornernav-account-logout" onClick={onLogout}>
                      <Icon name="close" size={13} />
                      退出登录
                    </button>
                  )}
                </div>
              </Popover>
            </>
          )}
        </div>
      </nav>
    </div>
  );
}

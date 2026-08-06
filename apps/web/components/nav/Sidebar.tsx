"use client";

import { Icon, type IconName } from "@/components/ui/Icon";

export interface SidebarNavItem {
  key: string;
  label: string;
  icon: IconName;
}

interface SidebarProps {
  items: SidebarNavItem[];
  current: string;
  onSelect: (key: string) => void;
  /** 悬停/聚焦预热目标视图 chunk */
  onItemIntent?: (key: string) => void;
  account?: string | null;
  onLogout?: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * W0 新应用壳左侧边栏。Studio Slate 版型:默认 64px 窄轨(图标 + tooltip),
 * 悬停/聚焦时浮出为 220px 完整侧栏(覆盖主区,不挤内容);用户可点底部按钮常驻展开。
 * 激活态:accent-soft 底 + accent 文字 + 2px 左信号条;折叠态由 .app-shell.is-collapsed 驱动。
 */
export function Sidebar({
  items,
  current,
  onSelect,
  onItemIntent,
  account,
  onLogout,
  collapsed,
  onToggleCollapse,
}: SidebarProps) {
  return (
    <aside className="app-sidebar" role="navigation" aria-label="主导航">
      <div className="app-sidebar-logo">
        <span className="app-sidebar-logo-dot" aria-hidden="true" />
        <span className="app-sidebar-logo-text">ToIV</span>
      </div>

      <nav className="app-sidebar-nav">
        {items.map((item) => {
          const active = item.key === current;
          return (
            <button
              key={item.key}
              type="button"
              className={`app-sidebar-item${active ? " is-active" : ""}`}
              onClick={() => onSelect(item.key)}
              onMouseEnter={() => onItemIntent?.(item.key)}
              onFocus={() => onItemIntent?.(item.key)}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              title={collapsed ? item.label : undefined}
            >
              <span className="app-sidebar-icon">
                <Icon name={item.icon} size={18} />
              </span>
              <span className="app-sidebar-label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="app-sidebar-footer">
        {account && (
          <div className="app-sidebar-account">
            <span className="app-sidebar-account-avatar" aria-hidden="true">
              {account.charAt(0).toUpperCase()}
            </span>
            <span className="app-sidebar-account-email" title={account} translate="no">
              {account}
            </span>
            {onLogout && (
              <button
                type="button"
                className="app-sidebar-logout"
                onClick={onLogout}
                aria-label="退出登录"
                title="退出登录"
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          className="app-sidebar-collapse"
          onClick={onToggleCollapse}
          aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
          aria-expanded={!collapsed}
        >
          <span className="app-sidebar-icon">
            <Icon name={collapsed ? "chevron-right" : "chevron-left"} size={16} />
          </span>
          <span className="app-sidebar-collapse-label">{collapsed ? "展开" : "折叠"}</span>
        </button>
      </div>
    </aside>
  );
}

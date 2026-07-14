"use client";

import Link from "next/link";

import { Icon, type IconName } from "@/components/ui/Icon";

export interface SidebarView {
  key: string;
  label: string;
  icon: IconName;
  /** 分组:dialog(对话流)/tool(工具画布)/asset(能力中心) */
  group: "dialog" | "tool" | "asset";
}

interface SidebarProps {
  views: SidebarView[];
  current: string;
  onSelect: (key: string) => void;
  account?: string | null;
  onLogout?: () => void;
}

/** 64px 纯图标侧栏 —— Runway / Kling 风格,按 3 种模式分组。 */
export function Sidebar({
  views,
  current,
  onSelect,
  account,
  onLogout,
}: SidebarProps) {
  const groups: Record<"dialog" | "tool" | "asset", SidebarView[]> = {
    dialog: [],
    tool: [],
    asset: [],
  };
  for (const v of views) groups[v.group].push(v);
  const groupOrder = ["dialog", "tool", "asset"] as const;

  return (
    <aside className="app-sidebar" role="navigation" aria-label="主导航">
      <div className="app-sidebar-scroll">
        {groupOrder.map((g, gi) => (
          <div key={g} className="app-sidebar-group">
            {groups[g].map((view) => {
              const active = view.key === current;
              return (
                <Link
                  key={view.key}
                  href={`/?view=${view.key}`}
                  className={`app-sidebar-item${active ? " is-active" : ""}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
                    e.preventDefault();
                    onSelect(view.key);
                  }}
                  aria-current={active ? "page" : undefined}
                  aria-label={view.label}
                  title={view.label}
                >
                  <span className="app-sidebar-icon">
                    <Icon name={view.icon} size={20} />
                  </span>
                </Link>
              );
            })}
            {gi < groupOrder.length - 1 && groups[g].length > 0 && (
              <div className="app-sidebar-divider" aria-hidden="true" />
            )}
          </div>
        ))}
      </div>

      {account && (
        <div className="app-sidebar-footer">
          <div className="app-sidebar-account" title={account} translate="no">
            {account.charAt(0).toUpperCase()}
          </div>
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
    </aside>
  );
}

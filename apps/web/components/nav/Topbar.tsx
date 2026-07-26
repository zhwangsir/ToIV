"use client";

import { useState } from "react";

import { AgentSwitcher } from "@/components/ui/AgentSwitcher";
import { Icon } from "@/components/ui/Icon";
import { useTheme } from "@/hooks/useTheme";

interface TopbarProps {
  account?: string;
  onLogout: () => void;
  onMenuToggle?: () => void;
  menuOpen?: boolean;
  breadcrumb?: string[];
  subtitle?: string;
  onRightPanelToggle?: () => void;
  rightPanelOpen?: boolean;
}

export function Topbar({
  account,
  onLogout,
  onMenuToggle,
  menuOpen = false,
  breadcrumb,
  subtitle,
  onRightPanelToggle,
  rightPanelOpen,
}: TopbarProps) {
  const [menuOpenState, setMenuOpenState] = useState(false);
  const { mode, cycle } = useTheme();

  const themeIcon = mode === "light" ? "sun" : mode === "dark" ? "moon" : "monitor";
  const themeTitle = mode === "auto" ? "跟随系统" : mode === "light" ? "浅色模式" : "深色模式";

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="mobile-menu-toggle"
          onClick={() => onMenuToggle?.()}
          aria-label={menuOpen ? "关闭导航" : "打开导航"}
          aria-expanded={menuOpen}
        >
          <Icon name={menuOpen ? "close" : "menu"} size={18} />
        </button>

        <div className="topbar-title-wrap">
          {breadcrumb && breadcrumb.length > 0 ? (
            <nav className="topbar-breadcrumb" aria-label="面包屑">
              {breadcrumb.map((crumb, i) => (
                <span key={i} className="topbar-crumb">
                  {i > 0 && <span className="topbar-crumb-sep">/</span>}
                  {crumb}
                </span>
              ))}
            </nav>
          ) : (
            <h1 className="topbar-title">ToIV</h1>
          )}
          {subtitle && <p className="topbar-subtitle">{subtitle}</p>}
        </div>
      </div>

      <div className="topbar-right">
        <AgentSwitcher />

        <div className="model-badge" title="当前 LLM 大脑">
          <span className="model-badge-dot" aria-hidden="true" />
          <span className="model-badge-label">GLM-5.2</span>
        </div>

        <button
          type="button"
          className="theme-toggle"
          onClick={cycle}
          title={themeTitle}
          aria-label={`切换主题（当前：${themeTitle}）`}
        >
          <Icon name={themeIcon} size={16} />
        </button>

        {onRightPanelToggle && (
          <button
            type="button"
            className={`theme-toggle${rightPanelOpen ? " is-active" : ""}`}
            onClick={onRightPanelToggle}
            title={rightPanelOpen ? "隐藏属性面板" : "显示属性面板"}
            aria-label={rightPanelOpen ? "隐藏属性面板" : "显示属性面板"}
          >
            <Icon name="panel-right" size={16} />
          </button>
        )}

        {account && (
          <div
            className={`topbar-account-btn${menuOpenState ? " is-open" : ""}`}
            onClick={() => setMenuOpenState((v) => !v)}
            onBlur={() => setMenuOpenState(false)}
            tabIndex={0}
          >
            <span className="topbar-account-avatar">
              {account.charAt(0).toUpperCase()}
            </span>
            <span className="topbar-account-email">{account}</span>
            {menuOpenState && (
              <button
                type="button"
                className="btn btn-ghost btn-sm topbar-logout-btn"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onLogout();
                }}
              >
                退出
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

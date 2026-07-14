"use client";

import { useState } from "react";

import { AgentSwitcher } from "@/components/ui/AgentSwitcher";
import { Icon } from "@/components/ui/Icon";

interface TopbarProps {
  account?: string;
  onLogout: () => void;
  onMenuToggle?: () => void;
  menuOpen?: boolean;
  /** 面包屑路径 */
  breadcrumb?: string[];
  subtitle?: string;
}

/** 顶栏 52px —— 左面包屑 + 右模型徽章 + 账户菜单。
 * NSFW 专区(/nsfw)仅通过地址栏直链访问,不出现在顶栏入口。 */
export function Topbar({
  account,
  onLogout,
  onMenuToggle,
  menuOpen = false,
  breadcrumb,
  subtitle,
}: TopbarProps) {
  const [menuOpenState, setMenuOpenState] = useState(false);

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
        {/* 全局默认智能体切换器:顶栏常驻,任何视图可切。
            只列 SFW 智能体(NSFW 智能体仅在 /nsfw 专页下展示)。 */}
        <AgentSwitcher />

        <div className="model-badge" title="当前 LLM 大脑">
          <span className="model-badge-dot" aria-hidden="true" />
          <span className="model-badge-label">GLM-5.2</span>
        </div>

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
                className="btn btn-ghost btn-sm"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onLogout();
                }}
                style={{ marginLeft: "0.3rem" }}
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

"use client";

import { ReactNode } from "react";

export interface TabItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

interface TabsProps {
  items: TabItem[];
  current: string;
  onChange: (key: string) => void;
  /** 撑满容器宽度(默认自适应) */
  fill?: boolean;
  ariaLabel?: string;
}

/** 段控式 Tabs:激活段 bg-surface-3 浮起,容器 bg-surface-1 + border-subtle。 */
export function Tabs({ items, current, onChange, fill = false, ariaLabel }: TabsProps) {
  return (
    <div className={`ui-tabs${fill ? " is-fill" : ""}`} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const active = item.key === current;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            className={`ui-tab${active ? " is-active" : ""}`}
            onClick={() => onChange(item.key)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        );
      })}
      <style jsx>{`
        .ui-tabs {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          padding: 3px;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .ui-tabs.is-fill {
          display: flex;
          width: 100%;
        }
        .ui-tabs.is-fill .ui-tab {
          flex: 1;
          justify-content: center;
        }
        .ui-tab {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-1) var(--space-3);
          height: 28px;
          border-radius: var(--radius-sm);
          color: var(--text-secondary);
          font-size: var(--text-sm);
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: background-color var(--duration-fast) var(--ease-standard),
                      color var(--duration-fast) var(--ease-standard);
        }
        .ui-tab:hover:not(:disabled):not(.is-active) {
          color: var(--text-primary);
        }
        .ui-tab.is-active {
          background: var(--bg-surface-3);
          color: var(--text-primary);
          box-shadow: inset 0 0 0 1px var(--border-subtle);
        }
        .ui-tab:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}

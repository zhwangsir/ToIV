"use client";

import { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

interface EmptyProps {
  icon?: IconName;
  title: string;
  desc?: string;
  /** 可选操作(通常一个 Button) */
  action?: ReactNode;
}

/** 空态:图标 + 标题 + 描述 + 可选操作。样式复用全局 .empty-state。 */
export function Empty({ icon, title, desc, action }: EmptyProps) {
  return (
    <div className="empty-state">
      {icon && (
        <div className="empty-state-icon">
          <Icon name={icon} size={48} />
        </div>
      )}
      <h3 className="empty-state-title">{title}</h3>
      {desc && <p className="empty-state-desc">{desc}</p>}
      {action && <div style={{ marginTop: "var(--space-4)" }}>{action}</div>}
    </div>
  );
}

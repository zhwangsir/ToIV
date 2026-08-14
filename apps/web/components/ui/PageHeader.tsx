"use client";

import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

interface PageHeaderProps {
  /** 标题(左侧,大标题层级) */
  title: ReactNode;
  /** 副标题(可选,muted 辅助说明) */
  desc?: ReactNode;
  /** 标题前图标(可选) */
  icon?: IconName;
  /** 右侧操作槽(按钮组等) */
  actions?: ReactNode;
  className?: string;
}

/**
 * 统一页头:把各视图手抄的 .page-header 结构组件化。
 * 版型 = 左标题+副标题 / 右操作槽,对齐 globals.css 页头类。
 */
export function PageHeader({ title, desc, icon, actions, className }: PageHeaderProps) {
  return (
    <header className={["page-header", className].filter(Boolean).join(" ")}>
      <div>
        <h1 className="page-header-title">
          {icon && <Icon name={icon} size={20} className="ui-page-header-icon" />}
          {title}
        </h1>
        {desc && <p className="page-header-desc">{desc}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

"use client";

import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

interface PageHeaderProps {
  /** 标题(左侧,大标题层级) */
  title: ReactNode;
  /** 副标题(可选,muted 辅助说明;compact 模式下不渲染) */
  desc?: ReactNode;
  /** 标题前图标(可选) */
  icon?: IconName;
  /** 拉丁/小型大写铭牌(可选,Atelier masthead:标题上方的 kicker 行;compact 模式下不渲染) */
  kicker?: string;
  /** 右侧操作槽(按钮组等) */
  actions?: ReactNode;
  /** 紧凑模式(2026-08-18):工具化页头——只留标题与 actions 单行居中,
   *  隐藏 kicker/desc/编辑双线,留白收紧。工作台类视图(生成/编辑)把首屏还给内容。 */
  compact?: boolean;
  /** 返回上一级(2026-08-29:融合二级页统一「‹ 返回融合」);渲染在 kicker 上方 */
  onBack?: () => void;
  /** 返回按钮文案(默认「返回」) */
  backLabel?: string;
  className?: string;
}

/**
 * 统一页头:把各视图手抄的 .page-header 结构组件化。
 * 版型 = 左标题+副标题 / 右操作槽,对齐 globals.css 页头类。
 * kicker 传入时在标题上方渲染小型大写铭牌(Film Atelier masthead)。
 */
export function PageHeader({ title, desc, icon, kicker, actions, compact, onBack, backLabel = "返回", className }: PageHeaderProps) {
  return (
    <header
      className={["page-header", compact ? "is-compact" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="page-header-text">
        {onBack && (
          <button type="button" className="page-header-back" onClick={onBack}>
            <Icon name="chevron-left" size={13} /> {backLabel}
          </button>
        )}
        {!compact && kicker && <span className="page-header-kicker">{kicker}</span>}
        <h1 className="page-header-title">
          {icon && <Icon name={icon} size={compact ? 16 : 20} className="ui-page-header-icon" />}
          {title}
        </h1>
        {!compact && desc && <p className="page-header-desc">{desc}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

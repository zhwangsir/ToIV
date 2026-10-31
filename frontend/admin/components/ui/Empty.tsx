"use client";

import { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

/** 空态档位(2026-09-04 美化 W1 三档共享空态,样式见 globals.css at 系):
 *  stage  = 舞台/主内容区大卡:线稿感图标(28px 琥珀描边)+ Fraunces 斜体一句 + 主行动槽;
 *  section= 段落/面板内:图标 + 一行标题(+可选描述);
 *  inline = 列表内(默认):纯一行 muted 文案,兼容旧调用不破坏现有视图。 */
export type EmptySize = "stage" | "section" | "inline";

interface EmptyProps {
  size?: EmptySize;
  icon?: IconName;
  title: string;
  desc?: string;
  /** 可选操作(通常一个 Button) */
  action?: ReactNode;
}

/** 空态:三档共享(样式走 globals.css 的 .at-empty--stage/--section/--inline)。 */
export function Empty({ size = "inline", icon, title, desc, action }: EmptyProps) {
  if (size === "stage") {
    return (
      <div className="at-empty--stage">
        {icon && (
          <div className="at-empty-icon">
            <Icon name={icon} size={28} strokeWidth={1.5} />
          </div>
        )}
        <h3 className="at-empty-title">{title}</h3>
        {desc && <p className="at-empty-desc">{desc}</p>}
        {action && <div className="at-empty-action">{action}</div>}
      </div>
    );
  }
  if (size === "section") {
    return (
      <div className="at-empty--section">
        {icon && (
          <div className="at-empty-icon">
            <Icon name={icon} size={20} strokeWidth={1.5} />
          </div>
        )}
        <h3 className="at-empty-title">{title}</h3>
        {desc && <p className="at-empty-desc">{desc}</p>}
        {action && <div className="at-empty-action">{action}</div>}
      </div>
    );
  }
  return (
    <div className="at-empty--inline">
      <span>
        {title}
        {desc ? ` · ${desc}` : ""}
      </span>
      {action && <span className="at-empty-action">{action}</span>}
    </div>
  );
}

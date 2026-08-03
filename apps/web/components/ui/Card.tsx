"use client";

import { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** hover 时描边加强 + 浮起 */
  hoverable?: boolean;
  children?: ReactNode;
}

/** 卡片/面板基座:bg-surface-1 + border-subtle + radius-panel(12px)。 */
export function Card({ hoverable = false, className, children, ...rest }: CardProps) {
  const classes = ["card", hoverable ? "card-hover" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

/** Panel 与 Card 同型,语义上用于区块容器(参数栏/侧栏面板等)。 */
export function Panel(props: CardProps) {
  return <Card {...props} />;
}

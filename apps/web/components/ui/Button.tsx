"use client";

import { ButtonHTMLAttributes, ReactNode } from "react";

import { Icon } from "./Icon";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

/**
 * 统一按钮基座(Obsidian token)。
 * variant: primary(accent CTA)/ secondary(默认面板色)/ ghost(无框)/ danger(危险)。
 * size: sm(26px)/ md(默认)。五态由全局 .btn CSS 承载(default/hover/active/focus/disabled)。
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  children,
  className,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    VARIANT_CLASS[variant],
    size === "sm" ? "btn-sm" : "",
    loading ? "is-loading" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <Icon name="loading" size={14} /> : icon}
      {children}
    </button>
  );
}

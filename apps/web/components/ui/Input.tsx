"use client";

import {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

interface FieldProps {
  /** 字段标签(11/500 大写档位) */
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

/** 表单字段容器:标签 + 控件 + 提示/错误。 */
export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <label className="ui-field">
      {label && <span className="ui-field-label">{label}</span>}
      {children}
      {error ? (
        <span className="ui-field-error">{error}</span>
      ) : hint ? (
        <span className="ui-field-hint">{hint}</span>
      ) : null}
      <style jsx>{`
        .ui-field {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .ui-field-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
        }
        .ui-field-hint {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .ui-field-error {
          font-size: var(--text-aux);
          color: var(--err);
        }
      `}</style>
    </label>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** 文本输入:bg-surface-3 + focus accent 描边(样式在全局 .input)。 */
export function Input({ className, ...rest }: InputProps) {
  return <input className={["input", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea className={["input", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={["input", className ?? ""].filter(Boolean).join(" ")} {...rest}>
      {children}
    </select>
  );
}

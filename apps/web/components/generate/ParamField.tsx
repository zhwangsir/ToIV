"use client";

import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import type { EngineParam } from "@/lib/engines";

interface ParamFieldProps {
  param: EngineParam;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

/**
 * 动态参数渲染器:由引擎 params schema 驱动,把 text/textarea/number/select/switch
 * 映射到 W0 ui 基座组件(images 类型由 RefImageUpload 单独承载,不在此渲染)。
 * 数值参数以原始字符串保存,提交时才 parse(允许输入中间态,如 "10.")。
 */
export function ParamField({ param, value, onChange, disabled }: ParamFieldProps) {
  const set = (v: unknown) => onChange(param.key, v);

  switch (param.type) {
    case "textarea":
      return (
        <Field label={param.label} hint={param.hint}>
          <Textarea
            rows={2}
            value={String(value ?? "")}
            placeholder={param.hint}
            disabled={disabled}
            onChange={(e) => set(e.target.value)}
          />
        </Field>
      );
    case "text":
      return (
        <Field label={param.label} hint={param.hint}>
          <Input
            type="text"
            value={String(value ?? "")}
            placeholder={param.hint}
            disabled={disabled}
            onChange={(e) => set(e.target.value)}
          />
        </Field>
      );
    case "number":
      return (
        <Field label={param.label} hint={param.hint}>
          <Input
            type="number"
            min={param.min}
            max={param.max}
            step={param.step ?? 1}
            value={String(value ?? "")}
            disabled={disabled}
            onChange={(e) => set(e.target.value)}
          />
        </Field>
      );
    case "select":
      return (
        <Field label={param.label} hint={param.hint}>
          <Select
            value={String(value ?? "")}
            disabled={disabled}
            onChange={(e) => set(e.target.value)}
          >
            {(param.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "switch":
      return (
        <Field label={param.label} hint={param.hint}>
          <span>
            <Switch
              checked={Boolean(value)}
              onChange={set}
              disabled={disabled}
              ariaLabel={param.label}
            />
          </span>
        </Field>
      );
    default:
      return null;
  }
}

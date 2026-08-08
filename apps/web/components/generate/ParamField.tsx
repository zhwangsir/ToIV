"use client";

import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import type { EngineParam, LoraValue } from "@/lib/engines";

interface ParamFieldProps {
  param: EngineParam;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

/**
 * 动态参数渲染器:由引擎 params schema 驱动,把 text/textarea/number/select/switch/loras
 * 映射到 W0 ui 基座组件(images 类型由 RefImageUpload 单独承载,不在此渲染)。
 * 数值参数以原始字符串保存,提交时才 parse(允许输入中间态,如 "10.")。
 */
export function ParamField({ param, value, onChange, disabled }: ParamFieldProps) {
  const set = (v: unknown) => onChange(param.key, v);

  switch (param.type) {
    case "loras": {
      // LoRA 多选 + 单项强度滑杆:值为 LoraValue[](未选 = 空数组,后端不加 LoRA)
      const selected: LoraValue[] = Array.isArray(value) ? (value as LoraValue[]) : [];
      const strengthOf = (name: string) =>
        selected.find((l) => l.name === name)?.strength ?? 0.6;
      const toggle = (name: string, on: boolean) => {
        if (on) {
          set([...selected, { name, strength: 0.6 }]);
        } else {
          set(selected.filter((l) => l.name !== name));
        }
      };
      const setStrength = (name: string, strength: number) => {
        set(selected.map((l) => (l.name === name ? { ...l, strength } : l)));
      };
      const min = param.min ?? 0.5;
      const max = param.max ?? 1.0;
      const step = param.step ?? 0.05;
      return (
        <Field label={param.label} hint={param.hint}>
          <div className="lora-picker">
            {(param.options ?? []).length === 0 ? (
              <span className="lora-picker-empty">引擎实例上暂无可用 LoRA</span>
            ) : (
              (param.options ?? []).map((o) => {
                const on = selected.some((l) => l.name === o.value);
                return (
                  <div key={o.value} className="lora-picker-item">
                    <label className="lora-picker-row">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={disabled}
                        onChange={(e) => toggle(o.value, e.target.checked)}
                      />
                      <span className="lora-picker-name" title={o.value}>
                        {o.label}
                      </span>
                      {o.nsfw && <span className="lora-picker-nsfw">R18</span>}
                    </label>
                    {on && (
                      <label className="lora-picker-strength">
                        <input
                          type="range"
                          min={min}
                          max={max}
                          step={step}
                          value={strengthOf(o.value)}
                          disabled={disabled}
                          onChange={(e) => setStrength(o.value, Number(e.target.value))}
                          aria-label={`${o.label} 强度`}
                        />
                        <span className="lora-picker-strength-val">
                          {strengthOf(o.value).toFixed(2)}
                        </span>
                      </label>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Field>
      );
    }
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

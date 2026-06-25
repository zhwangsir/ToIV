"use client";

/** 统一模型选择器(Studio Noir 暗房风,品紫聚焦环)。
 *
 *  三处共享(create / canvas 节点 / manju):各处仍自管模型数据获取、选中状态、
 *  NSFW 过滤与 mode 感知,这里只负责「把下拉渲染一致」。
 *
 *  - 原生 <select>:键盘可达、暗/亮双主题一致、品紫聚焦环。
 *  - 文件名去 .safetensors/.ckpt/.pt 后缀展示。
 *  - nsfwSet 命中时给选项与当前值挂一个 18+ 小角标(纯展示,不改任何过滤逻辑)。 */

import { useId } from "react";

/** 去掉 .safetensors / .ckpt / .pt 后缀的展示名。 */
function cleanModelName(name: string): string {
  return name.replace(/\.(safetensors|ckpt|pt)$/i, "");
}

interface ModelPickerProps {
  /** 可选模型文件名列表(过滤/mode 感知由调用方处理后传入)。 */
  models: string[];
  /** 当前选中的模型文件名。 */
  value: string;
  /** 选中变化回调。 */
  onChange: (value: string) => void;
  /** 字段标签;省略则不渲染 label 行。 */
  label?: string;
  /** 禁用态。 */
  disabled?: boolean;
  /** 空列表时的占位选项文案(默认「默认模型」)。 */
  placeholder?: string;
  /** 成人向模型文件名集合;命中则挂 18+ 角标(纯展示)。 */
  nsfwSet?: Set<string>;
}

/** Studio Noir 统一模型下拉。 */
export function ModelPicker({
  models,
  value,
  onChange,
  label,
  disabled = false,
  placeholder = "默认模型",
  nsfwSet,
}: ModelPickerProps) {
  const selectId = useId();
  const isEmpty = models.length === 0;
  // 当前选中模型是否为成人向(挂可视角标);仅当 nsfwSet 提供且命中。
  const valueIsNsfw = !!nsfwSet?.has(value);

  return (
    <div className="model-picker">
      {label && (
        <label className="model-picker__label" htmlFor={selectId}>
          {label}
        </label>
      )}
      <div className={`model-picker__control${valueIsNsfw ? " is-nsfw" : ""}`}>
        <select
          id={selectId}
          className="model-picker__select"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {isEmpty && <option value="">{placeholder}</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {cleanModelName(m)}
              {nsfwSet?.has(m) ? "  · 18+" : ""}
            </option>
          ))}
        </select>
        {valueIsNsfw && (
          <span className="model-picker__badge" aria-hidden="true">
            18+
          </span>
        )}
      </div>
    </div>
  );
}

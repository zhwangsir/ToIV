"use client";

import { useRef, useState } from "react";

import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { EngineParam, LoraValue } from "@/lib/engines";

import { RefAudioUpload, type UploadedAudio } from "./RefAudioUpload";
import { RefImageUpload, type UploadedRef } from "./RefImageUpload";
import { RefImagesUpload } from "./RefImagesUpload";
import { RefVideoUpload, type UploadedVideo } from "./RefVideoUpload";

interface ParamFieldProps {
  param: EngineParam;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  /** 上传路由 kind(应用运行页传入;生成页 images 仍由 GenerateView 独立承载)。 */
  uploadKind?: string;
  /** 钉到已上传媒体所在 worker(多槽互钉,避免跨机取不到文件)。 */
  pinWorker?: string | null;
}

type MediaHandle = { filename: string; worker?: string; name?: string; previewUrl?: string };

/** 表单值 → 已上传句柄列表(兼容 string / string[] / 句柄对象,提交前由 buildRunValues 抽 filename)。 */
function asMediaList<T extends MediaHandle>(value: unknown): T[] {
  if (value == null || value === "") return [];
  const items = Array.isArray(value) ? value : [value];
  const out: T[] = [];
  for (const item of items) {
    if (typeof item === "string" && item.trim()) {
      out.push({ filename: item.trim(), worker: "", name: item.trim(), previewUrl: "" } as T);
    } else if (item && typeof item === "object" && typeof (item as MediaHandle).filename === "string") {
      const h = item as MediaHandle;
      out.push({ ...h, name: h.name || h.filename, previewUrl: h.previewUrl || "" } as T);
    }
  }
  return out;
}

function asImageRefs(value: unknown): UploadedRef[] {
  return asMediaList<UploadedRef>(value);
}

/**
 * 动态参数渲染器:由引擎 params schema 驱动,把 text/textarea/number/select/switch/loras
 * 以及 images/audio/video 映射到 W0 基座 / 既有 Ref*Upload。
 * 生成页仍把 images 从分组里剔除、由 GenerateView 独立承载;应用运行页走此组件上传。
 * 数值参数以原始字符串保存,提交时才 parse(允许输入中间态,如 "10.");
 * 失焦按 min/max/step 钳位 + 红字提示(2026-08-30,此前非法输入静默回落)。
 */
export function ParamField({ param, value, onChange, disabled, uploadKind = "img2img", pinWorker }: ParamFieldProps) {
  const set = (v: unknown) => onChange(param.key, v);
  // 数值参数失焦校验提示(Field error 槽,红字)
  const [numError, setNumError] = useState<string | null>(null);
  // 引擎 textarea 参数自动增高(无上限;非 textarea 类型 ref 为空,hook 自动空转)
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(taRef, param.type === "textarea" ? String(value ?? "") : "");

  /** 数值失焦:按 min/max/step 钳位并红字提示;seed 须非负整数(留空随机)。 */
  const onNumberBlur = () => {
    const raw = String(value ?? "").trim();
    if (!raw) {
      // 空值:seed 留空 = 随机(合法);其余回退默认,防提交时静默回落
      setNumError(null);
      if (param.key !== "seed" && typeof param.default === "number") set(param.default);
      return;
    }
    const n = Number(raw);
    if (param.key === "seed") {
      if (!Number.isInteger(n) || n < 0) {
        set(typeof param.default === "number" ? param.default : null);
        setNumError("随机种子须为非负整数(留空则随机),已重置");
      } else {
        setNumError(null);
        if (String(n) !== raw) set(n); // "042"/"42.0" 归一
      }
      return;
    }
    if (!Number.isFinite(n)) {
      set(typeof param.default === "number" ? param.default : "");
      setNumError("请输入有效数字,已重置为默认值");
      return;
    }
    let clamped = n;
    const notes: string[] = [];
    if (typeof param.min === "number" && clamped < param.min) {
      clamped = param.min;
      notes.push(`已按下限 ${param.min} 调整`);
    }
    if (typeof param.max === "number" && clamped > param.max) {
      clamped = param.max;
      notes.push(`已按上限 ${param.max} 调整`);
    }
    const step = typeof param.step === "number" && param.step > 0 ? param.step : null;
    if (step) {
      const base = typeof param.min === "number" ? param.min : 0;
      // toFixed(6) 消除浮点噪声(0.1 步长等)
      const snapped = Number((base + Math.round((clamped - base) / step) * step).toFixed(6));
      if (snapped !== clamped) {
        clamped = snapped;
        notes.push(`已按步长 ${step} 对齐`);
      }
    }
    if (clamped !== n) set(clamped);
    else if (String(n) !== raw) set(n); // "10.0" → 10 归一
    setNumError(notes.length > 0 ? notes.join(";") : null);
  };

  switch (param.type) {
    case "loras": {
      // LoRA:null/省略 = AI 选配; [] = 关闭; 非空 = 钉选。勾选上限 3。
      const LORA_CAP = 3;
      const isOff = Array.isArray(value) && (value as LoraValue[]).length === 0;
      const selected: LoraValue[] = Array.isArray(value) && !isOff ? (value as LoraValue[]) : [];
      const isAuto = !isOff && selected.length === 0;
      const strengthOf = (name: string) =>
        selected.find((l) => l.name === name)?.strength ?? 0.6;
      const toggle = (name: string, on: boolean) => {
        if (on) {
          if (selected.length >= LORA_CAP) return;
          set([...selected, { name, strength: 0.6 }]);
        } else {
          const next = selected.filter((l) => l.name !== name);
          set(next.length > 0 ? next : null); // 取消最后一项回到 AI 选配
        }
      };
      const setStrength = (name: string, strength: number) => {
        set(selected.map((l) => (l.name === name ? { ...l, strength } : l)));
      };
      const min = param.min ?? 0.5;
      const max = param.max ?? 1.0;
      const step = param.step ?? 0.05;
      const atCap = selected.length >= LORA_CAP;
      return (
        <Field label={param.label} hint={param.hint}>
          <div className="lora-picker">
            <div className="lora-picker-mode" role="group" aria-label="LoRA 模式">
              <button
                type="button"
                className={isAuto ? "is-on" : ""}
                disabled={disabled}
                onClick={() => set(null)}
              >
                AI 选配
              </button>
              <button
                type="button"
                className={isOff ? "is-on" : ""}
                disabled={disabled}
                onClick={() => set([])}
              >
                关闭
              </button>
            </div>
            {(param.options ?? []).length === 0 ? (
              <span className="lora-picker-empty">
                {isOff ? "不叠加 LoRA" : "当前无 LoRA 可选,提交时由 AI 选配"}
              </span>
            ) : (
              (param.options ?? []).map((o) => {
                const on = selected.some((l) => l.name === o.value);
                return (
                  <div key={o.value} className="lora-picker-item">
                    <label className="lora-picker-row">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={disabled || (!on && atCap)}
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
            {isAuto && (param.options ?? []).length > 0 && (
              <span className="lora-picker-empty">AI 选配(提交时从策划卡自动挂载);点选最多 3 个即固定</span>
            )}
            {isOff && (param.options ?? []).length > 0 && (
              <span className="lora-picker-empty">已关闭,不叠加 LoRA</span>
            )}
          </div>
        </Field>
      );
    }
    case "textarea":
      return (
        <Field label={param.label} hint={param.hint}>
          <Textarea
            ref={taRef}
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
        <Field label={param.label} hint={param.hint} error={numError ?? undefined}>
          <Input
            type="number"
            min={param.min}
            max={param.max}
            step={param.step ?? 1}
            value={String(value ?? "")}
            disabled={disabled}
            onBlur={onNumberBlur}
            onChange={(e) => {
              setNumError(null);
              set(e.target.value);
            }}
          />
        </Field>
      );
    case "select": {
      // 命中模型百科卡片的选项带一句话简介(desc):选中后展示在下拉下方,
      // 解决底模列表「全是裸文件名看不出谁是谁」的问题。
      const selectedOpt = (param.options ?? []).find(
        (o) => o.value === String(value ?? ""),
      );
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
          {selectedOpt?.desc && (
            <span style={{ fontSize: "var(--text-aux)", color: "var(--text-muted)" }}>
              {selectedOpt.desc}
            </span>
          )}
        </Field>
      );
    }
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
    case "images": {
      const max = param.max ?? 1;
      const refs = asImageRefs(value);
      if (max > 1) {
        return (
          <RefImagesUpload
            param={param}
            values={refs}
            uploadKind={uploadKind}
            pinWorker={pinWorker}
            disabled={disabled}
            onChange={(v) => set(v)}
          />
        );
      }
      return (
        <RefImageUpload
          param={param}
          value={refs[0] ?? null}
          uploadKind={uploadKind}
          pinWorker={pinWorker}
          disabled={disabled}
          onChange={(v) => set(v ? [v] : [])}
        />
      );
    }
    case "video": {
      const max = param.max ?? 1;
      const items = asMediaList<UploadedVideo>(value);
      const pin = pinWorker ?? items[0]?.worker ?? null;
      if (max <= 1) {
        return (
          <RefVideoUpload
            param={param}
            value={items[0] ?? null}
            uploadKind={uploadKind}
            pinWorker={pin}
            disabled={disabled}
            onChange={(v) => set(v ? [v] : [])}
          />
        );
      }
      return (
        <>
          {items.map((item, i) => (
            <RefVideoUpload
              key={`${item.filename}-${i}`}
              param={{ ...param, label: `${param.label} ${i + 1}` }}
              value={item}
              uploadKind={uploadKind}
              pinWorker={pin}
              disabled={disabled}
              onChange={(v) => {
                const next = items.slice();
                if (v) next[i] = v;
                else next.splice(i, 1);
                set(next);
              }}
            />
          ))}
          {items.length < max && (
            <RefVideoUpload
              param={{
                ...param,
                label: items.length === 0 ? param.label : `${param.label} ${items.length + 1}`,
              }}
              value={null}
              uploadKind={uploadKind}
              pinWorker={pin}
              disabled={disabled}
              onChange={(v) => {
                if (v) set([...items, v]);
              }}
            />
          )}
        </>
      );
    }
    case "audio": {
      const max = param.max ?? 1;
      const items = asMediaList<UploadedAudio>(value);
      const pin = pinWorker ?? items[0]?.worker ?? null;
      if (max <= 1) {
        return (
          <RefAudioUpload
            param={param}
            value={items[0] ?? null}
            uploadKind={uploadKind}
            pinWorker={pin}
            disabled={disabled}
            onChange={(v) => set(v ? [v] : [])}
          />
        );
      }
      return (
        <>
          {items.map((item, i) => (
            <RefAudioUpload
              key={`${item.filename}-${i}`}
              param={{ ...param, label: `${param.label} ${i + 1}` }}
              value={item}
              uploadKind={uploadKind}
              pinWorker={pin}
              disabled={disabled}
              onChange={(v) => {
                const next = items.slice();
                if (v) next[i] = v;
                else next.splice(i, 1);
                set(next);
              }}
            />
          ))}
          {items.length < max && (
            <RefAudioUpload
              param={{
                ...param,
                label: items.length === 0 ? param.label : `${param.label} ${items.length + 1}`,
              }}
              value={null}
              uploadKind={uploadKind}
              pinWorker={pin}
              disabled={disabled}
              onChange={(v) => {
                if (v) set([...items, v]);
              }}
            />
          )}
        </>
      );
    }
    default:
      return null;
  }
}

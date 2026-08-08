"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Select } from "@/components/ui/Input";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { ReverseButton } from "@/components/ui/ReverseButton";
import type { EngineInfo, EngineParam } from "@/lib/engines";

import { ParamField } from "./ParamField";

interface PromptBarProps {
  /** 当前提示词(状态由 GenerateView 按引擎分槽持有,此处受控展示)。 */
  value: string;
  onChange: (v: string) => void;
  /** 生成中禁用输入(沿用旧 Textarea 语义)。 */
  disabled?: boolean;
  /** 当前解析出的引擎(null = 列表未加载/无可用)。 */
  engine: EngineInfo | null;
  /** 当前分组可见引擎列表(chip 展开的选择控件数据源)。 */
  engines: EngineInfo[];
  onEngineChange: (id: string) => void;
  /** 尺寸参数(width/height);两项都存在时以 chip 吸附在条内,否则空数组不渲染。 */
  sizeParams: EngineParam[];
  values: Record<string, unknown>;
  onValueChange: (key: string, v: unknown) => void;
  /** OptimizeButton 的 kind 映射(image/image_edit/video/audio)。 */
  optimizeKind: string;
  onOptimized: (text: string, negative?: string) => void;
  canSubmit: boolean;
  isRunning: boolean;
  submitting: boolean;
  submitError: string | null;
  onGenerate: () => void;
  onCancel: () => void;
}

/**
 * 提示词条(WS2):底部居中悬浮玻璃条。
 * - 自动增高 textarea(值变化时重算 height,CSS max-height 160px 封顶)
 * - 引擎/尺寸以可拆卸 chips 吸附在条内:只读展示当前值,点击展开原有选择控件
 * - OptimizeButton 入口保留,优化结果经 onOptimized 直接回填条内文本
 * - 生成/取消按钮迁入条内(原参数栏 actions 下移动,语义不变)
 * 全部样式在 app/styles/stage.css(玻璃材质 --glass-* + 聚焦上浮/呼吸)。
 */
export function PromptBar({
  value,
  onChange,
  disabled = false,
  engine,
  engines,
  onEngineChange,
  sizeParams,
  values,
  onValueChange,
  optimizeKind,
  onOptimized,
  canSubmit,
  isRunning,
  submitting,
  submitError,
  onGenerate,
  onCancel,
}: PromptBarProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [openChip, setOpenChip] = useState<"engine" | "size" | null>(null);

  // 自动增高:先收回 auto 再按 scrollHeight 撑开(超过 160px 由 CSS 截断出滚动条)
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);

  // chip 展开态收敛:Esc 收起(点击条内输入区见 promptbar-input-row onClick)
  useEffect(() => {
    if (!openChip) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenChip(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openChip]);

  const sizeLabel =
    sizeParams.length === 2
      ? `${String(values["width"] ?? "—")} × ${String(values["height"] ?? "—")}`
      : null;

  const toggleChip = (chip: "engine" | "size") =>
    setOpenChip((prev) => (prev === chip ? null : chip));

  return (
    <div className="promptbar-dock">
      <div className="promptbar">
        {submitError && <p className="promptbar-error">{submitError}</p>}

        <div className="promptbar-input-row" onClick={() => setOpenChip(null)}>
          <textarea
            ref={taRef}
            className="promptbar-textarea"
            rows={1}
            value={value}
            placeholder="描述想要生成的内容…"
            disabled={disabled}
            aria-label="提示词"
            onChange={(e) => onChange(e.target.value)}
          />
          {engine && (
            <OptimizeButton
              prompt={value}
              kind={optimizeKind}
              onOptimized={onOptimized}
              disabled={disabled}
            />
          )}
          {engine && (
            <ReverseButton onOptimized={onOptimized} disabled={disabled} />
          )}
          <div className="promptbar-actions">
            {isRunning && (
              <Button variant="ghost" onClick={onCancel}>
                取消
              </Button>
            )}
            <Button
              variant="primary"
              className={isRunning ? "generate-run" : undefined}
              loading={submitting}
              disabled={!canSubmit}
              icon={isRunning ? <Icon name="loading" size={14} /> : <Icon name="sparkles" size={14} />}
              onClick={onGenerate}
            >
              {isRunning ? "生成中…" : "生成"}
            </Button>
          </div>
        </div>

        <div className="promptbar-chips">
          <button
            type="button"
            className={`promptbar-chip${openChip === "engine" ? " is-open" : ""}`}
            onClick={() => toggleChip("engine")}
            aria-expanded={openChip === "engine"}
            aria-label="切换引擎"
            title="切换引擎"
          >
            <Icon name="cpu" size={12} />
            {engine ? engine.label : "选择引擎"}
            <Icon name="chevron-down" size={12} />
          </button>
          {sizeLabel && (
            <button
              type="button"
              className={`promptbar-chip${openChip === "size" ? " is-open" : ""}`}
              onClick={() => toggleChip("size")}
              aria-expanded={openChip === "size"}
              aria-label="调整尺寸"
              title="调整尺寸"
            >
              <Icon name="crop" size={12} />
              {sizeLabel}
              <Icon name="chevron-down" size={12} />
            </button>
          )}
        </div>

        {openChip === "engine" && (
          <div className="promptbar-chip-panel">
            {engines.length === 0 ? (
              <p className="promptbar-chip-hint">引擎列表加载中…</p>
            ) : (
              /* 玻璃包壳:去掉原生 select 外观,与玻璃剧场风格统一(chevron 纯装饰) */
              <div className="chip-select-wrap">
                <Select
                  value={engine?.id ?? ""}
                  onChange={(e) => {
                    onEngineChange(e.target.value);
                    setOpenChip(null);
                  }}
                  aria-label="选择引擎"
                >
                  {engines.map((e) => (
                    <option
                      key={e.id}
                      value={e.id}
                      disabled={!e.available}
                      title={e.available ? undefined : e.unavailable_reason}
                    >
                      {e.label}
                      {e.available ? "" : ` — 不可用:${e.unavailable_reason ?? "未知原因"}`}
                    </option>
                  ))}
                </Select>
                <span className="chip-select-caret" aria-hidden="true">
                  <Icon name="chevron-down" size={13} />
                </span>
              </div>
            )}
          </div>
        )}
        {openChip === "size" && sizeParams.length === 2 && (
          <div className="promptbar-chip-panel">
            {sizeParams.map((p) => (
              <ParamField
                key={p.key}
                param={p}
                value={values[p.key]}
                disabled={disabled}
                onChange={onValueChange}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

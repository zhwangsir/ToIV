"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Select } from "@/components/ui/Input";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { PromptWithEntities } from "@/components/ui/PromptWithEntities";
import { ReverseButton } from "@/components/ui/ReverseButton";
import { Ripple } from "@/components/ui/Ripple";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { EngineInfo, EngineParam } from "@/lib/engines";

import { ParamField } from "./ParamField";

interface PromptBarProps {
  /** 当前提示词(状态由 GenerateView 按引擎分槽持有,此处受控展示)。 */
  value: string;
  onChange: (v: string) => void;
  /** 生成中禁用输入(沿用旧 Textarea 语义)。 */
  disabled?: boolean;
  /** 外部聚焦句柄(T3 快速开始卡:点击后聚焦提示词框);内部自动增高 taRef 同步赋值。 */
  inputRef?: { current: HTMLTextAreaElement | null };
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
  /** 三层联动:当前选中的风格预设 id(优化时传后端注入预设上下文/方言) */
  stylePreset?: string;
  /** 三层联动:预设推荐的内置 skill id(OptimizeButton 智能预选,轻量可改) */
  recommendedSkill?: string;
  canSubmit: boolean;
  isRunning: boolean;
  submitting: boolean;
  submitError: string | null;
  /** 关闭提交错误条(受控:调用方清空 submitError;缺省为 no-op,仅 GenerateView 生产路径传入)。 */
  onClearError?: () => void;
  onGenerate: () => void;
  onCancel: () => void;
}

/**
 * 提示词条(WS2):底部居中悬浮玻璃条。
 * - 自动增高 textarea(scrollHeight 方案,40vh 宽松封顶,超出内滚不遮盖舞台)
 * - 引擎/尺寸以可拆卸 chips 吸附在条内:只读展示当前值,点击展开原有选择控件
 * - OptimizeButton 入口保留,优化结果经 onOptimized 直接回填条内文本
 * - 生成/取消按钮迁入条内(原参数栏 actions 下移动,语义不变)
 * 全部样式在 app/styles/stage.css(玻璃材质 --glass-* + 聚焦上浮/呼吸)。
 */
export function PromptBar({
  value,
  onChange,
  disabled = false,
  inputRef,
  engine,
  engines,
  onEngineChange,
  sizeParams,
  values,
  onValueChange,
  optimizeKind,
  onOptimized,
  stylePreset,
  recommendedSkill,
  canSubmit,
  isRunning,
  submitting,
  submitError,
  onClearError = () => {},
  onGenerate,
  onCancel,
}: PromptBarProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [openChip, setOpenChip] = useState<"engine" | "size" | null>(null);

  // 自动增高:scrollHeight 两段式(收到 auto 再撑开),40vh 封顶后框内滚动(不再外溢遮盖舞台)
  useAutoResize(taRef, value, { maxVh: 40 });

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
        {/* P1-2 收编:提交阶段异步错误走共享 ErrorBar(原自写 promptbar-error 文本) */}
        <ErrorBar message={submitError} onClose={onClearError} />

        <div className="promptbar-input-row" onClick={() => setOpenChip(null)}>
          {/* @主体引用(2026-08-26):输入 @ 弹主体选择器,插入 @实体名 后预览行显示
              图N 绑定 chip;实体库不可用时自动隐身,纯文本输入零影响。
              受控 value/onChange 语义与原 textarea 一致;taRef 经 inputRef 透传
              (自动增高 hook 不变) */}
          <PromptWithEntities
            inputRef={(el: HTMLTextAreaElement | null) => {
              taRef.current = el;
              if (inputRef) inputRef.current = el;
            }}
            className="promptbar-textarea"
            rows={1}
            value={value}
            placeholder="描述想要生成的内容…(⌘/Ctrl + Enter 快速生成;@ 引用主体)"
            disabled={disabled}
            ariaLabel="提示词"
            onChange={onChange}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter 快速生成(Enter 保留换行:提示词常多行);与 assistant/agent-runs 的键盘提交习惯对齐
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit && !submitting && !disabled) {
                e.preventDefault();
                onGenerate();
              }
            }}
          />
          {engine && (
            <OptimizeButton
              prompt={value}
              kind={optimizeKind}
              engine={engine.id}
              loras={
                Array.isArray(values.loras)
                  ? (values.loras as { name: string }[])
                      .map((l) => l?.name)
                      .filter((n): n is string => typeof n === "string")
                  : undefined
              }
              stylePreset={stylePreset}
              recommendedSkill={recommendedSkill}
              onOptimized={onOptimized}
              disabled={disabled}
            />
          )}
          {engine && (
            <ReverseButton onOptimized={onOptimized} disabled={disabled} />
          )}
          <div className="promptbar-actions">
            {isRunning && (
              /* 语义澄清:仅停止前端跟踪,后端作业继续(真取消需在结果面板作业卡操作) */
              <Button variant="ghost" onClick={onCancel} title="停止在当前页面跟踪进度,后端作业继续执行">
                停止跟踪
              </Button>
            )}
            {/* 生成主按钮(UI-A 动效原语):Ripple 纯叠加包裹,按钮既有样式/行为不变,
                reduced-motion 下自动退化为无波纹 */}
            <Ripple>
              <Button
                variant="primary"
                className={isRunning ? "promptbar-submit generate-run" : "promptbar-submit"}
                loading={submitting}
                disabled={!canSubmit}
                icon={isRunning ? <Icon name="loading" size={14} /> : <Icon name="sparkles" size={14} />}
                onClick={onGenerate}
              >
                {isRunning ? "生成中…" : "生成"}
              </Button>
            </Ripple>
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

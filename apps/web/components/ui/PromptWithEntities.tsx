"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import {
  entityKindLabel,
  entityThumbUrl,
  filterEntities,
  findActiveMention,
  insertMention,
  parseMentions,
  removeMention,
  useEntities,
  type EntityInfo,
  type EntityMention,
} from "@/lib/entities";

/**
 * 「已引用主体」预览行(chip 列表 + 绑定详情弹层):
 * - chip = @名字(图N),图N = 提及首次出现顺序(与后端 entity_ids → @图片N 绑定对应);
 * - 点击 chip 展开绑定详情(哪张图=哪个编号);× 删除 chip 同时经 onChange 移除文本中的引用。
 * 从 PromptWithEntities 抽出共用:助手输入框(自带 textarea)也复用本组件做预览。
 */
export function EntityRefsPreview({
  value,
  entities,
  onChange,
}: {
  value: string;
  entities: EntityInfo[];
  onChange: (v: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // chip 绑定详情展开态(实体 id;null = 收起)
  const [detailId, setDetailId] = useState<string | null>(null);

  /** 已解析提及(图N 编号源):实体清单尚未加载时为空,预览行自动隐藏。 */
  const mentions = useMemo(() => parseMentions(value, entities), [value, entities]);

  // 点击组件外 / Esc 收起详情
  useEffect(() => {
    if (detailId === null) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setDetailId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailId(null);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [detailId]);

  /** 删除 chip:同时移除文本中的 `@名字` 引用(吸收一个相邻分隔空格)。 */
  const removeChip = (m: EntityMention) => {
    onChange(removeMention(value, m));
    setDetailId((prev) => (prev === m.entity.id ? null : prev));
  };

  const detailMention = detailId ? mentions.find((m) => m.entity.id === detailId) : undefined;
  const detailIndex = detailMention ? mentions.indexOf(detailMention) : -1;

  if (mentions.length === 0) return null;

  return (
    <div className="pwe-wrap pwe-refs-wrap" ref={wrapRef}>
      <div className="pwe-refs" aria-label="已引用主体">
        <span className="pwe-refs-label">已引用主体:</span>
        {mentions.map((m, i) => (
          <span key={m.entity.id} className={`pwe-chip${detailId === m.entity.id ? " is-open" : ""}`}>
            <button
              type="button"
              className="pwe-chip-main"
              aria-expanded={detailId === m.entity.id}
              aria-label={`${m.entity.name}(图${i + 1}),查看绑定详情`}
              title="点击查看绑定详情"
              onClick={() => setDetailId((prev) => (prev === m.entity.id ? null : m.entity.id))}
            >
              @{m.entity.name}
              <span className="pwe-chip-idx">图{i + 1}</span>
            </button>
            <button
              type="button"
              className="pwe-chip-x"
              aria-label={`移除引用 ${m.entity.name}`}
              title="移除引用"
              onClick={() => removeChip(m)}
            >
              <Icon name="close" size={10} />
            </button>
          </span>
        ))}
      </div>

      {detailMention && (
        <div className="pwe-detail" role="dialog" aria-label={`主体绑定详情:${detailMention.entity.name}`}>
          {entityThumbUrl(detailMention.entity) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="pwe-detail-thumb" src={entityThumbUrl(detailMention.entity)} alt="" aria-hidden="true" />
          ) : (
            <span className="pwe-detail-thumb pwe-thumb-fallback" aria-hidden="true">
              <Icon name="user" size={16} />
            </span>
          )}
          <div className="pwe-detail-main">
            <div className="pwe-detail-title">
              {detailMention.entity.name}
              <span className="pwe-option-kind">{entityKindLabel(detailMention.entity.kind)}</span>
            </div>
            <div className="pwe-detail-desc">
              绑定为 图片{detailIndex + 1}(引用第 1 张参考图
              {detailMention.entity.imageCount > 1 ? `,共 ${detailMention.entity.imageCount} 张` : ""}
              );提交时按 @图片{detailIndex + 1} 注入提示词开头
            </div>
          </div>
          <button
            type="button"
            className="pwe-detail-remove"
            onClick={() => removeChip(detailMention)}
          >
            移除引用
          </button>
        </div>
      )}
    </div>
  );
}

interface PromptWithEntitiesProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** 外部句柄(聚焦/自动增高):回调 ref 或 RefObject,挂到内部真实 textarea 节点上。 */
  inputRef?:
    | ((el: HTMLTextAreaElement | null) => void)
    | { current: HTMLTextAreaElement | null };
  /** textarea 类名(复用宿主风格:promptbar-textarea / input 等)。 */
  className?: string;
  rows?: number;
  /** 调用方附加键处理(如 ⌘/Ctrl+Enter 提交);@ 选择器未消费的按键原样透传。 */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** 实体清单(测试/外部注入);缺省走 useEntities() 模块级共享缓存。 */
  entities?: EntityInfo[];
  /** 「已引用主体」预览行(默认 true);false 仅保留 @ 选择器。 */
  preview?: boolean;
}

/**
 * 带 @主体引用的 prompt 编辑器(@主体引用前台化,对标 Vidu Q3 @牛仔 @酒吧):
 * - 输入 `@` 弹出主体选择器(名称+缩略图,↑/↓ 选择、Enter/Tab 插入、Esc 关闭);
 * - 插入后文本中为 `@实体名`,下方预览行实时显示 chip:@角色A(图1)/@场景B(图2),
 *   图N 编号 = 提及首次出现顺序(与后端 entity_ids → @图片N 绑定一一对应);
 * - 点击 chip 展开绑定详情(哪张图=哪个编号);× 删除 chip 同时移除文本中的引用;
 * - 实体库不可用(接口未就绪/为空)时自动隐身,纯文本输入零影响。
 * 样式在 app/styles/stage.css(pwe- 前缀;stage.css 全局加载,三处消费方共用)。
 */
export function PromptWithEntities({
  value,
  onChange,
  disabled = false,
  placeholder,
  ariaLabel = "提示词",
  inputRef,
  className,
  rows = 1,
  onKeyDown,
  entities: entitiesProp,
  preview = true,
}: PromptWithEntitiesProps) {
  const shared = useEntities();
  const entities = entitiesProp ?? shared;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // 光标位置(onChange/onSelect 维护):@ 触发探测的锚点
  const [caret, setCaret] = useState(0);
  // Esc 关闭后到下次输入变化前不再弹出(与助手 @ 技能面板同一约定)
  const [dismissed, setDismissed] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const trigger = useMemo(
    () => (disabled || dismissed ? null : findActiveMention(value, caret)),
    [value, caret, disabled, dismissed],
  );
  const candidates = useMemo(
    () => (trigger ? filterEntities(entities, trigger.query) : []),
    [trigger, entities],
  );
  const open = trigger !== null && candidates.length > 0;

  // 过滤词变化时高亮回首项
  useEffect(() => {
    setActiveIdx(0);
  }, [trigger?.query]);

  // 点击组件外收起选择器
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setDismissed(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const attachRef = (el: HTMLTextAreaElement | null) => {
    taRef.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef) inputRef.current = el;
  };

  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  /** 插入实体:替换 @触发词 为 `@名字 `,光标落到名字后空格之后。 */
  const pick = (entity: EntityInfo) => {
    if (!trigger) return;
    const next = insertMention(value, trigger, entity, caret);
    onChange(next.text);
    setDismissed(true); // 本次插入完成后不再立刻重弹(继续输入时由 onChange 重新允许)
    setCaret(next.caret);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
        e.preventDefault();
        pick(candidates[Math.min(activeIdx, candidates.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="pwe-wrap" ref={wrapRef}>
      <textarea
        ref={attachRef}
        className={className}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? "pwe-listbox" : undefined}
        aria-activedescendant={open ? `pwe-opt-${candidates[Math.min(activeIdx, candidates.length - 1)]?.id}` : undefined}
        role="combobox"
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setDismissed(false); // 输入变化时重新允许 @ 面板弹出
          syncCaret(e.target);
        }}
        onSelect={(e) => syncCaret(e.currentTarget)}
        onKeyDown={handleKeyDown}
      />

      {open && (
        <div className="pwe-panel" role="listbox" id="pwe-listbox" aria-label="主体库">
          <div className="pwe-panel-head">
            <span>引用主体</span>
            <span className="pwe-panel-hint">↑↓ 选择 · Enter 插入 · Esc 关闭</span>
          </div>
          {candidates.map((ent, i) => (
            <button
              key={ent.id}
              type="button"
              id={`pwe-opt-${ent.id}`}
              role="option"
              aria-selected={i === activeIdx}
              className={`pwe-option${i === activeIdx ? " is-active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => pick(ent)}
            >
              {entityThumbUrl(ent) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="pwe-thumb" src={entityThumbUrl(ent)} alt="" aria-hidden="true" />
              ) : (
                <span className="pwe-thumb pwe-thumb-fallback" aria-hidden="true">
                  <Icon name="user" size={12} />
                </span>
              )}
              <span className="pwe-option-name">{ent.name}</span>
              <span className="pwe-option-kind">{entityKindLabel(ent.kind)}</span>
            </button>
          ))}
        </div>
      )}

      {preview && <EntityRefsPreview value={value} entities={entities} onChange={onChange} />}
    </div>
  );
}

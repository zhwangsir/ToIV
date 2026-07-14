"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "./Icon";

/**
 * 模型选项(统一抽象:CreateView 的 checkpoint 列表是纯字符串,
 * 这里用 id/name 结构承载类型徽章与 NSFW 标记,便于多视图复用)。
 */
export interface ModelOption {
  id: string;
  name: string;
  /** 模型类型徽章,如 "SDXL" / "Flux" / "LTX2.3";不传则不显示 */
  type?: string;
  /** 底模基线(预留,暂不展示) */
  base?: string;
  /** NSFW 模型标记:在选项右侧显示 R18 小标 */
  nsfw?: boolean;
}

interface ModelPickerProps {
  models: ModelOption[];
  /** 当前选中的模型 id */
  value: string;
  onChange: (id: string) => void;
  /** 顶部标签,如 "底模";不传则不渲染标签行 */
  label?: string;
  disabled?: boolean;
  /** NSFW 模式:触发器加 danger 色边框,提示当前在 R18 专区 */
  nsfw?: boolean;
  /** 无模型 / 未选中时的占位文案 */
  placeholder?: string;
}

/**
 * 公共模型选择器(自定义下拉,不用原生 <select>)。
 *
 * Why 自定义:原生 select 无法着色下拉箭头、无法承载类型徽章与 NSFW 标记,
 * 且 Indigo Atelier 的暗色面板需要完全可控的样式;各视图(CreateView /
 * 未来的 ManjuView 等)原本各自实现,这里收敛为单一来源。
 *
 * 注意:下拉面板用 position: absolute 定位。若祖先有 overflow:auto/hidden
 * (如 CreateView 的 .cv-panel-scroll),面板可能被裁切;消费方需确保放置
 * 位置有足够展开空间,或后续升级为 portal 方案。
 */
export function ModelPicker({
  models,
  value,
  onChange,
  label,
  disabled = false,
  nsfw = false,
  placeholder = "无可用模型",
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 键盘高亮的选项索引(ArrowDown/Up 移动,Enter 选中)
  const [activeIdx, setActiveIdx] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listboxId = "mp-listbox";

  const selected = useMemo(
    () => models.find((m) => m.id === value) ?? null,
    [models, value],
  );

  // 搜索过滤:同时匹配 name 与 id(大小写不敏感)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [models, query]);

  // 模型多(>8)时才显示搜索框,小列表避免噪音
  const showSearch = models.length > 8;

  // 打开时重置搜索 + 聚焦搜索框(若有),并复位高亮到当前选中项
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const idx = Math.max(0, filtered.findIndex((m) => m.id === value));
    setActiveIdx(idx);
    if (showSearch) {
      // 异步聚焦,等待 input 挂载
      const t = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = filtered[activeIdx];
      if (m) choose(m.id);
    }
  };

  const isEmpty = models.length === 0;
  const triggerDisabled = disabled || isEmpty;

  return (
    <div className="mp-root" ref={rootRef}>
      {label && <span className="mp-label">{label}</span>}

      <button
        type="button"
        className={`mp-trigger${open ? " is-open" : ""}${nsfw ? " is-nsfw" : ""}`}
        onClick={() => !triggerDisabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        disabled={triggerDisabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
      >
        <span className="mp-trigger-main">
          {selected ? (
            <>
              <span className="mp-name">{selected.name}</span>
              {selected.type && (
                <span className="mp-type-badge">{selected.type}</span>
              )}
            </>
          ) : (
            <span className="mp-placeholder">{placeholder}</span>
          )}
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className={`mp-chevron${open ? " is-open" : ""}`}
        />
      </button>

      {open && !isEmpty && (
        <div className="mp-panel" role="listbox" id={listboxId} onKeyDown={onListKey}>
          {showSearch && (
            <div className="mp-search">
              <Icon name="search" size={13} />
              <input
                ref={searchRef}
                type="text"
                className="mp-search-input"
                placeholder="搜索模型…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIdx(0);
                }}
                aria-label="搜索模型"
              />
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="mp-empty">无匹配模型</div>
          ) : (
            <ul className="mp-list">
              {filtered.map((m, i) => (
                <li
                  key={m.id}
                  role="option"
                  aria-selected={m.id === value}
                  className={`mp-option${m.id === value ? " is-selected" : ""}${i === activeIdx ? " is-active" : ""}`}
                  onClick={() => choose(m.id)}
                  onMouseEnter={() => setActiveIdx(i)}
                >
                  <span className="mp-option-main">
                    <span className="mp-option-name">{m.name}</span>
                    {m.type && (
                      <span className="mp-type-badge">{m.type}</span>
                    )}
                  </span>
                  {m.nsfw && <span className="mp-nsfw-tag">R18</span>}
                  {m.id === value && <Icon name="check" size={13} className="mp-check" />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <style jsx>{`
        .mp-root {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }
        .mp-label {
          font-size: 0.76rem;
          font-weight: 500;
          color: var(--ink-soft);
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }

        /* 触发器 */
        .mp-trigger {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          width: 100%;
          padding: 0.45rem 0.7rem;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          color: var(--ink);
          font-size: 0.82rem;
          text-align: left;
          cursor: pointer;
          transition: border-color var(--dur) var(--ease),
            background-color var(--dur) var(--ease);
        }
        .mp-trigger:hover:not(:disabled) {
          border-color: var(--hairline-strong);
          background: var(--bg-2);
        }
        .mp-trigger.is-open {
          border-color: var(--accent);
          background: var(--bg-2);
        }
        .mp-trigger:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        /* NSFW 模式:danger 色边框提示当前在 R18 专区 */
        .mp-trigger.is-nsfw {
          border-color: var(--danger);
        }
        .mp-trigger.is-nsfw.is-open {
          border-color: var(--danger);
          box-shadow: 0 0 0 1px var(--danger);
        }
        .mp-trigger-main {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          min-width: 0;
          flex: 1;
        }
        .mp-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: var(--font-mono);
          font-size: 0.8rem;
        }
        .mp-placeholder {
          color: var(--ink-faint);
          font-size: 0.8rem;
        }
        .mp-chevron {
          color: var(--ink-faint);
          flex-shrink: 0;
          transition: transform var(--dur) var(--ease);
        }
        .mp-chevron.is-open {
          transform: rotate(180deg);
        }

        /* 类型徽章(触发器与选项共用) */
        :global(.mp-type-badge) {
          flex-shrink: 0;
          padding: 0.05rem 0.35rem;
          background: var(--accent-quiet);
          border: 1px solid var(--accent-line);
          border-radius: var(--radius-full);
          color: var(--accent-soft);
          font-size: 0.64rem;
          font-weight: 600;
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }

        /* 下拉面板 */
        .mp-panel {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          right: 0;
          z-index: 50;
          background: var(--bg-1);
          border: 1px solid var(--hairline-strong);
          border-radius: var(--radius-sm);
          box-shadow: var(--shadow-lg);
          overflow: hidden;
          animation: var(--anim-fade-in);
        }
        .mp-search {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.5rem 0.6rem;
          border-bottom: 1px solid var(--hairline);
          color: var(--ink-faint);
        }
        .mp-search-input {
          flex: 1;
          min-width: 0;
          background: transparent;
          border: none;
          outline: none;
          color: var(--ink);
          font-size: 0.8rem;
        }
        .mp-search-input::placeholder {
          color: var(--ink-faint);
        }
        .mp-empty {
          padding: 0.7rem 0.6rem;
          font-size: 0.78rem;
          color: var(--ink-faint);
          text-align: center;
        }
        .mp-list {
          list-style: none;
          margin: 0;
          padding: 0.25rem;
          max-height: 280px;
          overflow-y: auto;
        }
        .mp-list::-webkit-scrollbar {
          width: 8px;
        }
        .mp-list::-webkit-scrollbar-thumb {
          background: var(--hairline-2);
          border-radius: 4px;
        }
        .mp-option {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          padding: 0.4rem 0.5rem;
          border-radius: var(--radius-xs);
          cursor: pointer;
          transition: background-color var(--dur) var(--ease);
        }
        .mp-option.is-active {
          background: var(--bg-2);
        }
        .mp-option.is-selected {
          background: var(--accent-quiet);
        }
        .mp-option-main {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          min-width: 0;
          flex: 1;
        }
        .mp-option-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 0.8rem;
          color: var(--ink);
          font-family: var(--font-mono);
        }
        .mp-option.is-selected .mp-option-name {
          color: var(--accent-soft);
        }
        .mp-nsfw-tag {
          flex-shrink: 0;
          padding: 0.05rem 0.3rem;
          background: color-mix(in oklch, var(--danger) 18%, transparent);
          border: 1px solid var(--danger);
          border-radius: var(--radius-full);
          color: var(--danger);
          font-size: 0.62rem;
          font-weight: 600;
          letter-spacing: 0.02em;
        }
        :global(.mp-check) {
          flex-shrink: 0;
          color: var(--accent-soft);
        }
      `}</style>
    </div>
  );
}

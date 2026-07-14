"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon, type IconName } from "./Icon";
import {
  getLocalAgent,
  listAgents,
  persistDefaultAgent,
  setLocalAgent,
  type Agent,
} from "@/lib/agents";

/** 已知的智能体图标键(与 Icon.tsx 的 ICON_MAP 对齐)。 */
const KNOWN_AGENT_ICONS: ReadonlySet<string> = new Set([
  "camera",
  "palette",
  "film",
  "brush",
  "cpu",
  "minus",
  "package",
  "mic",
  "database",
  "sparkles",
]);

function agentIcon(name: string): IconName {
  return KNOWN_AGENT_ICONS.has(name) ? (name as IconName) : "sparkles";
}

/**
 * 顶栏全局默认智能体切换器(紧凑 Popover)。
 *
 * Why 抽出:双层选择(顶栏全局默认 + 每个输入框可覆盖)中的"全局默认"层。
 *      顶栏常驻,任何视图都可见;切换后写 localStorage + PUT /api/account/preferences。
 *      只列 SFW 智能体(NSFW 专页外不展示,用户硬约束)。
 *
 * 出错/空列表时按钮显示"默认智能体"占位,不阻塞用户使用主功能。
 */
export function AgentSwitcher() {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 初次加载拉 SFW 列表(顶栏只展示非 NSFW,客户端再过滤一次兜底)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAgents()
      .then((list) => {
        if (cancelled) return;
        const sfw = list
          .filter((a) => !a.is_nsfw)
          .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
        setAgents(sfw);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 读 localStorage 的当前选中
  useEffect(() => {
    setSelectedId(getLocalAgent());
  }, []);

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

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const choose = (id: string) => {
    setOpen(false);
    setSelectedId(id);
    setLocalAgent(id);
    // 持久化失败不阻塞,只 console.warn(已在 persistDefaultAgent 内处理)
    void persistDefaultAgent(id);
  };

  const triggerLabel = selected ? selected.name : "默认智能体";
  const triggerIcon: IconName = selected ? agentIcon(selected.icon) : "sparkles";

  return (
    <div className="as-root" ref={rootRef}>
      <button
        type="button"
        className={`as-trigger${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`当前智能体:${triggerLabel},点击切换`}
        title="切换默认智能体"
      >
        <Icon name={triggerIcon} size={14} className="as-trigger-icon" />
        <span className="as-trigger-label">{triggerLabel}</span>
        <Icon
          name="chevron-down"
          size={12}
          className={`as-chevron${open ? " is-open" : ""}`}
        />
      </button>

      {open && (
        <div className="as-panel" role="listbox">
          {loading ? (
            <div className="as-empty">
              <span className="loading-spinner">
                <Icon name="loading" size={13} />
              </span>
              加载中…
            </div>
          ) : agents.length === 0 ? (
            <div className="as-empty">暂无可用智能体</div>
          ) : (
            <ul className="as-list">
              {agents.map((a) => {
                const isSel = a.id === selectedId;
                return (
                  <li
                    key={a.id}
                    role="option"
                    aria-selected={isSel}
                    className={`as-option${isSel ? " is-selected" : ""}`}
                    onClick={() => choose(a.id)}
                    title={a.description || a.name}
                  >
                    <Icon
                      name={agentIcon(a.icon)}
                      size={14}
                      className="as-option-icon"
                    />
                    <span className="as-option-main">
                      <span className="as-option-name">{a.name}</span>
                      {a.description && (
                        <span className="as-option-desc">{a.description}</span>
                      )}
                    </span>
                    {isSel && <Icon name="check" size={13} className="as-check" />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <style jsx>{`
        .as-root {
          position: relative;
          display: inline-flex;
        }
        .as-trigger {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.25rem 0.55rem;
          background: transparent;
          border: 1px solid var(--hairline);
          border-radius: var(--radius-full);
          color: var(--ink-soft);
          font-size: 0.74rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease), color var(--dur) var(--ease);
        }
        .as-trigger:hover,
        .as-trigger.is-open {
          background: var(--bg-2);
          border-color: var(--hairline-strong);
          color: var(--ink);
        }
        .as-trigger:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .as-trigger-icon {
          color: var(--accent-soft);
          flex-shrink: 0;
        }
        .as-trigger-label {
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .as-chevron {
          color: var(--ink-faint);
          flex-shrink: 0;
          transition: transform var(--dur) var(--ease);
        }
        .as-chevron.is-open {
          transform: rotate(180deg);
        }

        /* 小屏只显示图标,隐藏名字 */
        @media (max-width: 640px) {
          .as-trigger-label {
            display: none;
          }
        }

        .as-panel {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          z-index: 50;
          min-width: 240px;
          max-width: 320px;
          background: var(--bg-1);
          border: 1px solid var(--hairline-strong);
          border-radius: var(--radius-sm);
          box-shadow: var(--shadow-lg);
          overflow: hidden;
          animation: var(--anim-fade-in);
        }
        .as-empty {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.7rem 0.7rem;
          font-size: 0.78rem;
          color: var(--ink-faint);
        }
        .as-list {
          list-style: none;
          margin: 0;
          padding: 0.25rem;
          max-height: 320px;
          overflow-y: auto;
        }
        .as-list::-webkit-scrollbar {
          width: 8px;
        }
        .as-list::-webkit-scrollbar-thumb {
          background: var(--hairline-2);
          border-radius: 4px;
        }
        .as-option {
          display: flex;
          align-items: flex-start;
          gap: 0.5rem;
          padding: 0.45rem 0.5rem;
          border-radius: var(--radius-xs);
          cursor: pointer;
          transition: background-color var(--dur) var(--ease);
        }
        .as-option:hover {
          background: var(--bg-2);
        }
        .as-option.is-selected {
          background: var(--accent-quiet);
        }
        .as-option-icon {
          color: var(--accent-soft);
          flex-shrink: 0;
          margin-top: 0.05rem;
        }
        .as-option.is-selected .as-option-icon {
          color: var(--accent);
        }
        .as-option-main {
          display: flex;
          flex-direction: column;
          gap: 0.1rem;
          min-width: 0;
          flex: 1;
        }
        .as-option-name {
          font-size: 0.8rem;
          color: var(--ink);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .as-option.is-selected .as-option-name {
          color: var(--accent-soft);
        }
        .as-option-desc {
          font-size: 0.7rem;
          color: var(--ink-faint);
          line-height: 1.35;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        :global(.as-check) {
          flex-shrink: 0;
          color: var(--accent-soft);
          margin-top: 0.05rem;
        }
      `}</style>
    </div>
  );
}

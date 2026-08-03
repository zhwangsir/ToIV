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
          gap: var(--space-1);
          height: 28px;
          padding: 0 var(--space-3);
          background: transparent;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          color: var(--text-secondary);
          font-size: var(--text-aux);
          font-weight: 500;
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
        }
        .as-trigger:hover,
        .as-trigger.is-open {
          background: var(--bg-surface-2);
          border-color: var(--border-strong);
          color: var(--text-primary);
        }
        .as-trigger-icon {
          color: var(--accent);
          flex-shrink: 0;
        }
        .as-trigger-label {
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .as-chevron {
          color: var(--text-muted);
          flex-shrink: 0;
          transition: transform var(--duration-fast) var(--ease-standard);
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
          z-index: var(--z-dropdown);
          min-width: 240px;
          max-width: 320px;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-panel);
          box-shadow: var(--shadow-xl);
          overflow: hidden;
          animation: fadeIn var(--duration-base) var(--ease-standard);
        }
        .as-empty {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .as-list {
          list-style: none;
          margin: 0;
          padding: var(--space-1);
          max-height: 320px;
          overflow-y: auto;
        }
        .as-list::-webkit-scrollbar {
          width: 6px;
        }
        .as-list::-webkit-scrollbar-thumb {
          background: var(--bg-surface-3);
          border-radius: 3px;
        }
        .as-option {
          display: flex;
          align-items: flex-start;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-control);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .as-option:hover {
          background: var(--bg-surface-2);
        }
        .as-option.is-selected {
          background: var(--accent-soft);
        }
        .as-option-icon {
          color: var(--text-secondary);
          flex-shrink: 0;
          margin-top: 2px;
        }
        .as-option.is-selected .as-option-icon {
          color: var(--accent);
        }
        .as-option-main {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
          flex: 1;
        }
        .as-option-name {
          font-size: var(--text-body);
          color: var(--text-primary);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .as-option.is-selected .as-option-name {
          color: var(--accent);
        }
        .as-option-desc {
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.4;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        :global(.as-check) {
          flex-shrink: 0;
          color: var(--accent);
          margin-top: 2px;
        }
      `}</style>
    </div>
  );
}

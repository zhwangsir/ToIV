"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "./Icon";
import {
  getLocalAgent,
  listAgents,
  optimizeWithAgent,
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

interface OptimizeButtonProps {
  /** 旧式:点击后执行的优化逻辑(由父级实现:调 API + 更新 prompt/error 状态)。
   *  新式调用不传 onClick,改用 kind + onOptimized。 */
  onClick?: () => Promise<string | void> | string | void;
  /** 当前提示词:为空时按钮自动禁用(避免对空文本发起优化) */
  prompt: string;
  /** 新:优化目标类型 image/video/audio/train/image_edit */
  kind?: string;
  /** 新:目标 checkpoint(传给后端让 LLM 适配模型族方言) */
  model?: string;
  /** 旧/新统一:优化成功后回调。
   *  新式调用接收 (text, negative);旧式调用若 onClick 返回字符串,会作为 text 转发。 */
  onOptimized?: (text: string, negative?: string) => void;
  /** 新:是否允许在按钮旁覆盖全局智能体(默认 true)。
   *  false = 不弹 Popover,直接用全局默认智能体走 /api/optimize */
  allowAgentOverride?: boolean;
  disabled?: boolean;
  label?: string;
}

/**
 * 公共"优化提示词"按钮。
 *
 * 双模式:
 * 1. 旧式(向后兼容):只传 onClick,父级自己调 API + 改 prompt。
 * 2. 新式(智能体驱动):传 kind + onOptimized,点击弹 Popover 选智能体 →
 *    调 POST /api/optimize { prompt, kind, model, agent_id } → 回填 onOptimized(text, negative)。
 *
 * Why 升级:CreateView/NsfwVideoView/ManjuView/DubView/TrainView/BacklotView 的
 * "优化提示词"按钮逻辑重复,且需要可选智能体方向(写实摄影师 vs 动漫插画师…)。
 * 收敛按钮 UI + Popover + /api/optimize 调用,各视图只需传 prompt/kind/model。
 *
 * 复用全局 .loading-spinner(globals.css 已定义 spin 动画 + reduced-motion)。
 */
export function OptimizeButton({
  onClick,
  prompt,
  kind,
  model,
  onOptimized,
  allowAgentOverride = true,
  disabled = false,
  label = "优化提示词",
}: OptimizeButtonProps) {
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 新式调用 = 传了 kind + onOptimized(不依赖 onClick)
  const newMode = !!kind && !!onOptimized;

  const isDisabled = disabled || loading || !prompt.trim();

  // 计算 fixed 定位 Popover 位置，避免被 app-shell overflow:hidden 截断
  const computePosition = useCallback(() => {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const popoverWidth = 260;
    const gap = 6;
    let left = rect.left;
    // 右侧空间不足时向左展开
    if (left + popoverWidth > window.innerWidth - 16) {
      left = Math.max(16, rect.right - popoverWidth);
    }
    setPopoverStyle({
      "--ob-popover-top": `${rect.bottom + gap}px`,
      "--ob-popover-left": `${left}px`,
    } as React.CSSProperties);
  }, []);

  // 点击外部关闭 Popover;打开时重算位置并监听窗口变化
  useEffect(() => {
    if (!open) return;
    computePosition();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", computePosition);
    window.addEventListener("scroll", computePosition, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", computePosition);
      window.removeEventListener("scroll", computePosition, true);
    };
  }, [open, computePosition]);

  // 打开 Popover 时拉该 kind 可见智能体(NSFW 过滤交给后端按用户 R18 状态返回)
  useEffect(() => {
    if (!open || !newMode || !kind) return;
    let cancelled = false;
    setAgentsLoading(true);
    listAgents(kind)
      .then((list) => {
        if (cancelled) return;
        // 客户端再按 sort 排序兜底
        const sorted = [...list].sort(
          (a, b) => a.sort - b.sort || a.id.localeCompare(b.id),
        );
        setAgents(sorted);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, newMode, kind]);

  const runOptimize = async (agentId: string | null) => {
    if (!kind) return;
    setOpen(false);
    setLoading(true);
    try {
      const r = await optimizeWithAgent({
        prompt,
        kind,
        ...(model ? { model } : {}),
        ...(agentId ? { agentId } : {}),
      });
      onOptimized?.(r.optimized, r.negative ?? undefined);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = async () => {
    if (isDisabled) return;
    if (newMode) {
      // 新式:允许覆盖 → 弹 Popover;否则直接用全局默认 agent 走
      if (allowAgentOverride) {
        setOpen((v) => {
          const next = !v;
          if (next) requestAnimationFrame(computePosition);
          return next;
        });
      } else {
        await runOptimize(getLocalAgent());
      }
      return;
    }
    // 旧式:走父级 onClick(若返回字符串,作为优化结果转发给 onOptimized)
    setLoading(true);
    try {
      const result: unknown = await onClick?.();
      if (typeof result === "string" && onOptimized) onOptimized(result);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ob-root" ref={rootRef}>
      <button
        type="button"
        className={`ob-btn${loading ? " is-loading" : ""}${open ? " is-open" : ""}`}
        onClick={() => void handleClick()}
        disabled={isDisabled}
        title="AI 优化提示词"
      >
        {loading ? (
          <span className="loading-spinner">
            <Icon name="loading" size={13} />
          </span>
        ) : (
          <Icon name="sparkles" size={13} />
        )}
        {label}
      </button>

      {open && newMode && (
        <div className="ob-popover" role="listbox" style={popoverStyle}>
          <div className="ob-popover-header">选择智能体</div>
          {agentsLoading ? (
            <div className="ob-empty">
              <span className="loading-spinner">
                <Icon name="loading" size={13} />
              </span>
              加载中…
            </div>
          ) : agents.length === 0 ? (
            <div className="ob-empty">暂无可用智能体</div>
          ) : (
            <ul className="ob-list">
              {agents.map((a) => {
                const isSel = a.id === getLocalAgent();
                return (
                  <li
                    key={a.id}
                    role="option"
                    aria-selected={isSel}
                    className={`ob-option${isSel ? " is-selected" : ""}`}
                    onClick={() => void runOptimize(a.id)}
                    title={a.description || a.name}
                  >
                    <Icon
                      name={agentIcon(a.icon)}
                      size={13}
                      className="ob-option-icon"
                    />
                    <span className="ob-option-main">
                      <span className="ob-option-name">{a.name}</span>
                      {a.description && (
                        <span className="ob-option-desc">{a.description}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <style jsx>{`
        .ob-root {
          position: relative;
          display: inline-flex;
        }
        .ob-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          height: 26px;
          padding: 0 var(--space-3);
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-control);
          color: var(--accent);
          font-size: var(--text-aux);
          font-weight: 500;
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard);
        }
        .ob-btn:hover:not(:disabled) {
          background: var(--accent-soft);
          border-color: var(--accent-glow);
        }
        .ob-btn.is-open {
          background: var(--accent-soft);
          border-color: var(--accent-glow);
        }
        .ob-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        /* loading 态:弱化文字、保持 spinner 可见 */
        .ob-btn.is-loading {
          color: var(--text-muted);
          cursor: progress;
        }

        /* 智能体选择 Popover */
        .ob-popover {
          position: fixed;
          top: var(--ob-popover-top, auto);
          left: var(--ob-popover-left, auto);
          z-index: var(--z-sticky);
          min-width: 220px;
          max-width: 320px;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-panel);
          box-shadow: var(--shadow-xl);
          overflow: hidden;
          animation: fadeIn var(--duration-base) var(--ease-standard);
        }
        .ob-popover-header {
          padding: var(--space-2) var(--space-3);
          font-size: var(--text-label);
          font-weight: 500;
          color: var(--text-muted);
          letter-spacing: 0.04em;
          text-transform: uppercase;
          border-bottom: 1px solid var(--border-subtle);
        }
        .ob-empty {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .ob-list {
          list-style: none;
          margin: 0;
          padding: var(--space-1);
          max-height: 280px;
          overflow-y: auto;
        }
        .ob-list::-webkit-scrollbar {
          width: 6px;
        }
        .ob-list::-webkit-scrollbar-thumb {
          background: var(--bg-surface-3);
          border-radius: 3px;
        }
        .ob-option {
          display: flex;
          align-items: flex-start;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-control);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .ob-option:hover {
          background: var(--bg-surface-2);
        }
        .ob-option.is-selected {
          background: var(--accent-soft);
        }
        :global(.ob-option-icon) {
          color: var(--text-secondary);
          flex-shrink: 0;
          margin-top: 2px;
        }
        .ob-option.is-selected :global(.ob-option-icon) {
          color: var(--accent);
        }
        .ob-option-main {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
          flex: 1;
        }
        .ob-option-name {
          font-size: var(--text-aux);
          color: var(--text-primary);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ob-option.is-selected .ob-option-name {
          color: var(--accent);
        }
        .ob-option-desc {
          font-size: var(--text-label);
          color: var(--text-muted);
          line-height: 1.4;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
      `}</style>
    </div>
  );
}

"use client";

import { useState } from "react";

import { Icon } from "@/components/ui/Icon";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface AgentBarProps {
  project: UseDramaProjectReturn;
}

// 快捷指令:点击填入输入框并直接执行(对齐原型 chips 行为)
const QUICK_CMDS: { label: string; cmd: string }[] = [
  { label: "拆解剧本", cmd: "把剧本拆成 6 个镜头" },
  { label: "生成角色", cmd: "生成角色设定和三视图" },
  { label: "全部分镜", cmd: "生成所有分镜视频" },
  { label: "修改镜头 3", cmd: "给镜头 3 换个低角度运镜" },
  { label: "合成成片", cmd: "一键合成成片" },
];

/**
 * Film Atelier · Agent 命令条(LibTV 双入口之 Agent 入口)。
 * 头像块 + Director Agent 标签 + 自然语言输入 + 快捷 chips + 回复行。
 */
export function AgentBar({ project }: AgentBarProps) {
  const { agentBusy, agentReply, agentExec, clearAgentReply } = project;
  const [cmd, setCmd] = useState("");

  const run = (text: string) => {
    const c = text.trim();
    if (!c || agentBusy) return;
    agentExec(c);
  };

  return (
    <div className="fa-agentbar">
      <div className="fa-agentbar-top">
        <div className="fa-agent-avatar">A</div>
        <span className="fa-agent-label">Director Agent</span>
        <span className="fa-agent-hint">
          自然语言驱动全流程 · 双入口:直接说话,或手动操作下方工作台
        </span>
      </div>

      <div className="fa-agentbar-row">
        <input
          className="fa-agent-input"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run(cmd);
          }}
          placeholder="试试:把剧本拆成 6 个镜头 / 生成所有分镜视频 / 一键合成成片"
          disabled={agentBusy}
        />
        <button
          type="button"
          className="fa-btn fa-btn-amber"
          onClick={() => run(cmd)}
          disabled={agentBusy || !cmd.trim()}
        >
          {agentBusy ? (
            <>
              <Icon name="loading" size={13} className="fa-spin" />
              执行中
            </>
          ) : (
            <>
              <Icon name="send" size={13} />
              执行
            </>
          )}
        </button>
      </div>

      <div className="fa-agent-chips">
        {QUICK_CMDS.map((q) => (
          <button
            key={q.label}
            type="button"
            className="fa-chip"
            disabled={agentBusy}
            onClick={() => {
              setCmd(q.cmd);
              agentExec(q.cmd);
            }}
          >
            {q.label}
          </button>
        ))}
      </div>

      {agentReply && (
        <div className="fa-agent-reply">
          <span className="fa-agent-reply-text">{agentReply}</span>
          <button
            type="button"
            className="fa-agent-reply-close"
            onClick={clearAgentReply}
            title="关闭回复"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      <style jsx>{`
        .fa-agentbar {
          background: linear-gradient(180deg, var(--fa-hi), var(--fa-card));
          border: 1px solid var(--fa-amber-line);
          border-radius: 10px;
          padding: 14px 16px;
        }
        .fa-agentbar-top {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }
        .fa-agent-avatar {
          width: 24px;
          height: 24px;
          border-radius: 6px;
          background: var(--fa-amber);
          color: var(--fa-bg);
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: var(--fa-serif);
          font-weight: 700;
          font-size: 12px;
          flex-shrink: 0;
        }
        .fa-agent-label {
          font-family: var(--fa-mono);
          font-size: 10px;
          letter-spacing: 0.18em;
          color: var(--fa-amber);
          text-transform: uppercase;
        }
        .fa-agent-hint {
          margin-left: auto;
          font-size: 11px;
          color: var(--fa-ink3);
        }
        .fa-agentbar-row {
          display: flex;
          gap: 10px;
        }
        .fa-agent-input {
          flex: 1;
          background: var(--fa-bg);
          border: 1px solid var(--fa-line-hi);
          border-radius: 6px;
          color: var(--fa-ink);
          font-size: 13px;
          padding: 10px 14px;
          outline: none;
          transition:
            border-color 0.2s ease,
            box-shadow 0.2s ease;
        }
        .fa-agent-input:focus {
          border-color: var(--fa-amber);
          box-shadow: 0 0 0 3px var(--fa-amber-soft);
        }
        .fa-agent-input:disabled {
          opacity: 0.5;
        }
        .fa-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 14px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          background: transparent;
          color: var(--fa-ink2);
          border: 1px solid var(--fa-line-hi);
          cursor: pointer;
          transition: all 0.2s ease;
          white-space: nowrap;
        }
        .fa-btn:hover:not(:disabled) {
          color: var(--fa-ink);
          border-color: var(--fa-ink3);
          transform: translateY(-1px);
        }
        .fa-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .fa-btn-amber {
          background: var(--fa-amber);
          border-color: var(--fa-amber);
          color: var(--fa-bg);
          font-weight: 600;
        }
        .fa-btn-amber:hover:not(:disabled) {
          background: var(--fa-amber-hi);
          border-color: var(--fa-amber-hi);
          color: var(--fa-bg);
          box-shadow: 0 4px 16px var(--fa-amber-soft);
        }
        .fa-agent-chips {
          display: flex;
          gap: 8px;
          margin-top: 10px;
          flex-wrap: wrap;
        }
        .fa-chip {
          font-size: 11.5px;
          color: var(--fa-ink2);
          background: var(--fa-bg2);
          border: 1px solid var(--fa-line);
          border-radius: 20px;
          padding: 5px 13px;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .fa-chip:hover:not(:disabled) {
          color: var(--fa-amber);
          border-color: var(--fa-amber-line);
        }
        .fa-chip:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .fa-agent-reply {
          margin-top: 10px;
          display: flex;
          align-items: flex-start;
          gap: 8px;
          border-left: 2px solid var(--fa-amber);
          padding: 4px 0 4px 12px;
          animation: fa-rise 0.3s ease both;
        }
        .fa-agent-reply-text {
          flex: 1;
          font-size: 12.5px;
          color: var(--fa-ink2);
          white-space: pre-wrap;
          line-height: 1.6;
        }
        .fa-agent-reply-close {
          background: none;
          border: none;
          color: var(--fa-ink3);
          cursor: pointer;
          padding: 2px;
          display: flex;
          transition: color 0.15s ease;
        }
        .fa-agent-reply-close:hover {
          color: var(--fa-ink);
        }
        .fa-spin {
          animation: fa-spin 1s linear infinite;
        }
        @keyframes fa-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes fa-rise {
          from {
            opacity: 0;
            transform: translateY(6px);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }
        @media (max-width: 720px) {
          .fa-agent-hint {
            display: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .fa-spin,
          .fa-agent-reply {
            animation: none;
          }
          .fa-btn,
          .fa-chip,
          .fa-agent-input,
          .fa-agent-reply-close {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}

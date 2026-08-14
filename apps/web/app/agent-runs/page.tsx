"use client";

/**
 * Agent Team 统一入口(列表页,R3.1):
 * 大目标输入框(一句话需求)+ 创建按钮 + 历史 run 卡片列表(状态徽章 + 任务进度)。
 * 创建后:L0 → 秒回提示并链到对话工作台;L1/L2 → 跳详情页进计划确认门。
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, ChevronLeft, ChevronRight, Loader2, Send, X } from "lucide-react";
import { AgentRunStyles } from "@/components/agent-run/AgentRunStyles";
import { runStatusMeta } from "@/components/agent-run/agentRunMeta";
import { useAgentRunList } from "@/components/agent-run/useAgentRunList";
import { useAuthGuard } from "@/components/agent-run/useAuthGuard";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";

export default function AgentRunsPage() {
  const authed = useAuthGuard();
  const router = useRouter();
  const list = useAgentRunList();
  const [goal, setGoal] = useState("");

  const submit = async (): Promise<void> => {
    const outcome = await list.create(goal);
    if (!outcome) return;
    if (outcome.kind === "run" && outcome.runId) {
      // L1/L2:跳详情页;ack 经 query 透传给秒回横幅
      router.push(
        `/agent-runs/${encodeURIComponent(outcome.runId)}?ack=${encodeURIComponent(outcome.ack)}`,
      );
      return;
    }
    // L0:留在本页,秒回提示 + 链到对话工作台
    setGoal("");
  };

  if (!authed) {
    return (
      <div className="splash">
        <div className="splash-orb" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="agent-page">
      <div className="agent-shell">
        <header className="page-header">
          <div>
            <Link href="/" className="agent-back" aria-label="返回首页">
              <ChevronLeft size={14} aria-hidden="true" /> 首页
            </Link>
            <h1 className="page-header-title agent-page-title">
              <Bot size={22} aria-hidden="true" /> Agent 团队
            </h1>
            <p className="page-header-desc">
              一句话说清需求,Agent 团队拆成计划逐步执行;计划可见,关键节点会找你确认
            </p>
          </div>
        </header>

        {/* 错误条(可关闭,统一 ErrorBar) */}
        <ErrorBar message={list.error} onClose={list.clearError} />

        {/* L0 秒回提示(链到对话工作台) */}
        {list.l0Ack && (
          <p className="agent-l0" role="status">
            <span className="agent-l0-text">{list.l0Ack}</span>
            <Link href="/?view=assistant" className="agent-l0-link">
              前往对话工作台 <ChevronRight size={13} aria-hidden="true" />
            </Link>
            <button
              type="button"
              className="agent-error-close"
              aria-label="关闭提示"
              onClick={list.clearL0Ack}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </p>
        )}

        {/* 目标输入 */}
        <section className="agent-goal-box" aria-label="新建任务">
          <textarea
            className="input agent-goal-input"
            value={goal}
            placeholder="一句话描述你的需求,例如:拍一支 30 秒的咖啡店开业宣传短片,温暖治愈风,配轻爵士背景乐"
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
            }}
          />
          <div className="agent-goal-actions">
            <span className="agent-goal-hint">⌘/Ctrl + Enter 直接创建;简单问题会直链对话工作台</span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={list.creating || !goal.trim()}
              onClick={() => void submit()}
            >
              {list.creating ? (
                <Loader2 size={14} aria-hidden="true" className="icon-loading-spin" />
              ) : (
                <Send size={14} aria-hidden="true" />
              )}
              创建并拆解
            </button>
          </div>
        </section>

        {/* 历史 run 列表 */}
        <h2 className="agent-section-title">历史任务</h2>
        {list.loading && list.runs.length === 0 ? (
          <LoadingBlock variant="line" count={3} />
        ) : list.runs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Bot size={40} aria-hidden="true" />
            </div>
            <h3 className="empty-state-title">还没有 Agent 任务</h3>
            <p className="empty-state-desc">
              在上方输入一句话需求,Agent 团队会自动拆解计划并逐步执行。
            </p>
          </div>
        ) : (
          <ul className="agent-run-list">
            {list.runs.map((r) => {
              const meta = runStatusMeta(r.status);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className="agent-run-open"
                    onClick={() => router.push(`/agent-runs/${encodeURIComponent(r.id)}`)}
                  >
                    <span className="agent-run-goal">{r.goal || "未命名任务"}</span>
                    <span className="agent-run-meta">
                      <span className="badge">{r.level}</span>
                      <span className={`agent-status is-${meta.tone}`}>{meta.label}</span>
                      <span className="agent-run-progress">
                        {r.task_counts.done}/{r.task_counts.total} 完成
                        {r.task_counts.error > 0 ? ` · ${r.task_counts.error} 失败` : ""}
                      </span>
                      <time>
                        {r.created_at
                          ? new Date(r.created_at).toLocaleDateString("zh-CN")
                          : ""}
                      </time>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <AgentRunStyles />
    </div>
  );
}

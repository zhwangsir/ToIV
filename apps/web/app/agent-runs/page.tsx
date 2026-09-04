"use client";

/**
 * Agent Team 统一入口(列表页,R3.1):
 * 大目标输入框(一句话需求)+ 创建按钮 + 历史 run 卡片列表(状态徽章 + 任务进度)。
 * 创建后:L0 → 秒回提示并链到对话工作台;L1/L2 → 跳详情页进计划确认门。
 *
 * Film Atelier 重塑(2026-08-15,P0-2):
 * - 直接 import agent-runs.css(此前仅详情页 AgentRunView 引入,列表页无样式 = 贴边裸排根因);
 * - 版心 .view-shell;页头(返回链 + 标题 + 辅助描述,Studio Console v1 起 kicker 铭牌退役);
 * - 历史任务 → .at-card 卡片流(.at-card-in 错落入场):标题行 + 状态点/文字 + Fraunces n/N 进度
 *   + tabular-nums 日期分行;空态 .at-empty;需求输入区 → 玻璃命令条;主钮 .at-btn--primary;
 * - 图标统一 ui/Icon。
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { runStatusMeta, stripMarkdown } from "@/components/agent-run/agentRunMeta";
import { useAgentRunList } from "@/components/agent-run/useAgentRunList";
import { useAuthGuard } from "@/components/agent-run/useAuthGuard";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { useAutoResize } from "@/hooks/useAutoResize";
import "@/app/styles/agent-runs.css";

export default function AgentRunsPage() {
  const authed = useAuthGuard();
  const router = useRouter();
  const list = useAgentRunList();
  const [goal, setGoal] = useState("");
  // 大目标输入框自动增高(长需求不再固定高截断)
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(goalRef, goal);

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
      <div className="view-shell agent-shell">
        <header className="page-header">
          <div className="page-header-text">
            <Link href="/" className="agent-back" aria-label="返回首页">
              <Icon name="chevron-left" size={14} /> 首页
            </Link>
            <h1 className="page-header-title agent-page-title">
              <Icon name="bot" size={22} /> Agent 团队
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
              前往对话工作台 <Icon name="chevron-right" size={13} />
            </Link>
            <button
              type="button"
              className="agent-error-close"
              aria-label="关闭提示"
              onClick={list.clearL0Ack}
            >
              <Icon name="close" size={12} />
            </button>
          </p>
        )}

        {/* 目标输入(玻璃命令条) */}
        <section className="agent-goal-box" aria-label="新建任务">
          <textarea
            ref={goalRef}
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
              className="at-btn at-btn--primary"
              disabled={list.creating || !goal.trim()}
              onClick={() => void submit()}
            >
              <Icon name={list.creating ? "loading" : "send"} size={14} />
              创建并拆解
            </button>
          </div>
        </section>

        {/* 历史 run 卡片列表 */}
        <h2 className="agent-section-title">历史任务</h2>
        {list.loading && list.runs.length === 0 ? (
          <LoadingBlock variant="line" count={3} />
        ) : list.runs.length === 0 ? (
          /* 空态升级(2026-09-04 美化 W4):裸 at-empty 标题 → 共享三档 section 档 + 引导 */
          <Empty
            size="section"
            icon="bot"
            title="还没有 Agent 任务"
            desc="在上方输入一句话需求,创建第一个 Agent 任务"
          />
        ) : (
          <ul className="agent-run-list">
            {list.runs.map((r) => {
              const meta = runStatusMeta(r.status);
              return (
                <li key={r.id} className="at-card-in">
                  <button
                    type="button"
                    className="agent-run-open at-card at-card--lift"
                    onClick={() => router.push(`/agent-runs/${encodeURIComponent(r.id)}`)}
                  >
                    <span className="agent-run-main">
                      <span className="agent-run-goal">{stripMarkdown(r.goal) || "未命名任务"}</span>
                      {/* 副标行(2026-08-16 批 2):进度计数降档收进副标,时间戳+任务数
                          作重复标题的区分信息;原右侧 Fraunces 大数字已撤(视觉重心颠倒) */}
                      <span className="agent-run-sub">
                        <span
                          className={`agent-status-dot is-${meta.tone}`}
                          aria-hidden="true"
                        />
                        <span>{meta.label}</span>
                        <span className="at-badge">{r.level}</span>
                        <span className="agent-run-progress">
                          {r.task_counts.done}/{r.task_counts.total} 完成
                          {r.task_counts.error > 0 ? ` · ${r.task_counts.error} 失败` : ""}
                        </span>
                        <time className="agent-run-date">
                          {r.created_at
                            ? new Date(r.created_at).toLocaleDateString("zh-CN")
                            : ""}
                        </time>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

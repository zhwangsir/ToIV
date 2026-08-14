"use client";

/**
 * AgentRunView:Agent Team 详情页容器(设计 §1.3.4)。
 * 四要素齐备:秒回横幅(AckBanner)/ 计划确认门(PlanPanel)/
 * 任务卡片流(TaskCardList ⇄ PipelineView 泳道双形态 toggle)/ 事件汇报流(EventTicker);
 * 顶部 run 状态徽章 + 取消按钮(confirm 对话框);合成门 ConfirmGateModal 事件触发。
 */
import { useState } from "react";
import Link from "next/link";
import {
  Ban,
  ChevronLeft,
  LayoutGrid,
  Loader2,
  Radio,
  Workflow,
  X,
} from "lucide-react";
import { imageUrl } from "@/lib/api";
import { LazyVideo } from "@/components/ui/LazyVideo";
import { AckBanner } from "./AckBanner";
import { ConfirmGateModal } from "./ConfirmGateModal";
import { EventTicker } from "./EventTicker";
import { PipelineView } from "./PipelineView";
import { PlanPanel } from "./PlanPanel";
import { TaskCardList } from "./TaskCardList";
import { RUN_TERMINAL, runStatusMeta } from "./agentRunMeta";
import { useAgentRun } from "./useAgentRun";
import { AgentRunStyles } from "./AgentRunStyles";

export function AgentRunView({ runId, ack }: { runId: string; ack?: string | null }) {
  const run = useAgentRun(runId);
  const [mode, setMode] = useState<"cards" | "pipeline">("cards");
  const d = run.detail;
  const statusMeta = runStatusMeta(d?.status ?? "");
  const terminal = d ? RUN_TERMINAL.has(d.status) : false;

  const cancelRun = async (): Promise<void> => {
    if (!window.confirm("取消该任务?进行中的节点会按作业取消语义终止。")) return;
    try {
      await run.cancel();
    } catch {
      /* 错误已透出到错误条 */
    }
  };

  return (
    <div className="agent-page">
      <div className="agent-shell">
        {/* ── 顶部:返回 + 目标 + 状态徽章 + 形态 toggle + 取消 ── */}
        <header className="agent-topbar">
          <Link href="/agent-runs" className="agent-back">
            <ChevronLeft size={14} aria-hidden="true" /> 任务列表
          </Link>
          <div className="agent-topbar-main">
            <h1 className="agent-goal" title={d?.goal}>
              {d?.goal || "Agent 团队任务"}
            </h1>
            <div className="agent-topbar-meta">
              {d && <span className="badge">{d.level}</span>}
              {d && (
                <span className={`agent-status is-${statusMeta.tone}`}>
                  {statusMeta.label}
                </span>
              )}
            </div>
          </div>
          <div className="agent-topbar-actions">
            <div className="agent-mode" role="tablist" aria-label="视图形态">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "cards"}
                className={`agent-mode-btn${mode === "cards" ? " is-active" : ""}`}
                title="卡片流"
                onClick={() => setMode("cards")}
              >
                <LayoutGrid size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "pipeline"}
                className={`agent-mode-btn${mode === "pipeline" ? " is-active" : ""}`}
                title="泳道"
                onClick={() => setMode("pipeline")}
              >
                <Workflow size={14} aria-hidden="true" />
              </button>
            </div>
            {d && !terminal && (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={run.busy["cancel"]}
                onClick={() => void cancelRun()}
              >
                <Ban size={12} aria-hidden="true" /> 取消任务
              </button>
            )}
          </div>
        </header>

        {/* ── 错误条(可关闭,M12 范式)── */}
        {run.error && (
          <p className="agent-error" role="alert">
            <span className="agent-error-text">{run.error}</span>
            <button
              type="button"
              className="agent-error-close"
              aria-label="关闭错误提示"
              onClick={run.clearError}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </p>
        )}

        {/* ── SSE 断线提示 ── */}
        {run.sseState === "reconnecting" && (
          <p className="agent-conn" role="status">
            <Loader2 size={13} aria-hidden="true" className="icon-loading-spin" />
            连接中断,重连中…
          </p>
        )}
        {run.sseState === "polling" && (
          <p className="agent-conn" role="status">
            <Radio size={13} aria-hidden="true" />
            实时连接已断开,已切换为 5 秒轮询
          </p>
        )}

        {run.loading && !d ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Loader2 size={32} aria-hidden="true" className="icon-loading-spin" />
            </div>
            <p className="empty-state-desc">任务加载中…</p>
          </div>
        ) : !d ? (
          /* 加载失败:错误条已在上方透出,此处不再渲染内容 */
          <div className="empty-state">
            <p className="empty-state-desc">任务详情加载失败,可返回列表重试</p>
          </div>
        ) : (
          <>
            {/* ── 秒回横幅 ── */}
            <AckBanner ack={ack} taskCount={d?.plan.length ?? 0} />

            {/* run 级错误(终态 error)透出 */}
            {d?.status === "error" && d.error && (
              <p className="agent-error" role="alert">
                <span className="agent-error-text">运行出错:{d.error}</span>
              </p>
            )}

            {/* ── 计划确认门(awaiting_confirm)── */}
            {d?.status === "awaiting_confirm" && (
              <PlanPanel
                tasks={d.plan}
                busy={run.busy}
                onSavePlan={run.savePlan}
                onResume={run.resume}
              />
            )}

            {/* ── 成片(done)── */}
            {d?.status === "done" && run.result?.final_url && (
              <section className="agent-final">
                <h2 className="agent-final-title">成片</h2>
                <LazyVideo
                  src={imageUrl(run.result.final_url)}
                  controls
                  playsInline
                  className="agent-final-player"
                />
                {run.result.duration_sec > 0 && (
                  <p className="agent-gate-total">时长 {Math.round(run.result.duration_sec)}s</p>
                )}
              </section>
            )}

            {/* ── 主区:卡片流 ⇄ 泳道 + 事件汇报流 ── */}
            <div className="agent-layout">
              <div className="agent-main">
                {d &&
                  (mode === "cards" ? (
                    <TaskCardList tasks={d.plan} busy={run.busy} onAction={run.taskAction} />
                  ) : (
                    <PipelineView tasks={d.plan} />
                  ))}
              </div>
              <EventTicker events={run.events} />
            </div>
          </>
        )}

        {/* ── 合成确认门(confirm_required 事件 / awaiting_assembly)── */}
        <ConfirmGateModal
          open={run.assemblyGate}
          tasks={d?.plan ?? []}
          busy={run.busy}
          onResume={run.resume}
          onClose={() => {
            /* 仅收起弹层;hook 侧不关门(刷新/事件会重开)——直接调 hook 暴露的关闭 */
            run.dismissAssemblyGate();
          }}
        />
      </div>
      <AgentRunStyles />
    </div>
  );
}

"use client";

/**
 * 合成确认门(ConfirmGateModal):confirm_required(gate=assembly)事件触发。
 * 时间线预览(任务卡按序排列 + 时长合计),approve 合成 / reject 返回(可带批注)。
 */
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { MagnetFollow } from "@/components/ui/MagnetFollow";
import { Modal } from "@/components/ui/Modal";
import { Ripple } from "@/components/ui/Ripple";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { AgentResumeBody, AgentRunTask } from "@/lib/api";
import { taskDurationSec, taskStatusMeta } from "./agentRunMeta";

interface ConfirmGateModalProps {
  open: boolean;
  tasks: AgentRunTask[];
  busy: Record<string, boolean>;
  onResume: (
    gate: AgentResumeBody["gate"],
    action: AgentResumeBody["action"],
    feedback?: string,
  ) => Promise<void>;
  /** 仅关闭弹层(不下裁决,事件/状态还会再开门) */
  onClose: () => void;
}

export function ConfirmGateModal({ open, tasks, busy, onResume, onClose }: ConfirmGateModalProps) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  // 打回原因自动增高(长批注不再 rows=2 截断)
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(feedbackRef, feedback);
  const submitting = busy["resume:assembly"] === true;
  const total = tasks.reduce((sum, t) => sum + taskDurationSec(t), 0);

  const approve = async (): Promise<void> => {
    try {
      await onResume("assembly", "approve");
    } catch {
      /* 错误已由 hook 透出到错误条 */
    }
  };

  const reject = async (): Promise<void> => {
    try {
      await onResume("assembly", "reject", feedback.trim() || undefined);
      setRejecting(false);
    } catch {
      /* 同上 */
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="合成前确认"
      width={640}
      preventClose={submitting}
      footer={
        rejecting ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setRejecting(false)}>
              返回
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={submitting}
              onClick={() => void reject()}
            >
              <Icon name="undo" size={14} /> 确认打回
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => setRejecting(true)}
            >
              <Icon name="undo" size={14} /> 返回修改
            </button>
            <MagnetFollow>
              <Ripple>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={submitting}
                  onClick={() => void approve()}
                >
                  <Icon name="success" size={14} /> 确认合成
                </button>
              </Ripple>
            </MagnetFollow>
          </>
        )
      }
    >
      <p className="agent-gate-desc">全部任务已就绪,合成前请过一遍时间线:</p>
      <ol className="agent-gate-timeline">
        {tasks.map((t, i) => {
          const meta = taskStatusMeta(t.status);
          const dur = taskDurationSec(t);
          return (
            <li key={t.id} className="agent-gate-item">
              <span className="agent-gate-idx" aria-hidden="true">
                {i + 1}
              </span>
              <span className="agent-gate-title">{t.title || `任务 ${i + 1}`}</span>
              <span className={`agent-status is-${meta.tone}`}>{meta.label}</span>
              <span className="agent-gate-dur">{dur > 0 ? `${dur}s` : "—"}</span>
            </li>
          );
        })}
      </ol>
      <p className="agent-gate-total">合计时长 ≈ {total > 0 ? `${total}s` : "未知"}</p>
      {rejecting && (
        <textarea
          ref={feedbackRef}
          className="input"
          rows={2}
          value={feedback}
          placeholder="打回原因(方向性批注,可选),例如「第 3 镜节奏太慢」"
          onChange={(e) => setFeedback(e.target.value)}
        />
      )}
    </Modal>
  );
}

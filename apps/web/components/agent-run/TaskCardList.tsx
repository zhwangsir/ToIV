"use client";

/**
 * 任务卡片流(TaskCardList + TaskCard):
 * - CardHeader:序号 + 标题 + kind + 状态徽章(lucide 图标)+ attempt 徽标(第 N 次尝试);
 * - CardPreview:产物预览(图/视频走 imageUrl(),视频用 LazyVideo;音频/文本兜底),
 *   失败显示打回原因(verdict / output.error,失败透明化);
 * - CardActions:干预三类 edit(改文案,inline 编辑)/ regenerate(带引导词)/ approve(通过);
 *   upload/reprompt 后端本期 501,置灰不调用;
 * - GpuQueueChip:gpu_hint 非空时展示 GPU 排队提示。
 */
import { useState } from "react";
import { imageUrl, type AgentRunTask } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { LazyVideo } from "@/components/ui/LazyVideo";
import { Ripple } from "@/components/ui/Ripple";
import {
  extractTaskMedia,
  primaryInputText,
  taskKindLabel,
  taskStatusMeta,
} from "./agentRunMeta";

export type TaskIntervention = "edit" | "regenerate" | "approve";

interface TaskCardProps {
  task: AgentRunTask;
  /** 计划内序号(1 起) */
  ordinal: number;
  /** 依赖 id → 序号(用于「← ①③」展示) */
  orderOf: (id: string) => number;
  busy: Record<string, boolean>;
  onAction: (
    tid: string,
    action: TaskIntervention,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}

function TaskCard({ task, ordinal, orderOf, busy, onAction }: TaskCardProps) {
  const meta = taskStatusMeta(task.status);
  const statusCls = meta.spin ? "icon-loading-spin" : undefined;
  const media = extractTaskMedia(task.output);
  // 进行中(running/queued)不允许干预;终态卡片仅保留「重生成」
  const inflight = task.status === "running" || task.status === "queued";
  const cardBusy = (a: string): boolean => busy[`task:${task.id}:${a}`] === true;

  // ── inline 编辑文案 ──
  const [editing, setEditing] = useState(false);
  const primary = primaryInputText(task.input);
  const [draft, setDraft] = useState("");
  // ── 重生成引导词 ──
  const [regening, setRegening] = useState(false);
  const [guidance, setGuidance] = useState("");

  const submitEdit = async (): Promise<void> => {
    try {
      await onAction(task.id, "edit", {
        input: { ...task.input, [primary.key]: draft },
      });
      setEditing(false);
    } catch {
      /* 错误已由 hook 透出到错误条 */
    }
  };

  const submitRegen = async (): Promise<void> => {
    try {
      await onAction(task.id, "regenerate", guidance.trim() ? { guidance: guidance.trim() } : {});
      setRegening(false);
      setGuidance("");
    } catch {
      /* 同上 */
    }
  };

  const submitApprove = async (): Promise<void> => {
    try {
      await onAction(task.id, "approve");
    } catch {
      /* 同上 */
    }
  };

  return (
    <article className="agent-task" data-status={task.status}>
      {/* ── CardHeader ── */}
      <header className="agent-task-head">
        <span className="agent-task-idx" aria-hidden="true">
          {ordinal}
        </span>
        <span className="agent-task-kind">{taskKindLabel(task.kind)}</span>
        <h3 className="agent-task-title" title={task.title}>
          {task.title || `任务 ${ordinal}`}
        </h3>
        <span className={`agent-status is-${meta.tone}`}>
          <Icon name={meta.icon} size={12} className={statusCls} />
          {meta.label}
        </span>
        {task.attempt > 0 && (
          <span className="agent-attempt" title="被打回/重生成次数">
            第 {task.attempt + 1} 次尝试
          </span>
        )}
      </header>

      {/* 依赖序号 */}
      {task.depends_on.length > 0 && (
        <p className="agent-task-deps">
          依赖{" "}
          {task.depends_on
            .map((d) => {
              const n = orderOf(d);
              return n > 0 ? `第 ${n} 步` : d;
            })
            .join("、")}
        </p>
      )}

      {/* ── CardPreview ── */}
      <div className="agent-task-media">
        {media.kind === "video" && (
          <LazyVideo src={imageUrl(media.src)} controls muted playsInline />
        )}
        {media.kind === "image" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl(media.src)}
            alt={task.title}
            width={1280}
            height={720}
            loading="lazy"
            decoding="async"
          />
        )}
        {media.kind === "audio" && (
          <audio src={imageUrl(media.src)} controls className="agent-task-audio" />
        )}
        {media.kind === "text" && <pre className="agent-task-text">{media.text}</pre>}
        {media.kind === "none" && (
          <div className="agent-task-empty">
            <Icon name={meta.icon} size={20} className={statusCls} />
            <span>
              {task.status === "error"
                ? "生成失败"
                : inflight
                  ? "产物生成中…"
                  : "尚未产出"}
            </span>
          </div>
        )}
      </div>

      {/* 失败/打回原因(透明化) */}
      {(task.status === "error" || task.status === "rejected") && (
        <p className="agent-task-error" role="alert">
          {task.verdict ||
            (typeof task.output?.error === "string" ? task.output.error : "") ||
            "生成失败,可改文案后重生成"}
        </p>
      )}
      {/* Verifier 评语(非失败态也展示,打回原因可见) */}
      {task.verdict && task.status !== "error" && task.status !== "rejected" && (
        <p className="agent-task-verdict">验收意见:{task.verdict}</p>
      )}

      {/* ── GpuQueueChip ── */}
      {task.gpu_hint && (
        <p className="agent-gpu">
          <Icon name="cpu" size={12} /> {task.gpu_hint}
        </p>
      )}

      {/* ── CardActions ── */}
      <div className="agent-task-actions">
        <Ripple>
          <button
            type="button"
            className="btn btn-sm"
            disabled={inflight || editing || cardBusy("edit")}
            onClick={() => {
              setDraft(primary.value);
              setEditing(true);
              setRegening(false);
            }}
          >
            <Icon name="pencil" size={12} /> 改文案
          </button>
        </Ripple>
        <Ripple>
          <button
            type="button"
            className="btn btn-sm"
            disabled={inflight || regening || cardBusy("regenerate")}
            onClick={() => {
              setRegening(true);
              setEditing(false);
            }}
          >
            <Icon name="refresh" size={12} /> 重生成
          </button>
        </Ripple>
        <Ripple>
          <button
            type="button"
            className="btn btn-sm"
            disabled={inflight || cardBusy("approve")}
            onClick={() => void submitApprove()}
          >
            <Icon name="badge-check" size={12} /> 通过
          </button>
        </Ripple>
        {/* upload/reprompt 后端本期 501:置灰占位,不发起调用 */}
        <button type="button" className="btn btn-sm" disabled title="本期未开放">
          <Icon name="upload" size={12} /> 替换上传
        </button>
        <button type="button" className="btn btn-sm" disabled title="本期未开放">
          <Icon name="wand" size={12} /> 反推提示词
        </button>
      </div>

      {/* inline 编辑区 */}
      {editing && (
        <div className="agent-task-edit">
          <textarea
            className="input"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="修改该任务的提示词/文案"
          />
          <div className="agent-task-edit-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={cardBusy("edit")}
              onClick={() => void submitEdit()}
            >
              保存
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      )}
      {regening && (
        <div className="agent-task-edit">
          <textarea
            className="input"
            rows={2}
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            placeholder="引导词(可选):告诉 AI 这次往哪个方向改,例如「角色发色保持一致」"
          />
          <div className="agent-task-edit-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={cardBusy("regenerate")}
              onClick={() => void submitRegen()}
            >
              带引导词重生成
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRegening(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export function TaskCardList({
  tasks,
  busy,
  onAction,
}: {
  tasks: AgentRunTask[];
  busy: Record<string, boolean>;
  onAction: TaskCardProps["onAction"];
}) {
  const orderOf = (id: string): number => tasks.findIndex((t) => t.id === id) + 1;
  if (tasks.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state-desc">计划任务会出现在这里</p>
      </div>
    );
  }
  return (
    <div className="agent-task-grid">
      {tasks.map((t, i) => (
        <TaskCard
          key={t.id}
          task={t}
          ordinal={i + 1}
          orderOf={orderOf}
          busy={busy}
          onAction={onAction}
        />
      ))}
    </div>
  );
}

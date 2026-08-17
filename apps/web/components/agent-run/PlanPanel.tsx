"use client";

/**
 * 计划确认门(PlanPanel + PlanEditor 内联):
 * awaiting_confirm 时展示计划任务清单(标题/kind/依赖序号),支持
 * 改标题、删任务、加任务、改 input 文案;确认(approve/有改动则 modify)/
 * 打回(reject + feedback)→ POST /plan + /resume。
 */
import { useRef, useState, type TextareaHTMLAttributes } from "react";
import { Icon } from "@/components/ui/Icon";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { AgentPlanEditOp, AgentResumeBody, AgentRunTask } from "@/lib/api";
import { primaryInputText, taskKindLabel } from "./agentRunMeta";

/** 计划任务文案框(列表映射场景):每行独立 ref,自动增高替代 rows=2 截断。 */
function PlanTextarea({ value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(ref, String(value ?? ""));
  return <textarea ref={ref} value={value} {...rest} />;
}

interface PlanPanelProps {
  tasks: AgentRunTask[];
  busy: Record<string, boolean>;
  onSavePlan: (ops: AgentPlanEditOp[]) => Promise<void>;
  onResume: (
    gate: AgentResumeBody["gate"],
    action: AgentResumeBody["action"],
    feedback?: string,
  ) => Promise<void>;
}

/** 本地编辑痕迹:update 按 id 记 title/inputText;remove 记 id;add 记临时行。 */
interface PlanDraft {
  edits: Record<string, { title?: string; inputText?: string; inputKey?: string }>;
  removed: string[];
  added: { id: string; title: string; inputText: string }[];
}

export function PlanPanel({ tasks, busy, onSavePlan, onResume }: PlanPanelProps) {
  const [draft, setDraft] = useState<PlanDraft>({ edits: {}, removed: [], added: [] });
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  // 打回反馈自动增高(原单行 input 装长文,升级为 textarea 随内容增高)
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(feedbackRef, feedback);
  // 新增任务临时 id 自增(落库时后端可替换)
  const [addSeq, setAddSeq] = useState(1);

  const submitting = busy["plan"] || busy["resume:plan"];
  const visibleTasks = tasks.filter((t) => !draft.removed.includes(t.id));
  const orderOf = (id: string): number => tasks.findIndex((t) => t.id === id) + 1;

  const editOf = (t: AgentRunTask): { title: string; inputText: string; inputKey: string } => {
    const e = draft.edits[t.id];
    const primary = primaryInputText(t.input);
    return {
      title: e?.title ?? t.title,
      inputText: e?.inputText ?? primary.value,
      inputKey: e?.inputKey ?? primary.key,
    };
  };

  const patchEdit = (id: string, patch: Partial<PlanDraft["edits"][string]>): void => {
    setDraft((d) => ({ ...d, edits: { ...d.edits, [id]: { ...d.edits[id], ...patch } } }));
  };

  const removeTask = (id: string): void => {
    setDraft((d) => ({ ...d, removed: [...d.removed, id] }));
  };

  const addTask = (): void => {
    setDraft((d) => ({
      ...d,
      added: [...d.added, { id: `new-${addSeq}`, title: "", inputText: "" }],
    }));
    setAddSeq((n) => n + 1);
  };

  const patchAdded = (id: string, patch: Partial<{ title: string; inputText: string }>): void => {
    setDraft((d) => ({
      ...d,
      added: d.added.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  };

  const dropAdded = (id: string): void => {
    setDraft((d) => ({ ...d, added: d.added.filter((a) => a.id !== id) }));
  };

  /** 汇总编辑痕迹为计划编辑操作序列。 */
  const buildOps = (): AgentPlanEditOp[] => {
    const ops: AgentPlanEditOp[] = [];
    for (const t of tasks) {
      if (draft.removed.includes(t.id)) {
        ops.push({ id: t.id, action: "remove" });
        continue;
      }
      const e = draft.edits[t.id];
      if (!e) continue;
      const op: AgentPlanEditOp = { id: t.id, action: "update" };
      if (e.title !== undefined) op.title = e.title;
      if (e.inputText !== undefined) {
        op.input = { ...t.input, [e.inputKey ?? primaryInputText(t.input).key]: e.inputText };
      }
      ops.push(op);
    }
    for (const a of draft.added) {
      ops.push({
        id: a.id,
        action: "add",
        title: a.title.trim() || "新任务",
        input: { prompt: a.inputText },
      });
    }
    return ops;
  };

  /** 确认执行:有改动先 POST /plan,再 resume(改动→modify,无改动→approve)。 */
  const confirm = async (): Promise<void> => {
    const ops = buildOps();
    try {
      if (ops.length > 0) await onSavePlan(ops);
      await onResume("plan", ops.length > 0 ? "modify" : "approve");
    } catch {
      /* 错误已由 hook 透出到错误条,编辑痕迹保留 */
    }
  };

  /** 打回:reject + feedback。 */
  const reject = async (): Promise<void> => {
    try {
      await onResume("plan", "reject", feedback.trim() || undefined);
    } catch {
      /* 同上 */
    }
  };

  return (
    <section className="agent-plan" aria-label="计划确认门">
      <header className="agent-plan-head">
        <h2 className="agent-plan-title">执行计划(确认后开始生成)</h2>
        <p className="agent-plan-desc">
          可改标题/文案、删任务、加任务;确认后按计划执行,关键节点会再找你
        </p>
      </header>

      <ol className="agent-plan-list">
        {visibleTasks.map((t) => {
          const e = editOf(t);
          const ord = orderOf(t.id);
          return (
            <li key={t.id} className="agent-plan-item">
              <span className="agent-plan-idx" aria-hidden="true">
                {ord}
              </span>
              <div className="agent-plan-body">
                <div className="agent-plan-row">
                  <span className="agent-task-kind">{taskKindLabel(t.kind)}</span>
                  <input
                    className="input agent-plan-title-input"
                    value={e.title}
                    placeholder="任务标题"
                    onChange={(ev) => patchEdit(t.id, { title: ev.target.value })}
                  />
                  <button
                    type="button"
                    className="agent-plan-del"
                    title="删除该任务"
                    aria-label={`删除任务 ${e.title || t.id}`}
                    onClick={() => removeTask(t.id)}
                  >
                    <Icon name="delete" size={14} />
                  </button>
                </div>
                {t.depends_on.length > 0 && (
                  <p className="agent-task-deps">
                    依赖{" "}
                    {t.depends_on
                      .map((d) => {
                        const n = orderOf(d);
                        return n > 0 ? `第 ${n} 步` : d;
                      })
                      .join("、")}
                  </p>
                )}
                <PlanTextarea
                  className="input agent-plan-input"
                  rows={2}
                  value={e.inputText}
                  placeholder="该任务的提示词/文案"
                  onChange={(ev) =>
                    patchEdit(t.id, { inputText: ev.target.value, inputKey: e.inputKey })
                  }
                />
              </div>
            </li>
          );
        })}
        {draft.added.map((a) => (
          <li key={a.id} className="agent-plan-item is-new">
            <span className="agent-plan-idx" aria-hidden="true">
              +
            </span>
            <div className="agent-plan-body">
              <div className="agent-plan-row">
                <span className="agent-task-kind">新任务</span>
                <input
                  className="input agent-plan-title-input"
                  value={a.title}
                  placeholder="任务标题"
                  onChange={(ev) => patchAdded(a.id, { title: ev.target.value })}
                />
                <button
                  type="button"
                  className="agent-plan-del"
                  title="移除该行"
                  aria-label="移除新增任务"
                  onClick={() => dropAdded(a.id)}
                >
                  <Icon name="delete" size={14} />
                </button>
              </div>
              <PlanTextarea
                className="input agent-plan-input"
                rows={2}
                value={a.inputText}
                placeholder="该任务的提示词/文案"
                onChange={(ev) => patchAdded(a.id, { inputText: ev.target.value })}
              />
            </div>
          </li>
        ))}
      </ol>

      <div className="agent-plan-actions">
        <button type="button" className="btn" onClick={addTask} disabled={submitting}>
          <Icon name="plus" size={14} /> 加任务
        </button>
        <span className="agent-plan-actions-gap" />
        {rejecting ? (
          <>
            <textarea
              ref={feedbackRef}
              className="input agent-plan-feedback"
              rows={1}
              value={feedback}
              placeholder="打回原因(方向性批注,可选)"
              onChange={(e) => setFeedback(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-danger"
              disabled={submitting}
              onClick={() => void reject()}
            >
              确认打回
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setRejecting(false)}>
              返回
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
              打回
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting || visibleTasks.length + draft.added.length === 0}
              onClick={() => void confirm()}
            >
              确认执行
            </button>
          </>
        )}
      </div>
    </section>
  );
}

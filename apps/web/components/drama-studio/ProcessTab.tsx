"use client";

import { Icon, type IconName } from "@/components/ui/Icon";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface ProcessTabProps {
  project: UseDramaProjectReturn;
}

// ── M4:创作过程步骤 → 图标 + 中文标签(时间线节点用)──
function processStepMeta(step: string): { icon: IconName; label: string } {
  const s = (step || "").toLowerCase();
  if (s === "storyboard" || s === "storyboard_done")
    return { icon: "filevideo", label: "剧本拆镜" };
  if (s === "generate_video" || s === "generate-video")
    return { icon: "film", label: "视频生成" };
  if (s === "assemble" || s === "assembly")
    return { icon: "manju", label: "合成成片" };
  if (s === "generate_reference" || s === "generate-reference")
    return { icon: "users", label: "角色三视图" };
  if (s === "grid_storyboard" || s === "grid-storyboard")
    return { icon: "canvas", label: "宫格分镜" };
  if (s === "create" || s === "init" || s === "create_project")
    return { icon: "create", label: "创建项目" };
  return { icon: "history", label: step || "步骤" };
}

// 把 ISO 时间戳格式化为「HH:mm:ss」便于时间线左栏展示
function formatStepTs(ts: string): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return ts;
  }
}

// M3.1:任务日志条目状态 → 图标
function taskStatusIcon(status: string): IconName {
  if (status === "running") return "loading";
  if (status === "error") return "error";
  return "success";
}

function taskStatusLabel(status: string): string {
  if (status === "running") return "进行中";
  if (status === "error") return "失败";
  return "已完成";
}

/**
 * M1.3:任务与日志 Tab(原"创作过程"重构)。
 * - 顶部:任务日志(进行中 + 已完成,从 localStorage 恢复,跨刷新)
 * - 下方折叠区:创作历史时间线(原 processSteps 渲染,降级为回放)
 */
export function ProcessTab({ project }: ProcessTabProps) {
  const { taskLog, processSteps, reload, loading, activeTasks } = project;

  return (
    <div className="ds-process-wrap">
      {/* ── 任务日志 ── */}
      <section className="ds-section ds-task-log-section card">
        <div className="ds-section-head">
          <Icon name="history" size={14} />
          <span className="ds-section-title">任务日志</span>
          {activeTasks.length > 0 && (
            <span className="ds-live-dot" title={`${activeTasks.length} 个任务进行中`} />
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm ds-process-refresh"
            onClick={() => reload()}
            disabled={loading}
            title="刷新"
          >
            <Icon
              name="refresh"
              size={12}
              className={loading ? "ds-spin" : undefined}
            />
          </button>
        </div>

        {taskLog.length === 0 ? (
          <div className="ds-empty ds-empty-inline ds-process-empty">
            <Icon name="history" size={20} strokeWidth={1.4} />
            <span>暂无任务记录(启动拆分镜/生成/合成后此处显示)</span>
          </div>
        ) : (
          <ul className="ds-task-log-list">
            {taskLog.slice(0, 30).map((e) => (
              <li
                key={`${e.key}-${e.startedAt}`}
                className={`ds-task-log-item ds-task-${e.status}`}
              >
                <Icon
                  name={taskStatusIcon(e.status)}
                  size={11}
                  className={e.status === "running" ? "ds-spin" : undefined}
                />
                <span className="ds-task-label">{e.label}</span>
                {e.detail && (
                  <span className="ds-task-detail">#{e.detail}</span>
                )}
                <span className="ds-task-status">{taskStatusLabel(e.status)}</span>
                <span className="ds-task-time">
                  {new Date(e.startedAt).toLocaleTimeString("zh-CN", {
                    hour12: false,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 创作历史(折叠区,原时间线)── */}
      <details className="ds-section ds-process-history card" open={taskLog.length === 0}>
        <summary className="ds-section-head ds-process-history-head">
          <Icon name="history" size={14} />
          <span className="ds-section-title">创作历史</span>
          {processSteps.length > 0 && (
            <span className="ds-section-count">{processSteps.length}</span>
          )}
          <span className="ds-process-history-hint">点击展开/收起</span>
        </summary>

        {processSteps.length === 0 ? (
          <div className="ds-empty ds-empty-inline ds-process-empty">
            <Icon name="history" size={20} strokeWidth={1.4} />
            <span>暂无创作过程记录</span>
          </div>
        ) : (
          <ol className="ds-process-timeline">
            {processSteps.map((p, i) => {
              const meta = processStepMeta(p.step);
              const isLast = i === processSteps.length - 1;
              return (
                <li key={`${p.step}-${i}`} className="ds-process-node">
                  <div className="ds-process-ts">
                    <Icon name="queued" size={10} />
                    {formatStepTs(p.ts)}
                  </div>
                  <div className="ds-process-rail">
                    <span
                      className={`ds-process-dot ${
                        isLast ? "ds-process-dot-active" : ""
                      }`}
                    >
                      <Icon name={meta.icon} size={12} />
                    </span>
                    {!isLast && <span className="ds-process-line" />}
                  </div>
                  <div className="ds-process-content">
                    <div className="ds-process-step">
                      {meta.label}
                      <span className="ds-process-step-key">{p.step}</span>
                    </div>
                    {p.detail && (
                      <p className="ds-process-detail">{p.detail}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </details>
    </div>
  );
}

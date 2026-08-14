"use client";

/**
 * 流水线形态(PipelineView · SwimlaneGrid):
 * 按 kind 分泳道(策划/图像/视频/音频/字幕/合成,未知 kind 落「其他」),
 * CSS grid 实现(不引 React Flow),节点 = 缩略卡片(序号 + 状态图标 + 标题 + 依赖序号)。
 */
import type { AgentRunTask } from "@/lib/api";
import { SWIMLANES, swimlaneIndex, taskStatusMeta } from "./agentRunMeta";

export function PipelineView({ tasks }: { tasks: AgentRunTask[] }) {
  const orderOf = (id: string): number => tasks.findIndex((t) => t.id === id) + 1;

  // 分泳道(保持计划内顺序);未知 kind 归入动态「其他」泳道
  const lanes: { key: string; label: string; nodes: AgentRunTask[] }[] = SWIMLANES.map((l) => ({
    key: l.key,
    label: l.label,
    nodes: [],
  }));
  const other: AgentRunTask[] = [];
  for (const t of tasks) {
    const idx = swimlaneIndex(t.kind);
    if (idx >= 0) lanes[idx].nodes.push(t);
    else other.push(t);
  }
  const visible = lanes.filter((l) => l.nodes.length > 0);
  if (other.length > 0) visible.push({ key: "other", label: "其他", nodes: other });

  if (visible.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state-desc">计划任务会出现在这里</p>
      </div>
    );
  }

  return (
    <div className="agent-lanes" role="list" aria-label="流水线泳道">
      {visible.map((lane) => (
        <div key={lane.key} className="agent-lane" role="listitem">
          <span className="agent-lane-label">{lane.label}</span>
          <div className="agent-lane-nodes">
            {lane.nodes.map((t) => {
              const meta = taskStatusMeta(t.status);
              const StatusIcon = meta.icon;
              return (
                <div key={t.id} className="agent-node" data-status={t.status} title={t.title}>
                  <span className="agent-node-idx" aria-hidden="true">
                    {orderOf(t.id)}
                  </span>
                  <StatusIcon
                    size={13}
                    aria-hidden="true"
                    className={`agent-node-icon is-${meta.tone}${meta.spin ? " icon-loading-spin" : ""}`}
                  />
                  <span className="agent-node-title">{t.title || `任务 ${orderOf(t.id)}`}</span>
                  {t.depends_on.length > 0 && (
                    <span className="agent-node-deps">
                      ←{" "}
                      {t.depends_on
                        .map((d) => {
                          const n = orderOf(d);
                          return n > 0 ? String(n) : d;
                        })
                        .join(",")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

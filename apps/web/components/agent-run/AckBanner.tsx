"use client";

/**
 * 秒回横幅(AckBanner):「已拆成 N 步,后台执行,关键节点会找你」。
 * ack 文案优先用创建秒回原文(经 query 透传);缺省按任务数派生。
 */
import { Zap } from "lucide-react";

export function AckBanner({
  ack,
  taskCount,
}: {
  ack?: string | null;
  taskCount: number;
}) {
  const headline =
    ack?.trim() || (taskCount > 0 ? `已拆成 ${taskCount} 步` : "已接单,Leader 拆解中");
  return (
    <div className="agent-ack" role="status">
      <span className="agent-ack-icon" aria-hidden="true">
        <Zap size={16} />
      </span>
      <span className="agent-ack-text">
        <span className="agent-ack-title">{headline}</span>
        <span className="agent-ack-sub">后台执行,关键节点会找你</span>
      </span>
    </div>
  );
}

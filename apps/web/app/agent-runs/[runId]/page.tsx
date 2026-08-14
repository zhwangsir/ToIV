"use client";

/**
 * Agent Team 详情页(R3.1):秒回横幅 / 计划确认门 / 任务卡片流⇄泳道 / 事件汇报流。
 * ack 由列表页创建秒回经 query 透传(?ack=),刷新后按任务数派生兜底。
 */
import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { AgentRunView } from "@/components/agent-run/AgentRunView";
import { useAuthGuard } from "@/components/agent-run/useAuthGuard";

function Splash() {
  return (
    <div className="splash">
      <div className="splash-orb" aria-hidden="true" />
    </div>
  );
}

export default function AgentRunDetailPage() {
  // useSearchParams 需 Suspense 边界(Next 15 构建约束,同 app/page.tsx)
  return (
    <Suspense fallback={<Splash />}>
      <DetailInner />
    </Suspense>
  );
}

function DetailInner() {
  const authed = useAuthGuard();
  const params = useParams<{ runId: string }>();
  const searchParams = useSearchParams();
  if (!authed) return <Splash />;
  const runId = typeof params?.runId === "string" ? params.runId : "";
  if (!runId) return <Splash />;
  return <AgentRunView runId={runId} ack={searchParams.get("ack")} />;
}

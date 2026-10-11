import { redirect } from "next/navigation";

// 融合 F2(2026-10-11):run 详情(计划确认门/任务卡/事件流/合成门)迁入 canvas
// /studio/toiv/runs/:id;深链按 id 转发。
export default async function AgentRunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  redirect(`/studio/toiv/runs/${encodeURIComponent(runId)}`);
}

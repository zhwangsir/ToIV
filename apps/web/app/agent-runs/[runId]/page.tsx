import { redirect } from "next/navigation";

// F12(2026-10-15):Agent 运行详情已迁 canvas(/toiv/runs/:id)——旧深链整页重定向不 404
export default async function AgentRunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  redirect(`/studio/toiv/runs/${encodeURIComponent(runId)}`);
}

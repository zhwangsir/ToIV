import { redirect } from "next/navigation";

// 融合 F2(2026-10-11):Agent 任务列表迁入 canvas 任务中心(/studio/toiv/tasks);
// 本路由保留仅做深链归位,不再渲染经典列表页。
export default function AgentRunsPage() {
  redirect("/studio/toiv/tasks");
}

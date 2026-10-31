import { redirect } from "next/navigation";

// F12(2026-10-15):Agent 任务中心已迁 canvas(F2,/toiv/tasks)——旧路由整页重定向不 404
export default function AgentRunsPage() {
  redirect("/studio/toiv/tasks");
}

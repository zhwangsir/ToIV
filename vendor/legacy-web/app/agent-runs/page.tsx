import { redirect } from "next/navigation";

// F12 / W6：Agent 任务中心 → Prime /tasks
export default function AgentRunsPage() {
  redirect("/studio/tasks");
}

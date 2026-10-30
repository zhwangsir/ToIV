import { cancelJob, fetchJobs } from "@/services/toiv/client";
import { fetchAgentSessions } from "@/services/toiv/agent-chat";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import type { StudioStatus } from "@/studio/ui/StatusDot";

export type StudioTaskItem = {
    id: string;
    source: "job" | "canvas" | "agent";
    title: string;
    status: StudioStatus;
    progress?: number;
    sub?: string;
    cancellable: boolean;
};

function jobStatus(status: string): StudioStatus {
    if (/run|pend|queue|process/i.test(status)) return "run";
    if (/done|success|complete|finish/i.test(status)) return "done";
    return "wait";
}

export async function loadStudioTasks(): Promise<StudioTaskItem[]> {
    const [jobs, sessions] = await Promise.all([
        fetchJobs(50).catch(() => []),
        fetchAgentSessions().catch(() => []),
    ]);
    const jobItems: StudioTaskItem[] = jobs.map((job) => ({
        id: job.id,
        source: "job",
        title: `${job.kind ?? "作业"} · ${job.id.slice(0, 8)}`,
        status: jobStatus(job.status),
        progress: (job.progress as { percent?: number } | undefined)?.percent,
        sub: job.error ?? job.hold_reason ?? job.created_at,
        cancellable: jobStatus(job.status) === "run",
    }));
    const canvasItems: StudioTaskItem[] = Object.entries(useSyncProgressStore.getState().syncingProjects).map(([key, value]) => ({
        id: `canvas-${key}`,
        source: "canvas",
        title: `画布同步 · ${key.slice(0, 8)}`,
        status: "run",
        progress: (value as { percent?: number }).percent,
        sub: "本地画布与后端同步中",
        cancellable: false,
    }));
    const agentItems: StudioTaskItem[] = sessions.slice(0, 20).map((session) => {
        const row = session as { id: string; title?: string; name?: string; updated_at?: string };
        return {
            id: `agent-${row.id}`,
            source: "agent" as const,
            title: row.title ?? row.name ?? `会话 ${row.id.slice(0, 8)}`,
            status: "wait" as StudioStatus,
            sub: row.updated_at,
            cancellable: false,
        };
    });
    return [...jobItems, ...canvasItems, ...agentItems];
}

export async function cancelStudioTask(item: StudioTaskItem): Promise<boolean> {
    if (item.source !== "job") return false;
    return cancelJob(item.id);
}

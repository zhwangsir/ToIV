import type { GenerationTask, TaskStatus } from "@/services/api/task-center";
import type { ToivJob, ToivJobRuntime } from "@/services/toiv/client";
import { assetLooksNsfw, isNsfwAssetSelectable, type NsfwAssetLike } from "@/redline";

export const statusLabel: Record<TaskStatus, string> = {
    queued: "排队中",
    running: "生成中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
};

type GenerationTaskDisplayTarget = Pick<GenerationTask, "status" | "stage">;

export function isGenerationTaskSubmissionUncertain(task: GenerationTaskDisplayTarget) {
    return task.stage === "submission_unknown";
}

export function generationTaskStatusLabel(task: GenerationTaskDisplayTarget) {
    if (isGenerationTaskSubmissionUncertain(task)) return "提交结果待确认";
    return statusLabel[task.status];
}

export function generationTaskStageLabel(task: GenerationTaskDisplayTarget) {
    if (isGenerationTaskSubmissionUncertain(task)) return "为避免重复创建上游任务，未自动重试";
    if (task.stage === "generating") return "生成中";
    if (task.stage === "queued") return "排队中";
    return task.stage || generationTaskStatusLabel(task);
}

export function generationTaskShowsProgress(task: GenerationTaskDisplayTarget) {
    if (isGenerationTaskSubmissionUncertain(task)) return false;
    // 排队、后端接管和连接供应商都没有真实百分比。只有上游状态响应
    // 已经写回任务后才显示进度，避免所有图片/视频长期停在同一个假数值。
    if (["等待队列调度", "后端接管任务", "正在连接上游", "调用生成模型"].includes(task.stage || "")) return false;
    return true;
}

export type GenerationTaskArtifactState = "pending" | "materializing" | "ready" | "missing" | "failed";
export type GenerationTaskNextAction = "retry" | "cancel" | "view" | "logs" | "diagnose";
export type GenerationTaskProjection = {
    artifactState: GenerationTaskArtifactState;
    artifactLabel: string;
    nextAction: GenerationTaskNextAction;
    nextLabel: string;
    nextReason: string;
    providerRequestId?: string;
};

export type GenerationTaskProjectionInput = Pick<
    GenerationTask,
    "status" | "stage" | "previewUrl" | "outputs" | "resultState" | "error" | "failureDiagnostics" | "providerRequestId"
>;

export function generationTaskProjection(task: GenerationTaskProjectionInput): GenerationTaskProjection {
    const hasMaterializedOutput = Boolean(task.previewUrl || task.outputs?.some((output) => output.materializedAssetId));
    const artifactState: GenerationTaskArtifactState = hasMaterializedOutput || task.resultState === "READY"
        ? "ready"
        : task.resultState === "FAILED_RETRYABLE" || task.resultState === "FAILED_PERMANENT"
          ? "failed"
          : task.resultState === "NOT_AVAILABLE" || task.status === "failed"
            ? "missing"
            : task.resultState === "MATERIALIZING"
              ? "materializing"
              : "pending";
    const artifactLabel = {
        pending: "产物待生成",
        materializing: "产物入库中",
        ready: "产物可用",
        missing: "产物缺失",
        failed: "产物失败",
    }[artifactState];
    const nextAction: GenerationTaskNextAction = isGenerationTaskSubmissionUncertain(task)
        ? "diagnose"
        : task.status === "failed"
          ? "retry"
          : task.status === "queued" || task.status === "running"
            ? "cancel"
            : artifactState === "ready"
              ? "view"
              : "logs";
    const nextLabel = { retry: "重试", cancel: "取消任务", view: "查看产物", logs: "查看日志", diagnose: "查看诊断" }[nextAction];
    const nextReason = task.error || task.failureDiagnostics?.summary || generationTaskStageLabel(task);
    const providerRequestId = task.providerRequestId || task.failureDiagnostics?.requestId || task.failureDiagnostics?.providerTaskId || undefined;
    return { artifactState, artifactLabel, nextAction, nextLabel, nextReason, providerRequestId };
}

export type GenerationSource =
    | { source: "canvas-task"; task: GenerationTask }
    | { source: "toiv-job"; task: ToivJob };

export type GenerationSourceHealth = {
    state: ToivJobRuntime["state"];
    label: string;
    reason: string;
    lastEvidenceAt: number | null;
    ageSeconds: number | null;
    evidence: ToivJobRuntime["evidence"] | "state_updated_at";
};

export type GenerationSourceProjection = GenerationTaskProjection & {
    source: GenerationSource["source"];
    sourceId: string;
    id: string;
    task: GenerationTask | ToivJob;
    title: string;
    kindLabel: string;
    createdAt: string;
    sortTimestamp: number;
    status: TaskStatus;
    statusLabel: string;
    stageLabel: string;
    health: GenerationSourceHealth;
    progressPct?: number;
    progressUpdatedAt: number | null;
    showsProgress: boolean;
    isActive: boolean;
    canCancel: boolean;
    canRetry: boolean;
    previewUrl?: string;
    previewKind?: "image" | "video";
};

const TOIV_ACTIVE_STATUSES = new Set(["queued", "pending", "held", "running", "processing"]);

function generationTimestamp(value: string): number {
    const text = value.trim();
    if (!text) return 0;
    const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) && !hasTimezone
        ? `${text}Z`
        : text;
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function toivTaskStatus(job: ToivJob): { status: TaskStatus; label: string } {
    if (job.status === "held") return { status: "queued", label: "等待资源" };
    if (job.status === "queued" || job.status === "pending") return { status: "queued", label: "排队中" };
    if (job.status === "running" || job.status === "processing") return { status: "running", label: "运行中" };
    if (job.status === "done" || job.status === "succeeded") return { status: "succeeded", label: "已完成" };
    if (job.status === "error" || job.status === "failed") return { status: "failed", label: "失败" };
    if (job.status === "canceled" || job.status === "cancelled") return { status: "cancelled", label: "已取消" };
    return { status: "queued", label: job.status || "未知状态" };
}

type ToivGenerationDisplayTask = GenerationTaskProjectionInput & Pick<
    GenerationTask,
    "id" | "projectId" | "type" | "progress" | "prompt" | "previewKind" | "createdAt" | "updatedAt"
>;

function toivGenerationTask(job: ToivJob): ToivGenerationDisplayTask {
    const status = toivTaskStatus(job).status;
    const previewUrl = job.results?.find((result) => Boolean(result?.trim()));
    return {
        id: job.id,
        projectId: job.project_id,
        type: job.kind || "toiv_job",
        status,
        progress: job.progress?.pct ?? undefined,
        stage: job.status === "held" ? job.hold_reason : job.progress?.phase_label || job.progress?.phase,
        prompt: job.prompt || "",
        error: job.error,
        previewUrl,
        previewKind: previewUrl && /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(previewUrl) ? "video" : "image",
        resultState: status === "failed"
            ? "FAILED_RETRYABLE"
            : status === "succeeded"
              ? previewUrl ? "READY" : "NOT_AVAILABLE"
              : undefined,
        createdAt: job.created_at,
        updatedAt: job.created_at,
    };
}

function toivHealth(runtime: ToivJobRuntime | undefined): GenerationSourceHealth {
    if (!runtime) {
        return {
            state: "unknown",
            label: "健康未知",
            reason: "服务端未提供 runtime，无法判断执行健康",
            lastEvidenceAt: null,
            ageSeconds: null,
            evidence: "none",
        };
    }
    return {
        state: runtime.state,
        label: runtime.label || "健康未知",
        reason: runtime.reason || "服务端未提供健康原因",
        lastEvidenceAt: runtime.last_evidence_at,
        ageSeconds: runtime.age_seconds,
        evidence: runtime.evidence,
    };
}

export function generationSourceProjection(input: GenerationSource): GenerationSourceProjection {
    const isToiv = input.source === "toiv-job";
    const task = isToiv ? toivGenerationTask(input.task as ToivJob) : input.task as GenerationTask;
    const projection = generationTaskProjection(task);
    const sourceId = `${input.source}:${task.id}`;
    const createdAt = isToiv ? (input.task as ToivJob).created_at : (input.task as GenerationTask).createdAt;
    const isActive = isToiv
        ? TOIV_ACTIVE_STATUSES.has((input.task as ToivJob).status)
        : task.status === "queued" || task.status === "running";
    const status = isToiv ? toivTaskStatus(input.task as ToivJob) : { status: task.status, label: generationTaskStatusLabel(task) };
    const health: GenerationSourceHealth = isToiv
        ? toivHealth((input.task as ToivJob).runtime)
        : {
              state: "unknown",
              label: "健康未知",
              reason: "updatedAt 仅表示任务状态更新证据，不是 worker 心跳",
              lastEvidenceAt: (input.task as GenerationTask).updatedAt ? generationTimestamp((input.task as GenerationTask).updatedAt) : null,
              ageSeconds: null,
              evidence: "state_updated_at",
          };
    const rawPct = task.progress;
    const progressPct = isToiv
        ? typeof rawPct === "number" && Number.isFinite(rawPct) ? Math.max(0, Math.min(100, Math.round(rawPct))) : undefined
        : generationTaskShowsProgress(task)
          ? typeof rawPct === "number" && Number.isFinite(rawPct) ? Math.max(0, Math.min(100, Math.round(rawPct))) : task.status === "queued" ? 0 : undefined
          : undefined;
    return {
        ...projection,
        source: input.source,
        sourceId,
        id: task.id,
        task: input.task,
        title: task.prompt || "(无提示摘要)",
        kindLabel: isToiv ? (input.task as ToivJob).kind || "ToIV 作业" : formatTaskKind(task),
        createdAt,
        sortTimestamp: generationTimestamp(createdAt),
        status: status.status,
        statusLabel: status.label,
        stageLabel: generationTaskStageLabel(task),
        health,
        progressPct,
        progressUpdatedAt: isToiv ? (input.task as ToivJob).progress?.updated_at ?? null : null,
        showsProgress: isToiv ? isActive : generationTaskShowsProgress(task),
        isActive,
        canCancel: isActive && projection.nextAction === "cancel",
        canRetry: projection.nextAction === "retry",
        previewUrl: task.previewUrl,
        previewKind: task.previewKind,
    };
}

export function mergeGenerationSourceProjections(
    canvasTasks: readonly GenerationTask[],
    toivJobs: readonly ToivJob[],
    options: { projectId?: string; limit?: number } = {},
): GenerationSourceProjection[] {
    const sources: GenerationSource[] = [
        ...canvasTasks.filter((task) => !options.projectId || task.projectId === options.projectId).map((task) => ({ source: "canvas-task" as const, task })),
        ...toivJobs.filter((job) => !options.projectId || job.project_id === options.projectId).map((task) => ({ source: "toiv-job" as const, task })),
    ];
    return sources
        .map(generationSourceProjection)
        .sort((left, right) => right.sortTimestamp - left.sortTimestamp || left.sourceId.localeCompare(right.sourceId))
        .slice(0, options.limit ?? 40);
}

export function generationSourceNsfwLike(input: GenerationSource): NsfwAssetLike {
    if (input.source === "canvas-task") return generationTaskNsfwLike(input.task);
    const task = toivGenerationTask(input.task);
    return {
        id: task.id,
        label: task.prompt,
        basename: task.type,
        value: [task.prompt, task.type, task.error].filter(Boolean).join("\n"),
        nsfw: input.task.nsfw,
    };
}

export function generationTaskNsfwLike(task: GenerationTask): NsfwAssetLike {
    return {
        id: task.id,
        label: task.prompt,
        basename: task.model || task.type,
        value: [task.prompt, task.model, task.type, task.operation, task.error].filter(Boolean).join("\n"),
    };
}

export function generationTaskNsfwLocked(task: GenerationTask): boolean {
    const like = generationTaskNsfwLike(task);
    return assetLooksNsfw(like) && !isNsfwAssetSelectable(like);
}

export const operationOptions = [
    { label: "文生视频", value: "text_to_video" },
    { label: "图生视频", value: "image_to_video" },
    { label: "全模态参考", value: "reference_to_video" },
    { label: "视频续写", value: "extend" },
    { label: "视频局部修改", value: "inpaint" },
    { label: "元素替换", value: "replace_element" },
    { label: "镜头/运镜调整", value: "camera_motion" },
    { label: "风格迁移", value: "style_transfer" },
    { label: "参考音频生成视频", value: "audio_to_video" },
    { label: "结果版本对比", value: "compare_versions" },
];

export const operationLabelByValue = new Map(operationOptions.map((item) => [item.value, item.label]));

export const taskTypeLabel: Record<string, string> = {
    canvas_image: "画布生图",
    canvas_video: "画布视频",
    canvas_audio: "画布音频",
    canvas_text: "画布文本",
};

export function formatTaskKind(task: Pick<GenerationTask, "type" | "operation">) {
    const typeLabel = taskTypeLabel[task.type];
    const operationLabel = task.operation ? operationLabelByValue.get(task.operation) : "";

    if (task.type === "canvas_video" && operationLabel) return `${typeLabel || "画布视频"} · ${operationLabel}`;
    if (typeLabel) return typeLabel;
    if (operationLabel) return operationLabel;
    if (task.type.startsWith("video_")) return "视频任务";
    return "生成任务";
}

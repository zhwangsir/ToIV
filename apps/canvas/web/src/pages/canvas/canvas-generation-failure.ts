import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { explainGenerationError, generationFailureMetadata, generationPromptFingerprint, shouldBlockAutomaticRetry, unchangedModeratedPrompt } from "@/lib/generation-error";
import { findRetrySourceNode } from "@/lib/canvas/canvas-project-generation";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";

type GenerationReference = { id?: string; storageKey?: string; url?: string; dataUrl?: string };
export type CanvasGenerationFailureInput = {
    mode?: "text" | "image" | "video" | "audio";
    prompt: string;
    referenceImages?: GenerationReference[];
    referenceVideos?: GenerationReference[];
    referenceAudios?: GenerationReference[];
    mask?: GenerationReference;
};

function submittedReferences(input: CanvasGenerationFailureInput) {
    if (input.mode === "audio") return [];
    const videos = input.mode === "image" ? [] : input.referenceVideos || [];
    const audios = input.mode === "image" || input.mode === "text" ? [] : input.referenceAudios || [];
    return [...(input.referenceImages || []), ...videos, ...audios, ...(input.mask ? [input.mask] : [])].map((reference) => ({
        id: reference.storageKey || reference.url || reference.dataUrl ? undefined : reference.id,
        // Blob URLs and signed download URLs may change while the stored input stays the same.
        ...(reference.storageKey ? { storageKey: reference.storageKey } : { url: reference.url || reference.dataUrl }),
    }));
}

export function canvasGenerationFailureMetadata(error: unknown, input: CanvasGenerationFailureInput) {
    const failure = generationFailureMetadata(error, input.prompt, submittedReferences(input));
    return { ...failure, ...(failure.generationErrorCode === "canvas_conflict" ? { resourceReloadAvailable: true } : {}) };
}

export function canvasTaskFailureMetadata(task: GenerationTask, metadata?: CanvasNodeMetadata, error: unknown = { code: task.errorCode, message: task.error || (task.status === "cancelled" ? "任务已取消" : "任务失败") }) {
    let input: CanvasGenerationFailureInput = { prompt: task.prompt || metadata?.prompt || "" };
    try {
        const stored = JSON.parse(task.inputJson || "{}");
        if (stored && typeof stored === "object") {
            const references = (value: unknown): GenerationReference[] => (Array.isArray(value) ? value.filter((item): item is GenerationReference => Boolean(item && typeof item === "object")) : []);
            input = { ...input, referenceImages: references(stored.referenceImages), referenceVideos: references(stored.referenceVideos), referenceAudios: references(stored.referenceAudios), mask: references([stored.mask])[0] };
        }
    } catch {
        // Older task records may not carry a readable submission snapshot.
    }
    const failure = canvasGenerationFailureMetadata(error, input);
    if (failure.failedInputFingerprint && task.id === metadata?.taskId && metadata.failedInputFingerprint) {
        failure.failedInputFingerprint = metadata.failedInputFingerprint;
        failure.failedPromptFingerprint = metadata.failedPromptFingerprint;
    }
    const diagnostics = task.status === "succeeded" ? { ...task.failureDiagnostics, source: "client_result" as const, summary: failure.generationErrorSummary, stage: "画布应用结果", capturedAt: new Date().toISOString() } : task.failureDiagnostics;
    return { ...failure, taskFailureDiagnostics: diagnostics, taskProviderRequestId: task.providerRequestId };
}


function liveFailureModeForNode(node: CanvasNodeData): CanvasGenerationFailureInput["mode"] {
    if (node.type === CanvasNodeType.Text) return "text";
    if (node.type === CanvasNodeType.Image) return "image";
    if (node.type === CanvasNodeType.Video) return "video";
    if (node.type === CanvasNodeType.Audio) return "audio";
    return node.metadata?.generationMode;
}

/** Resolve the prompt+references the next retry would submit, for fingerprint UI. */
export function resolveCanvasLiveFailureInput(
    node: CanvasNodeData,
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    assets: Asset[] = [],
): CanvasGenerationFailureInput {
    const batchRoot = node.metadata?.batchRootId ? nodes.find((item) => item.id === node.metadata?.batchRootId) : null;
    const originalSourceId = node.metadata?.generatedFromNodeId || batchRoot?.metadata?.generatedFromNodeId;
    const originalSource = originalSourceId ? nodes.find((item) => item.id === originalSourceId) : undefined;
    const sourceNode = originalSource || findRetrySourceNode(node.id, nodes, connections) || batchRoot || node;
    const mode = liveFailureModeForNode(node);
    const promptSource = sourceNode.metadata?.composerContent || sourceNode.metadata?.prompt || node.metadata?.prompt || "";
    try {
        const context = buildNodeGenerationContext(sourceNode.id, nodes, connections, promptSource, assets, mode === "video");
        return {
            mode,
            prompt: context.prompt,
            referenceImages: context.referenceImages,
            referenceVideos: context.referenceVideos,
            referenceAudios: context.referenceAudios,
        };
    } catch {
        const references = Array.isArray(node.metadata?.references)
            ? node.metadata.references.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
            : [];
        return {
            mode,
            prompt: promptSource,
            referenceImages: references.map((url, index) => ({ id: `ref-${index}`, url })),
        };
    }
}

/** Notice prop: no live input → blocked; otherwise same gate as retry submission. */
export function canvasFailureRetryBlockedByFingerprint(metadata: CanvasNodeMetadata | undefined, liveInput?: CanvasGenerationFailureInput) {
    const error = { code: metadata?.generationErrorCode || metadata?.taskErrorCode, message: metadata?.errorDetails };
    if (!explainGenerationError(error).contentGate) return false;
    if (!liveInput) return true;
    return canvasGenerationRetryBlocked(metadata, liveInput);
}

export function canvasGenerationRetryBlocked(metadata: CanvasNodeMetadata | undefined, input?: CanvasGenerationFailureInput) {
    const error = { code: metadata?.generationErrorCode || metadata?.taskErrorCode, message: metadata?.errorDetails };
    if (!shouldBlockAutomaticRetry(error, metadata?.taskStage)) return false;
    // 提交状态未确认时改输入也不能重提，否则会重复计费/重复任务。
    if (metadata?.taskStage === "submission_unknown") return true;
    const explained = explainGenerationError(error);
    // Only a resolved submission can prove that gated input was changed.
    if (input && explained.contentGate) {
        if (!metadata?.failedInputFingerprint) return !metadata?.failedPromptFingerprint || metadata.failedPromptFingerprint === generationPromptFingerprint(input.prompt);
        return unchangedModeratedPrompt(metadata, input.prompt, submittedReferences(input));
    }
    if (input) return metadata?.taskStage === "submission_unknown" || ["submission_uncertain", "timeout", "download_failed", "results_missing", "partial_success", "canvas_conflict"].includes(explained.category);
    return true;
}

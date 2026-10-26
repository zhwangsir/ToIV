import { Copy, Eye, RefreshCw, ShieldAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

import { formatGenerationDiagnostics, type GenerationFailureContext, type GenerationFailureExplanation } from "@/lib/generation-error";
import { navigateToR18SettingsGate } from "@/lib/settings-navigation";
import { COPY_SWITCH_TO_ADULT } from "@/redline";
import { isR18Mode } from "@/services/toiv/r18-mode";

type GenerationFailureNoticeProps = {
    explanation: GenerationFailureExplanation;
    context?: GenerationFailureContext;
    compact?: boolean;
    onRetry?: () => void;
    retryLabel?: string;
    onOpenDetails?: () => void;
    retryDisabled?: boolean;
    /**
     * 审核/R18 闸：指纹未变时 true（默认）；指纹已变传 false →「新建尝试」。
     * 额度/限流等非内容类忽略此字段。
     */
    retryBlockedByFingerprint?: boolean;
    /** 次按钮：换模型（可选） */
    onChangeModel?: () => void;
};

export function GenerationFailureNotice({
    explanation,
    context,
    compact,
    onRetry,
    retryLabel,
    onOpenDetails,
    retryDisabled,
    retryBlockedByFingerprint,
    onChangeModel,
}: GenerationFailureNoticeProps) {
    const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
    const diagnostics = formatGenerationDiagnostics(explanation, context);
    const r18On = typeof window !== "undefined" ? isR18Mode() : false;
    const guideR18 = explanation.guideEnableR18 && !r18On;
    const adultGate =
        explanation.category === "r18_context_required" ||
        explanation.category === "route_guard_adult" ||
        explanation.slot === "route_guard_adult";
    const contextUpdated = adultGate && r18On;
    const policyRetry = Boolean(onRetry) && (explanation.moderation || adultGate) && !retryDisabled;
    const fingerprintBlocked = retryBlockedByFingerprint !== false;
    const showNewAttempt = policyRetry && !fingerprintBlocked;
    const showBlockedRetry = policyRetry && fingerprintBlocked;
    const showNormalRetry = Boolean(onRetry) && !explanation.blockAutomaticRetry && !retryDisabled && !policyRetry;
    const requestId = explanation.requestId || context?.providerRequestId;

    const markCopied = async (value: string) => {
        try {
            if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else if (!fallbackCopy(value)) {
                throw new Error("copy failed");
            }
            setCopyState("copied");
            window.setTimeout(() => setCopyState("idle"), 1600);
        } catch {
            setCopyState("failed");
            window.setTimeout(() => setCopyState("idle"), 2200);
        }
    };

    const secondary: ReactNode[] = [];
    if (onOpenDetails) {
        secondary.push(
            <button
                key="details"
                type="button"
                className="generation-failure-button"
                onClick={(event) => {
                    event.stopPropagation();
                    onOpenDetails();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <Eye className="size-3.5" />
                {explanation.uncertain ? "查看原任务" : "查看详情"}
            </button>,
        );
    }
    if (requestId) {
        secondary.push(
            <button
                key="request-id"
                type="button"
                className="generation-failure-button"
                data-testid="generation-failure-copy-request-id"
                onClick={(event) => {
                    event.stopPropagation();
                    void markCopied(requestId);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <Copy className="size-3.5" />
                {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制 requestId"}
            </button>,
        );
    } else if (diagnostics) {
        secondary.push(
            <button
                key="diagnostics"
                type="button"
                className="generation-failure-button"
                onClick={(event) => {
                    event.stopPropagation();
                    void markCopied(diagnostics);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <Copy className="size-3.5" />
                {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制排查信息"}
            </button>,
        );
    }
    if (onChangeModel && !guideR18) {
        secondary.push(
            <button
                key="change-model"
                type="button"
                className="generation-failure-button"
                onClick={(event) => {
                    event.stopPropagation();
                    onChangeModel();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                换模型
            </button>,
        );
    }

    return (
        <div className={`generation-failure-notice${compact ? " is-compact" : ""}`} data-failure-slot={explanation.slot}>
            {explanation.slotLabel ? (
                <span className="generation-failure-slot" data-testid="generation-failure-slot">
                    {explanation.slotLabel}
                </span>
            ) : null}
            <p className="generation-failure-reason">{explanation.reason}</p>
            {contextUpdated ? (
                <p className="generation-failure-action">模式已更新 · 改输入后新建尝试</p>
            ) : explanation.action ? (
                <p className="generation-failure-action">{explanation.action}</p>
            ) : null}
            {showBlockedRetry ? <p className="generation-failure-hint">请先修改提示词或参考</p> : null}
            <div className="generation-failure-actions">
                {guideR18 ? (
                    <button
                        type="button"
                        className="generation-failure-button is-primary"
                        data-testid="generation-failure-enable-r18"
                        onClick={(event) => {
                            event.stopPropagation();
                            navigateToR18SettingsGate();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <ShieldAlert className="size-3.5" />
                        {COPY_SWITCH_TO_ADULT}
                    </button>
                ) : null}
                {showNewAttempt ? (
                    <button
                        type="button"
                        className="generation-failure-button is-primary"
                        data-testid="generation-failure-new-attempt"
                        onClick={(event) => {
                            event.stopPropagation();
                            onRetry?.();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <RefreshCw className="size-3.5" />
                        {retryLabel || "新建尝试"}
                    </button>
                ) : null}
                {showBlockedRetry ? (
                    <button type="button" className="generation-failure-button" disabled data-testid="generation-failure-retry-blocked">
                        <RefreshCw className="size-3.5" />
                        {retryLabel || "新建尝试"}
                    </button>
                ) : null}
                {showNormalRetry ? (
                    <button
                        type="button"
                        className="generation-failure-button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onRetry?.();
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <RefreshCw className="size-3.5" />
                        {retryLabel || "重新生成"}
                    </button>
                ) : null}
                {secondary.slice(0, 2)}
            </div>
        </div>
    );
}

function fallbackCopy(value: string) {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
}

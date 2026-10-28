import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ToolButton } from "@/components/ui/base/buttons";
import {
    canConfirmRenderEstimate,
    renderEstimateError,
    renderEstimateErrorStage,
    renderEstimatePricing,
} from "@/lib/render-estimate";
import {
    estimateBatchRender,
    estimateShotRender,
    type RenderShotAsyncOpts,
    type ToivRenderEstimate,
    type ToivRenderPipeline,
    type ToivStageId,
} from "@/services/toiv/client";

import "./render-cost-estimate.css";

type RenderCostEstimateProps = {
    scope: "batch" | "shot";
    projectId: string;
    shotId?: string;
    open: boolean;
    accel: string;
    pipeline: ToivRenderPipeline;
    detail?: unknown;
    renderOptions?: RenderShotAsyncOpts;
    onConfirm?: () => void;
    onCancel?: () => void;
    onResolved?: (allowed: boolean) => void;
    onStageFocus?: (stage: ToivStageId) => void;
    onKeyframeFocus?: () => void;
};

export function RenderCostEstimate({
    scope,
    projectId,
    shotId,
    open,
    accel,
    pipeline,
    detail,
    renderOptions,
    onConfirm,
    onCancel,
    onResolved,
    onStageFocus,
    onKeyframeFocus,
}: RenderCostEstimateProps) {
    const [loading, setLoading] = useState(false);
    const [estimate, setEstimate] = useState<ToivRenderEstimate | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [errorStage, setErrorStage] = useState<ToivStageId | null>(null);
    const [retry, setRetry] = useState(0);
    const sequence = useRef(0);
    const resolvedRef = useRef(onResolved);
    const optionsKey = JSON.stringify(renderOptions ?? {});

    useEffect(() => {
        resolvedRef.current = onResolved;
    }, [onResolved]);

    useEffect(() => {
        const seq = ++sequence.current;
        if (!open || (scope === "shot" && !shotId)) return;
        setLoading(true);
        setEstimate(null);
        setError(null);
        setErrorStage(null);
        const request = scope === "batch"
            ? estimateBatchRender(projectId, { accel, pipeline })
            : estimateShotRender(shotId!, { ...renderOptions, accel, pipeline });
        void request.then((result) => {
            if (sequence.current !== seq) return;
            if (result.project_id !== projectId || result.scope !== scope || (scope === "shot" && result.shot_id !== shotId)) return;
            setEstimate(result);
            setLoading(false);
            resolvedRef.current?.(result.allowed);
        }).catch((caught: unknown) => {
            if (sequence.current !== seq) return;
            setError(renderEstimateError(caught));
            setErrorStage(renderEstimateErrorStage(caught));
            setLoading(false);
            resolvedRef.current?.(false);
        });
        return () => { sequence.current += 1; };
    }, [open, scope, projectId, shotId, accel, pipeline, detail, optionsKey, retry]);

    const retryRequest = useCallback(() => setRetry((value) => value + 1), []);
    const canConfirm = canConfirmRenderEstimate({ loading, error, estimate });
    const pricing = estimate ? renderEstimatePricing(estimate) : null;

    return (
        <section
            className="render-cost-estimate"
            data-testid="render-cost-estimate"
            data-project-id={projectId}
            data-fingerprint={estimate?.input_fingerprint ?? ""}
            aria-live="polite"
        >
            <div className="render-cost-estimate__heading">
                <strong>成本预估</strong>
                <ToolButton size="xs" variant="ghost" icon={<RefreshCw />} label={error ? "重试" : "重新估算"} loading={loading} onClick={retryRequest} />
            </div>
            {loading && <p className="render-cost-estimate__muted">正在按当前配置估算，确认暂不可用…</p>}
            {error && (
                <div className="render-cost-estimate__error" role="alert">
                    <p>{error}</p>
                    <p>预估失败，不能视为免费或放行渲染。</p>
                    {errorStage && <ToolButton size="xs" variant="default" label="处理阶段阻断" onClick={() => onStageFocus?.(errorStage)} />}
                </div>
            )}
            {estimate && pricing && (
                <>
                    <div className="render-cost-estimate__work">
                        <span>待渲染 {estimate.work.shot_count} 镜</span>
                        <span>候选上限 {estimate.work.candidate_upper_bound}</span>
                        <span>{estimate.work.requested_duration_sec} 秒 / {estimate.work.requested_frame_count} 帧</span>
                    </div>
                    <ol className="render-cost-estimate__items">
                        {estimate.items.slice(0, 3).map((item) => (
                            <li key={item.shot_id}>#{item.idx} · {item.engine}/{item.pipeline} · 候选 {item.candidates} · {item.duration_sec} 秒 / {item.frames} 帧</li>
                        ))}
                        {estimate.items.length > 3 && <li>… 共 {estimate.items.length} 镜</li>}
                    </ol>
                    <div className={pricing.budgetExceeded ? "render-cost-estimate__price render-cost-estimate__price--blocked" : "render-cost-estimate__price"}>
                        <strong>{pricing.totalLabel}</strong>
                        <span>{pricing.budgetLabel}</span>
                    </div>
                    <p className="render-cost-estimate__muted">{pricing.note}</p>
                    <p className="render-cost-estimate__muted">工作量按候选上限与项目 fps 估算，不是实际 GPU 消耗或耗时。</p>
                    {estimate.warnings.map((warning) => <p className="render-cost-estimate__warning" key={`${warning.code}:${warning.message}`}>{warning.message}</p>)}
                    {estimate.blockers.map((blocker) => {
                        const keyframe = blocker.code === "KEYFRAME_REQUIRED";
                        const stage = blocker.stage;
                        return (
                            <div className="render-cost-estimate__blocker" key={`${blocker.code}:${blocker.message}`}>
                                <span>{blocker.message}</span>
                                {keyframe && <ToolButton size="xs" variant="default" label="前往分镜准备" onClick={onKeyframeFocus} />}
                                {!keyframe && stage && <ToolButton size="xs" variant="default" label="处理阶段阻断" onClick={() => onStageFocus?.(stage)} />}
                            </div>
                        );
                    })}
                    <small className="render-cost-estimate__fingerprint">输入指纹 {estimate.input_fingerprint}</small>
                </>
            )}
            {(onConfirm || onCancel) && (
                <div className="render-cost-estimate__actions">
                    {onConfirm && <ToolButton variant="default" label="确认并开始整批渲染" disabled={!canConfirm} onClick={onConfirm} />}
                    {onCancel && <ToolButton variant="ghost" label="取消" onClick={onCancel} />}
                </div>
            )}
        </section>
    );
}

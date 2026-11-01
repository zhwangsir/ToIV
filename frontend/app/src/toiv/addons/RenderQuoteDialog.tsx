import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import type { PrimeRenderEstimate, PrimeRenderOptions, PrimeRenderScope } from "../adapters/render";
import { PRIME_STAGES, type PrimeStageId } from "../adapters/stages";
import type { PrimeShotCard } from "../adapters/storyboard";

export type PrimeQuoteState = {
    scope: PrimeRenderScope;
    shot?: PrimeShotCard;
    options: PrimeRenderOptions;
    phase: "loading" | "ready" | "error";
    estimate: PrimeRenderEstimate | null;
    error: string;
    submitting: boolean;
    submitError: string;
};

type Props = {
    quote: PrimeQuoteState | null;
    onClose: () => void;
    onRetry: () => void;
    onConfirm: () => void;
    onFixStage: (stage: PrimeStageId) => void;
};

const money = (total: string | null, currency: string | null) =>
    total && currency ? `${total} ${currency}` : null;

function budgetLine(estimate: PrimeRenderEstimate): string {
    const limit = money(estimate.budget.limit, estimate.budget.currency);
    if (estimate.budget.status === "disabled") return "未设预算上限";
    if (estimate.budget.status === "within") return `预算内${limit ? ` · 上限 ${limit}` : ""}`;
    if (estimate.budget.status === "exceeded") return `超预算${limit ? ` · 上限 ${limit}` : ""}`;
    return `预算未定价${limit ? ` · 上限 ${limit}` : ""}`;
}

function confirmReason(estimate: PrimeRenderEstimate | null, submitting: boolean): string {
    if (submitting) return "正在提交，请稍候";
    if (!estimate) return "尚未取得报价";
    if (!estimate.allowed) return "存在阻断项，处理后才能提交";
    if (estimate.work.shotCount === 0) return "没有待渲染镜头";
    return "";
}

function stageLabel(id: string): string {
    return PRIME_STAGES.find(stage => stage.id === id)?.label ?? id;
}

export default function RenderQuoteDialog({ quote, onClose, onRetry, onConfirm, onFixStage }: Props) {
    if (!quote) return null;
    const estimate = quote.estimate;
    const reason = quote.phase === "ready" ? confirmReason(estimate, quote.submitting) : "尚未取得报价";
    const price = estimate ? money(estimate.pricing.total, estimate.pricing.currency) : null;
    return (
        <Modal open onClose={() => { if (!quote.submitting) onClose(); }}
            title={`渲染报价 · ${quote.scope === "batch" ? "整批" : quote.shot?.title ?? "单镜"}`}
            size="lg" dismissible={!quote.submitting} className="toiv-quote-modal"
            footer={
                <>
                    {quote.phase === "ready" && reason ? <span className="toiv-quote-blocked" role="status">{reason}</span> : null}
                    <Button variant="ghost" disabled={quote.submitting} onClick={onClose}>取消</Button>
                    <Button variant="lime" disabled={Boolean(reason)} title={reason || undefined}
                        onClick={onConfirm}>{quote.submitting ? "提交中…" : "确认并提交渲染"}</Button>
                </>
            }>
            {quote.phase === "loading" ? <p className="toiv-quote-loading" role="status">正在按当前镜头、阶段与价格表核价…</p> : null}
            {quote.phase === "error" ? (
                <div className="toiv-quote-error" role="alert">
                    <p>报价未取得 · {quote.error}</p>
                    <Button size="sm" variant="outline" onClick={onRetry}>重新核价</Button>
                </div>
            ) : null}
            {estimate ? (
                <>
                    <div className="toiv-quote-work">
                        <div><b>{estimate.work.shotCount}</b><span>镜头</span></div>
                        <div><b>{estimate.work.candidateUpperBound}</b><span>候选上限</span></div>
                        <div><b>{estimate.work.requestedDurationSec}s</b><span>请求时长</span></div>
                        <div><b>{estimate.work.requestedFrameCount.toLocaleString("zh-CN")}</b><span>请求帧数</span></div>
                    </div>
                    <div className="toiv-quote-price">
                        <span className={estimate.pricing.status === "estimated" ? "" : "is-unpriced"}>
                            {estimate.pricing.status === "estimated" ? `预估 ${price}` : "未定价"}
                        </span>
                        <span className={`toiv-quote-budget is-${estimate.budget.status}`}>{budgetLine(estimate)}</span>
                    </div>
                    {estimate.pricing.unknowns.length ? (
                        <p className="meta">缺少费率：{estimate.pricing.unknowns.join("、")}；补全价格表后才能确认。</p>
                    ) : null}
                    <ul className="toiv-quote-items">
                        {estimate.items.slice(0, 4).map(item => (
                            <li key={item.shotId}>
                                <b>镜{String(item.idx + 1).padStart(2, "0")}</b>
                                <span>{item.durationSec}s · {item.candidates} 候选 · {item.engine}/{item.pipeline}</span>
                            </li>
                        ))}
                        {estimate.items.length > 4 ? <li className="meta">… 共 {estimate.items.length} 镜</li> : null}
                    </ul>
                    {estimate.warnings.map((warning, index) => <p className="toiv-quote-warn" key={index}>{warning}</p>)}
                    {estimate.blockers.length ? (
                        <ul className="toiv-quote-blockers" aria-label="渲染阻断项">
                            {estimate.blockers.map(blocker => (
                                <li key={blocker.code}>
                                    <div>
                                        <b>{blocker.message}</b>
                                        <span className="meta">
                                            {blocker.code}{blocker.stage ? ` · 阶段 ${stageLabel(blocker.stage)}` : ""}
                                        </span>
                                    </div>
                                    {blocker.code === "STORYBOARD_NOT_CONFIRMED" ? (
                                        <Button size="sm" variant="outline" onClick={() => onFixStage("storyboard")}>去确认故事板</Button>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    <p className="toiv-quote-fingerprint">
                        <span className="meta">核价指纹</span>
                        <code>{estimate.fingerprint.slice(0, 12)}</code>
                        <span className="meta">确认后若镜头、阶段或价格变化，会重新核价再提交。</span>
                    </p>
                    {quote.submitError ? <p className="toiv-quote-error" role="alert">{quote.submitError}</p> : null}
                </>
            ) : null}
        </Modal>
    );
}

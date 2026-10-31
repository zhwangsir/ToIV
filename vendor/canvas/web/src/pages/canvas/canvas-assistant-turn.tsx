import { Button } from "antd";
import { Crosshair, Undo2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";
import remarkGfm from "remark-gfm";

import { studioProposalActionHref } from "@/lib/studio-proposal-links";
import { agentAssistantFailureText, type AgentToolCall, type AssistantGenerationProposal, type AssistantTurn } from "@/services/api/agent-assistant";
import { assistantChangeSummary, assistantChangedNodeIds, assistantProposalText, assistantUnresolvedFailures, assistantUndoFailureText, assistantVisibleReply } from "./canvas-assistant-copy";
import { dismissedProposalKey, type AssistantTurnStatus } from "./use-canvas-assistant";

type Props = {
    turn: AssistantTurn;
    status?: AssistantTurnStatus;
    handledProposals: Set<string>;
    proposalFeedback?: Record<string, string>;
    onLocate: (nodeIds: string[]) => void;
    onUndo: (turnId: string) => void;
    onRunProposal: (proposal: AssistantGenerationProposal) => void;
    onDismissProposal: (proposalId: string) => void;
};

/** 助手回复用 Markdown 渲染，只走 react-markdown 的安全默认值，不放开原始 HTML。 */
export function CanvasAssistantReply({ text }: { text: string }) {
    const visible = assistantVisibleReply(text);
    if (!visible) return null;
    return (
        <div className="canvas-assistant-reply">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{visible}</ReactMarkdown>
        </div>
    );
}

export function CanvasAssistantUserMessage({ text, selectedCount }: { text: string; selectedCount: number }) {
    return (
        <div className="canvas-assistant-user">
            <span style={{ whiteSpace: "pre-wrap" }}>{text}</span>
            {selectedCount > 0 ? <span className="canvas-assistant-meta">带上了已选的 {selectedCount} 个节点</span> : null}
        </div>
    );
}

export function CanvasAssistantTurnView({ turn, status, handledProposals, proposalFeedback, onLocate, onUndo, onRunProposal, onDismissProposal }: Props) {
    const summary = assistantChangeSummary(turn.change);
    const changedNodeIds = assistantChangedNodeIds(turn.change);
    const failedActions = assistantUnresolvedFailures(turn.toolCalls);
    const undone = Boolean(status?.undone);

    return (
        <div className="canvas-assistant-turn">
            <CanvasAssistantUserMessage text={turn.userText} selectedCount={turn.selectedNodeIds?.length ?? 0} />
            {turn.reply ? <CanvasAssistantReply text={turn.reply} /> : null}
            {turn.cancelled ? <p className="canvas-assistant-meta">这一条已经停下了。</p> : null}
            {turn.error ? <p className="canvas-assistant-failed" role="status">{agentAssistantFailureText(turn.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。")}</p> : null}

            {failedActions.length > 0 ? (
                <div className="canvas-assistant-feedback" role="status">
                    {failedActions.map((text) => (
                        <span key={text} className="canvas-assistant-failed">
                            {text}
                        </span>
                    ))}
                </div>
            ) : null}

            {summary ? (
                <div className="canvas-assistant-change">
                    <strong>{summary}</strong>
                    {undone ? (
                        <span className="canvas-assistant-meta">已撤销</span>
                    ) : (
                        <>
                            <div className="canvas-assistant-card-actions">
                                {changedNodeIds.length > 0 ? (
                                    <Button type="text" size="small" icon={<Crosshair className="size-3.5" />} onClick={() => onLocate(changedNodeIds)}>
                                        在画布上查看
                                    </Button>
                                ) : null}
                                <Button type="text" size="small" icon={<Undo2 className="size-3.5" />} loading={status?.undoing} onClick={() => onUndo(turn.turnId)}>
                                    撤销这一轮
                                </Button>
                            </div>
                            {status?.undoFailure ? <span className="canvas-assistant-meta">{assistantUndoFailureText(status.undoFailure)}</span> : null}
                        </>
                    )}
                </div>
            ) : null}

            {(turn.studioProposals || []).map((proposal) => (
                <section key={proposal.proposalId} className="canvas-assistant-card canvas-assistant-studio-proposal" data-testid={`studio-proposal-${proposal.proposalId}`} aria-label="Studio 制作提案">
                    <div>
                        <strong>Studio 制作提案</strong>
                        <span className="canvas-assistant-meta"> · 待人工处理，尚未执行</span>
                    </div>
                    <span style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{proposal.summary}</span>
                    {proposal.warnings.length > 0 ? (
                        <ul className="canvas-assistant-studio-warnings">
                            {proposal.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                        </ul>
                    ) : null}
                    <div className="canvas-assistant-card-actions">
                        {proposal.nextActions.map((action, index) => {
                            if (action.requiresHuman !== true) return null;
                            const href = studioProposalActionHref(proposal, action);
                            if (!href) return <span key={`${action.kind}:${index}`} className="canvas-assistant-meta">{action.label}：信息不完整，无法打开。</span>;
                            return <Link key={`${action.kind}:${index}`} className="ant-btn ant-btn-default ant-btn-sm" to={href}>{action.label}</Link>;
                        })}
                    </div>
                </section>
            ))}

            {(turn.proposals || []).map((proposal) => {
                const started = handledProposals.has(proposal.proposalId);
                const skipped = handledProposals.has(dismissedProposalKey(proposal.proposalId));
                return (
                    <div key={proposal.proposalId} className="canvas-assistant-card">
                        <span style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{assistantProposalText(proposal)}</span>
                        {!skipped && proposalFeedback?.[proposal.proposalId] ? <span className="canvas-assistant-meta" role="status">{proposalFeedback[proposal.proposalId]}</span> : null}
                        {started ? (
                            <span className="canvas-assistant-meta">已开始生成</span>
                        ) : skipped ? (
                            <span className="canvas-assistant-meta">这次没有生成</span>
                        ) : (
                            <div className="canvas-assistant-card-actions">
                                <Button size="small" type="primary" autoInsertSpace={false} onClick={() => onRunProposal(proposal)}>生成</Button>
                                <Button size="small" onClick={() => onDismissProposal(proposal.proposalId)}>先不用</Button>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

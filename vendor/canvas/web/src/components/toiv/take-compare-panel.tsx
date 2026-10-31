import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { StatusBadge } from "@/components/ui/base/badges";
import { ToolButton } from "@/components/ui/base/buttons";
import { pickShotCandidate, type ToivDramaShot, type ToivDramaShotCandidate } from "@/services/toiv/client";
import { toivMediaUrl } from "@/services/toiv/cover-url";
import "./take-compare-panel.css";

export function canPickCandidate(candidate: ToivDramaShotCandidate): boolean {
    return candidate.status === "done" && Boolean(candidate.url?.trim());
}

export function candidateQaVerdict(candidate: ToivDramaShotCandidate): string | null {
    const verdict = candidate.qa?.verdict;
    return typeof verdict === "string" && verdict.trim() ? verdict : null;
}

export function candidateConflictMessage(error: unknown): string | null {
    const response = (error as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
    if (response?.status !== 409) return null;
    return typeof response.data?.detail === "string" && response.data.detail.trim()
        ? response.data.detail
        : "候选列表已变化或已被并发拍板，请刷新后重试";
}

export type TakeComparePanelProps = {
    shot: ToivDramaShot;
    busy?: boolean;
    onSaved: () => Promise<void> | void;
    onError?: (message: string) => void;
};

export function TakeComparePanel({ shot, busy = false, onSaved, onError }: TakeComparePanelProps) {
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [conflict, setConflict] = useState<string | null>(null);
    const [playbackMessage, setPlaybackMessage] = useState<string | null>(null);
    const videoRefs = useRef(new Map<string, HTMLVideoElement>());
    const epochRef = useRef(0);
    const requestKey = `${shot.id}\n${shot.candidates_digest ?? ""}`;
    const requestKeyRef = useRef(requestKey);
    requestKeyRef.current = requestKey;

    useEffect(() => {
        epochRef.current += 1;
        setPendingId(null);
    }, [requestKey]);

    useEffect(() => {
        setMessage(null);
        setConflict(null);
        setPlaybackMessage(null);
    }, [shot.id]);

    const playAll = async () => {
        const videos = Array.from(videoRefs.current.values());
        setPlaybackMessage(null);
        if (videos.length === 0) {
            setPlaybackMessage("暂无可播放视频");
            return;
        }
        const results = await Promise.allSettled(videos.map((video) => video.play()));
        setPlaybackMessage(results.some((result) => result.status === "rejected")
            ? "浏览器未允许自动播放，请使用视频控件手动播放"
            : "已播放全部可用候选");
    };

    const pauseAll = () => {
        videoRefs.current.forEach((video) => video.pause());
        setPlaybackMessage("已暂停全部候选");
    };

    const pick = async (candidate: ToivDramaShotCandidate) => {
        if (pendingId || busy || candidate.is_picked || !canPickCandidate(candidate)) return;
        const epoch = ++epochRef.current;
        const startedKey = requestKey;
        setPendingId(candidate.id);
        setMessage(null);
        setConflict(null);
        try {
            await pickShotCandidate(shot.id, candidate.id, shot.candidates_digest);
            if (epoch !== epochRef.current || requestKeyRef.current !== startedKey) return;
            await onSaved();
        } catch (error) {
            if (epoch !== epochRef.current || requestKeyRef.current !== startedKey) return;
            const conflictMessage = candidateConflictMessage(error);
            if (conflictMessage) {
                setConflict(conflictMessage);
                await onSaved();
            } else {
                const text = error instanceof Error ? error.message : "选用候选失败";
                setMessage(text);
                onError?.(text);
            }
        } finally {
            if (epoch === epochRef.current) setPendingId(null);
        }
    };

    const candidates = shot.candidates ?? [];
    return (
        <section data-testid="take-compare-panel" className="take-compare-panel" aria-label="候选对比台">
            <div className="take-compare-panel__toolbar">
                <div className="take-compare-panel__playback">
                    <ToolButton size="sm" variant="default" icon={<Play />} label="全部播放" disabled={candidates.every((candidate) => !candidate.url)} onClick={() => void playAll()} />
                    <ToolButton size="sm" variant="ghost" icon={<Pause />} label="全部暂停" disabled={candidates.every((candidate) => !candidate.url)} onClick={pauseAll} />
                </div>
                <span className="take-compare-panel__count">{candidates.length} 个真实候选</span>
            </div>
            {playbackMessage && <p data-testid="take-playback-message" className="take-compare-panel__notice">{playbackMessage}</p>}
            {conflict && <p data-testid="take-compare-conflict" role="alert" className="take-compare-panel__error">{conflict}</p>}
            {message && <p data-testid="take-compare-message" role="alert" className="take-compare-panel__error">{message}</p>}
            {candidates.length === 0 ? (
                <p className="take-compare-panel__empty">暂无候选</p>
            ) : (
                <div className="take-compare-panel__grid">
                    {candidates.map((candidate, index) => {
                        const selectable = canPickCandidate(candidate);
                        const pending = pendingId === candidate.id;
                        const verdict = candidateQaVerdict(candidate);
                        return (
                            <article
                                key={candidate.id}
                                data-testid={`take-candidate-${candidate.id}`}
                                className={`take-candidate${candidate.is_picked ? " take-candidate--picked" : ""}`}
                            >
                                <header className="take-candidate__header">
                                    <strong>候选 {index + 1}</strong>
                                    <span className="take-candidate__id">{candidate.id}</span>
                                    <StatusBadge variant="filled" tone={candidate.status === "error" ? "error" : "neutral"} label={candidate.status || "状态未知"} size="sm" />
                                    {candidate.is_picked && <StatusBadge variant="filled" tone="success" label="当前采用" size="sm" />}
                                </header>
                                {candidate.url ? (
                                    <video
                                        ref={(element) => {
                                            if (element) videoRefs.current.set(candidate.id, element);
                                            else videoRefs.current.delete(candidate.id);
                                        }}
                                        className="take-candidate__video"
                                        src={toivMediaUrl(candidate.url)}
                                        controls
                                        muted
                                        playsInline
                                        preload="metadata"
                                        aria-label={`候选 ${index + 1} 视频`}
                                    />
                                ) : (
                                    <div className="take-candidate__unavailable">
                                        <span>无视频 URL</span>
                                        {candidate.error && <span>{candidate.error}</span>}
                                    </div>
                                )}
                                <dl className="take-candidate__metadata">
                                    {typeof candidate.seed === "number" && <div><dt>seed</dt><dd>{candidate.seed}</dd></div>}
                                    {candidate.video_model && <div><dt>引擎</dt><dd>{candidate.video_model}</dd></div>}
                                    {candidate.pipeline && <div><dt>管线</dt><dd>{candidate.pipeline}</dd></div>}
                                    <div><dt>revision_id</dt><dd>{candidate.revision_id || "无"}</dd></div>
                                    {verdict && <div><dt>QA verdict</dt><dd>{verdict}</dd></div>}
                                </dl>
                                {candidate.url && candidate.error && <p className="take-candidate__candidate-error">{candidate.error}</p>}
                                {!candidate.is_picked && (
                                    <ToolButton
                                        data-testid={`take-pick-${candidate.id}`}
                                        size="sm"
                                        variant="default"
                                        label={pending ? "拍板中…" : selectable ? "拍板采用" : "不可拍板"}
                                        loading={pending}
                                        disabled={!selectable || busy || pendingId !== null}
                                        title={selectable ? undefined : "仅 done 且有视频 URL 的候选可拍板"}
                                        onClick={() => void pick(candidate)}
                                    />
                                )}
                            </article>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

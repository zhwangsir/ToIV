import { useRef } from "react";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import { primeTakeMediaUrl, type PrimeShotCard } from "../adapters/storyboard";

type Props = {
    shot: PrimeShotCard | null;
    takeIds: string[];
    busy: boolean;
    onClose: () => void;
    onPick: (takeId: string) => void;
};

export default function TakeCompareDialog({ shot, takeIds, busy, onClose, onPick }: Props) {
    const videos = useRef(new Map<string, HTMLVideoElement>());
    const takes = shot
        ? takeIds.flatMap(id => {
            const take = shot.takes.find(candidate => candidate.id === id);
            return take ? [take] : [];
        })
        : [];
    const playAll = () => {
        for (const video of videos.current.values()) {
            try { video.currentTime = 0; } catch { /* not seekable yet */ }
            void video.play().catch(() => undefined);
        }
    };
    const pauseAll = () => {
        for (const video of videos.current.values()) video.pause();
    };
    const register = (id: string) => (element: HTMLVideoElement | null) => {
        if (element) videos.current.set(id, element);
        else videos.current.delete(id);
    };

    return (
        <Modal open={Boolean(shot) && takes.length > 0} onClose={onClose}
            title={shot ? `候选对比 · ${shot.title}` : "候选对比"} size="xl" className="toiv-compare-modal"
            footer={<>
                <span className="meta toiv-compare-hint">播放会从 0s 同步开始；每条候选保持独立音轨，对比时建议静音。</span>
                <Button variant="ghost" onClick={onClose}>关闭</Button>
                <Button variant="outline" onClick={pauseAll}>暂停全部</Button>
                <Button variant="lime" onClick={playAll}>从头同步播放</Button>
            </>}>
            <p className="meta">已选 {takes.length} 条（2–4 条），仅完成且有产物的候选可对比与采用。</p>
            <div className="toiv-compare-grid">
                {takes.map(take => {
                    const src = primeTakeMediaUrl(take.src);
                    return (
                        <section key={take.id} className="toiv-compare-tile" aria-label={`${take.label} 对比`}>
                            <header>
                                <b>{take.label}</b>
                                <span className="meta">seed {take.seed ?? "未提供"}</span>
                                {take.picked ? <span className="toiv-compare-picked">当前采用</span> : null}
                            </header>
                            {src ? (
                                <video ref={register(take.id)} src={src} controls muted playsInline preload="metadata"
                                    aria-label={`${take.label} 对比预览`} />
                            ) : <p className="meta">暂无可预览产物</p>}
                            <dl>
                                <dt>引擎</dt><dd>{take.videoModel || "未提供"}</dd>
                                <dt>管线</dt><dd>{take.pipeline || "未提供"}</dd>
                                <dt>QA</dt><dd>{take.qaVerdict || "未提供"}</dd>
                                <dt>修订</dt><dd>{take.revisionId || "未提供"}</dd>
                            </dl>
                            <Button size="sm" variant={take.picked ? "lime" : "outline"} aria-pressed={take.picked}
                                disabled={busy || take.picked || take.status !== "done" || !take.src?.trim()}
                                title={take.picked ? "已是当前采用" : take.status !== "done" ? "候选尚未完成" : undefined}
                                onClick={() => onPick(take.id)}>
                                {take.picked ? "已采用" : `采用 ${take.label}`}
                            </Button>
                        </section>
                    );
                })}
            </div>
        </Modal>
    );
}

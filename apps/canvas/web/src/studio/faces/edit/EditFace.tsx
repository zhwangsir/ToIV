import { useEffect, useState } from "react";
import { ShotStrip } from "@/studio/ui/ShotStrip";
import { Timeline } from "@/studio/ui/Timeline";
import { ExportMenu } from "@/studio/ui/ExportMenu";
import { TakeStrip } from "@/studio/ui/TakeStrip";
import { Field } from "@/studio/ui/Field";
import { Button } from "@/studio/ui/Button";
import type { EditModel } from "./model";

export function EditFace({ model, onResult }: { model: EditModel; onResult: (text: string, warn?: boolean) => void }) {
    const [shotId, setShotId] = useState(model.shots[0]?.id ?? "");
    const [clipId, setClipId] = useState(model.clips[0]?.id ?? "");
    const [playhead, setPlayhead] = useState(0);
    const [playing, setPlaying] = useState(false);
    useEffect(() => {
        if (!playing) return;
        const timer = setInterval(() => setPlayhead((value) => (value >= model.totalSec ? 0 : Math.min(model.totalSec, value + 0.25))), 250);
        return () => clearInterval(timer);
    }, [playing, model.totalSec]);
    const shot = model.shots.find((item) => item.id === shotId) ?? model.shots[0];
    return (
        <div className="stv-body">
            <aside className="stv-rail" aria-label="镜头与素材">
                <h4>镜头</h4>
                <ShotStrip shots={model.shots} activeId={shotId} onPick={setShotId} />
                <h4 style={{ paddingTop: 14 }}>音轨</h4>
                <p className="rail-note">{model.hasBgm ? "BGM 已绑定" : "BGM 未绑定 · 在素材阶段选择"}</p>
            </aside>
            <main className="stv-main">
                <div className="bar">
                    <h2>成片剪辑</h2><span className="meta">{model.totalSec.toFixed(1)}s · 24FPS</span>
                    <span className="right">
                        <Button variant="ghost" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "暂停" : "播放"}>{playing ? "暂停" : "播放"}</Button>
                        <ExportMenu projectId={model.projectId} ready={model.clips.some((clip) => clip.status === "done")} onResult={onResult} />
                    </span>
                </div>
                <Timeline clips={model.clips} totalSec={model.totalSec} playheadSec={playhead} activeClipId={clipId} onClipPick={setClipId} />
            </main>
            <aside className="stv-insp" aria-label="剪辑参数">
                <header><span className="no">{shot?.title.replace("镜", "") ?? "--"}</span><div><b>{shot?.title ?? "—"}</b><small>{shot?.durationSec ?? 0}s · {shot?.status === "done" ? "READY" : "PENDING"}</small></div></header>
                <Field label="候选 Takes" htmlFor="edit-takes">
                    <div id="edit-takes">
                        <TakeStrip takes={[{ id: "t1", label: "T1", seed: shot?.stillSeed ?? 0 }]} activeId="t1" onPick={() => onResult("Take 已设为采用")} />
                    </div>
                </Field>
                <Field label="转场" htmlFor="edit-transition"><select id="edit-transition"><option>切</option><option>淡入 12f</option><option>叠化 24f</option></select></Field>
                <Field label="响度" htmlFor="edit-loudness"><select id="edit-loudness"><option>-14 LUFS</option><option>-16 LUFS</option></select></Field>
                <Button variant="primary" onClick={() => onResult("Render MP4 已入队（本地渲染）", true)}>Render MP4</Button>
            </aside>
        </div>
    );
}

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import { loadPrimeStoryboard, savePrimeShotPrompt, type PrimeStoryboardModel } from "../adapters/storyboard";
import { ToivWorkbar, type PrimeFace } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

const FACE_HREF: Record<PrimeFace, string> = { pipeline: "/studio", canvas: "/drama", edit: "/history" };

export default function PrimeStoryboard() {
    const { id = "" } = useParams();
    const navigate = useNavigate();
    const [model, setModel] = useState<PrimeStoryboardModel | null>(null);
    const [failed, setFailed] = useState(false);
    const [picked, setPicked] = useState<Record<string, string | undefined>>({});
    const [notice, setNotice] = useState("");
    useEffect(() => {
        let alive = true;
        setModel(null);
        setFailed(false);
        loadPrimeStoryboard(id).then((next) => { if (alive) setModel(next); }).catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, [id]);
    const save = async (shotId: string, title: string, prompt: string) => {
        setNotice("");
        try {
            await savePrimeShotPrompt(id, shotId, prompt);
            setNotice(`已保存 ${title} 提示词`);
        } catch {
            setNotice(`保存失败 · ${title}`);
        }
    };
    return (
        <ToivShell>
            <ToivWorkbar face="pipeline" runningCount={model?.runningCount ?? 0}
                onFaceChange={(face) => navigate(FACE_HREF[face])} onOpenTasks={() => navigate("/history")} />
            <section className="toiv-shots">
                <header className="toiv-shots-bar">
                    <h2>{model?.title ?? "载入中"}</h2>
                    <span className="meta">{model?.shots.length ?? 0} 镜 · {model?.runningCount ?? 0} 渲染中</span>
                </header>
                {failed ? <div className="toiv-empty"><p>分镜载入失败 · 回项目库重试</p><Button variant="lime" onClick={() => navigate("/studio")}>回项目库</Button></div> : null}
                {notice ? <p className="toiv-saved" role="status">{notice}</p> : null}
                {(model?.shots ?? []).map((shot) => (
                    <article className={`toiv-shot st-${shot.status}`} key={shot.id}>
                        <header>
                            <b>{shot.title}</b><span className="meta">{shot.camera} · {shot.durationSec}s</span>
                            <span className={`flag flag-${shot.status}`}>{shot.status === "done" ? "完成" : shot.status === "run" ? "渲染中" : "排队"}</span>
                        </header>
                        {shot.beats.length > 0 ? (
                            <div className="toiv-beats">{shot.beats.map((beat, index) => <span className={`beat k-${beat.kind}`} key={index}>{beat.text}</span>)}</div>
                        ) : null}
                        <label className="toiv-prompt">提示词
                            <textarea rows={3} defaultValue={shot.prompt} onBlur={(event) => { void save(shot.id, shot.title, event.target.value); }} />
                        </label>
                        <div className="toiv-takes" role="group" aria-label={`${shot.title} 候选 Takes`}>
                            {shot.takes.map((take) => (
                                <button key={take.id} type="button" className="toiv-take"
                                    aria-pressed={(picked[shot.id] ?? shot.takes.find((item) => item.picked)?.id) === take.id}
                                    onClick={() => setPicked((prev) => ({ ...prev, [shot.id]: take.id }))}>
                                    {take.label}<span className="seed">{take.seed}</span>
                                </button>
                            ))}
                            {shot.takes.length === 0 ? <span className="meta">暂无候选</span> : null}
                        </div>
                    </article>
                ))}
            </section>
        </ToivShell>
    );
}

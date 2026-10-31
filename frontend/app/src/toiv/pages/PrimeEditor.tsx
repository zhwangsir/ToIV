import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import { loadPrimeTimeline, type PrimeTimelineModel } from "../adapters/edit";
import { ToivWorkbar, type PrimeFace } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

const FACE_HREF: Record<PrimeFace, string> = { pipeline: "/studio", canvas: "/drama", edit: "/history" };
const TRACKS: { key: "v1" | "a1"; label: string }[] = [
    { key: "v1", label: "视频" },
    { key: "a1", label: "对白" },
];

export default function PrimeEditor() {
    const { id = "" } = useParams();
    const navigate = useNavigate();
    const [model, setModel] = useState<PrimeTimelineModel | null>(null);
    const [failed, setFailed] = useState(false);
    const [selected, setSelected] = useState("");
    useEffect(() => {
        let alive = true;
        setModel(null);
        setFailed(false);
        loadPrimeTimeline(id).then((next) => { if (alive) setModel(next); }).catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, [id]);
    const total = model?.totalSec ?? 0;
    return (
        <ToivShell>
            <ToivWorkbar face="edit" runningCount={0}
                onFaceChange={(face) => navigate(FACE_HREF[face])} onOpenTasks={() => navigate("/history")} />
            <section className="toiv-tl-wrap">
                <header className="toiv-shots-bar">
                    <h2>{model?.title ?? "载入中"}</h2>
                    <span className="meta">{total.toFixed(1)}s · {model?.clips.length ?? 0} 片段</span>
                </header>
                {failed ? <div className="toiv-empty"><p>时间线载入失败 · 回项目库重试</p><Button variant="lime" onClick={() => navigate("/studio")}>回项目库</Button></div> : null}
                <div className="toiv-tl" aria-label="成片时间线">
                    {TRACKS.map((track) => (
                        <div className="toiv-lane" key={track.key}>
                            <span className="lane-label">{track.label}</span>
                            <div className="lane-track">
                                {(model?.clips ?? []).filter((clip) => clip.track === track.key).map((clip) => (
                                    <button key={clip.id} type="button" className="toiv-clip"
                                        aria-pressed={selected === clip.id}
                                        onClick={() => setSelected(clip.id)}
                                        style={{ left: `${total ? (clip.startSec / total) * 100 : 0}%`, width: `${total ? (clip.durationSec / total) * 100 : 0}%` }}>
                                        {clip.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </ToivShell>
    );
}

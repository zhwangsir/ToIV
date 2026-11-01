import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import { freezePrimeSceneAnchor, loadPrimeScenes, type PrimeSceneNode } from "../adapters/scenes";
import PrimeMediaThumb from "../addons/PrimeMediaThumb";
import { ToivWorkbar } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

export default function PrimeStyle() {
    const { id = "" } = useParams();
    const navigate = useNavigate();
    const [scenes, setScenes] = useState<PrimeSceneNode[] | null>(null);
    const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
    const [attempt, setAttempt] = useState(0);
    const [notice, setNotice] = useState("");
    const [noticeWarn, setNoticeWarn] = useState(false);
    const [freezing, setFreezing] = useState<string[]>([]);
    const freezingRef = useRef(new Set<string>());

    useEffect(() => {
        let alive = true;
        setPhase("loading");
        loadPrimeScenes(id).then((next) => {
            if (!alive) return;
            setScenes(next);
            setPhase("ready");
        }).catch(() => {
            if (alive) setPhase("error");
        });
        return () => { alive = false; };
    }, [id, attempt]);

    const freeze = async (scene: PrimeSceneNode) => {
        if (freezingRef.current.has(scene.id)) return;
        freezingRef.current.add(scene.id);
        setFreezing(prev => [...prev, scene.id]);
        try {
            await freezePrimeSceneAnchor(scene.id);
            setNotice(`已冻结 ${scene.name} 主参考锚点`);
        } catch {
            setNotice(`冻结失败 · ${scene.name}（需先有主参考图）`);
            setNoticeWarn(true);
            return;
        } finally {
            freezingRef.current.delete(scene.id);
            setFreezing(prev => prev.filter(item => item !== scene.id));
        }
        setNoticeWarn(false);
        loadPrimeScenes(id).then(setScenes).catch(() => { /* the confirmed freeze stays on screen */ });
    };

    return (
        <ToivShell>
            <ToivWorkbar face="pipeline"
                onFaceChange={(face) => navigate(face === "canvas" ? "/drama" : face === "edit" ? "/studio?face=edit" : "/studio")}
                onOpenTasks={() => navigate("/tasks")} />
            <section className="toiv-assets">
                <header className="toiv-shots-bar"><h2>场景锚点</h2><span className="meta">{scenes ? `${scenes.length} 场景` : "场景数未知"}</span></header>
                {notice ? <p className="toiv-saved" role={noticeWarn ? "alert" : "status"}>{notice}</p> : null}
                {phase === "loading" ? <p className="toiv-empty" role="status">正在载入场景…</p> : null}
                {phase === "error" ? (
                    <div className="toiv-empty" role="alert">
                        <p>场景载入失败 · 可重试或稍后再来</p>
                        <Button variant="lime" onClick={() => setAttempt(value => value + 1)}>重试载入场景</Button>
                    </div>
                ) : null}
                {phase === "ready" && scenes && !scenes.length ? <p className="toiv-empty">暂无场景；先在项目里建场景再冻结锚点。</p> : null}
                {(scenes ?? []).map((scene) => {
                    const pending = freezing.includes(scene.id);
                    return (
                        <article className="toiv-card" key={scene.id}>
                            <div className="thumbs">
                                {scene.views.map((view) => (
                                    <span className="thumb" key={view.id} title={view.label}>
                                        <PrimeMediaThumb src={view.src} alt={view.label} />
                                    </span>
                                ))}
                            </div>
                            <header><b>{scene.name}</b>{scene.frozen ? <span className="src src-studio">已冻结</span> : null}</header>
                            <div className="meta">{scene.env} · {scene.variantCount} 变体</div>
                            <footer>
                                <Button variant="lime" size="sm" disabled={scene.frozen || pending}
                                    onClick={() => { void freeze(scene); }}>
                                    {pending ? "冻结中…" : "冻结主参考"}
                                </Button>
                            </footer>
                        </article>
                    );
                })}
            </section>
        </ToivShell>
    );
}

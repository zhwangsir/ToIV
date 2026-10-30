import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import { freezePrimeSceneAnchor, loadPrimeScenes, type PrimeSceneNode } from "../adapters/scenes";
import { ToivWorkbar } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

export default function PrimeStyle() {
    const { id = "" } = useParams();
    const navigate = useNavigate();
    const [scenes, setScenes] = useState<PrimeSceneNode[]>([]);
    const [failed, setFailed] = useState(false);
    const [notice, setNotice] = useState("");
    const load = () => {
        loadPrimeScenes(id).then(setScenes).catch(() => setFailed(true));
    };
    useEffect(load, [id]);
    const freeze = async (sceneId: string, name: string) => {
        try {
            await freezePrimeSceneAnchor(sceneId);
            setNotice(`已冻结 ${name} 主参考锚点`);
            load();
        } catch {
            setNotice(`冻结失败 · ${name}（需先有主参考图）`);
        }
    };
    return (
        <ToivShell>
            <ToivWorkbar face="pipeline" runningCount={0}
                onFaceChange={(face) => navigate(face === "canvas" ? "/drama" : face === "edit" ? "/history" : "/studio")}
                onOpenTasks={() => navigate("/history")} />
            <section className="toiv-assets">
                <header className="toiv-shots-bar"><h2>场景锚点</h2><span className="meta">{scenes.length} 场景</span></header>
                {notice ? <p className="toiv-saved" role="status">{notice}</p> : null}
                {failed ? <div className="toiv-empty"><p>场景载入失败</p></div> : null}
                {scenes.map((scene) => (
                    <article className="toiv-card" key={scene.id}>
                        <div className="thumbs">
                            {scene.views.map((view) => (
                                <span className="thumb" key={view.id} title={view.label}>
                                    {view.src ? <img src={view.src} alt={view.label} /> : <i>{view.label}</i>}
                                </span>
                            ))}
                        </div>
                        <header><b>{scene.name}</b>{scene.frozen ? <span className="src src-studio">已冻结</span> : null}</header>
                        <div className="meta">{scene.env} · {scene.variantCount} 变体</div>
                        <footer><Button variant="lime" size="sm" disabled={scene.frozen} onClick={() => { void freeze(scene.id, scene.name); }}>冻结主参考</Button></footer>
                    </article>
                ))}
            </section>
        </ToivShell>
    );
}

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import { loadPrimeAssets, type PrimeAssetsModel } from "../adapters/assets";
import { ToivWorkbar } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

export default function PrimeAssets() {
    const { projectId = "" } = useParams();
    const navigate = useNavigate();
    const [model, setModel] = useState<PrimeAssetsModel | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let alive = true;
        loadPrimeAssets(projectId).then((next) => { if (alive) setModel(next); }).catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, [projectId]);
    return (
        <ToivShell>
            <ToivWorkbar face="canvas" runningCount={0}
                onFaceChange={(face) => navigate(face === "canvas" ? "/drama" : face === "edit" ? "/history" : "/studio")}
                onOpenTasks={() => navigate("/history")} />
            <section className="toiv-assets">
                {failed ? <div className="toiv-empty"><p>资产载入失败 · 回项目库</p><Button variant="lime" onClick={() => navigate("/drama")}>回项目库</Button></div> : null}
                <div className="toiv-assets-col">
                    <h3>角色 <span className="meta">{model?.characters.length ?? 0}</span></h3>
                    {(model?.characters.length ?? 0) === 0 ? <p className="meta">还没有角色设定卡。</p> : null}
                    <div className="toiv-grid">
                        {(model?.characters ?? []).map((character) => (
                            <article className="toiv-card" key={character.id || character.name}>
                                {character.refImage ? <img className="thumb" src={character.refImage} alt={character.name} /> : <div className="thumb empty">无定妆</div>}
                                <header><b>{character.name}</b><span className="src src-studio">{character.style}</span></header>
                            </article>
                        ))}
                    </div>
                </div>
                <div className="toiv-assets-col">
                    <h3>场景 <span className="meta">{model?.scenes.length ?? 0}</span></h3>
                    {(model?.scenes.length ?? 0) === 0 ? <p className="meta">还没有场景锚点。</p> : null}
                    <div className="toiv-grid">
                        {(model?.scenes ?? []).map((scene) => (
                            <article className="toiv-card" key={scene.id}>
                                <div className="thumbs">
                                    {scene.views.map((view) => (
                                        <span className="thumb" key={view.id} title={view.label}>
                                            {view.src ? <img src={view.src} alt={view.label} /> : <i>{view.label}</i>}
                                        </span>
                                    ))}
                                </div>
                                <header><b>{scene.name}</b>{scene.frozen ? <span className="src src-studio">已冻结</span> : null}</header>
                                <div className="meta">{scene.env}</div>
                            </article>
                        ))}
                    </div>
                </div>
            </section>
        </ToivShell>
    );
}

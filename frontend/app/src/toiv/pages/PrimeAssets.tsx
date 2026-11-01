import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import { loadPrimeAssets, type PrimeAssetsModel } from "../adapters/assets";
import AssetLedgerPanel from "../addons/AssetLedgerPanel";
import PrimeMediaThumb from "../addons/PrimeMediaThumb";
import { ToivWorkbar } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

export default function PrimeAssets() {
    const { projectId = "" } = useParams();
    const navigate = useNavigate();
    const [model, setModel] = useState<PrimeAssetsModel | null>(null);
    const [failed, setFailed] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [tab, setTab] = useState<"assets" | "ledger">("assets");
    useEffect(() => {
        let alive = true;
        setFailed(false);
        loadPrimeAssets(projectId).then((next) => { if (alive) setModel(next); }).catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, [projectId, reloadKey]);
    return (
        <ToivShell>
            <ToivWorkbar face="canvas"
                onFaceChange={(face) => navigate(face === "canvas" ? "/drama" : face === "edit" ? "/studio?face=edit" : "/studio")}
                onOpenTasks={() => navigate("/tasks")} />
            <section className="toiv-assets">
                <header className="toiv-assets-head">
                    <div>
                        <h2>资产</h2>
                        <p className="meta">角色与场景锚点；跨集对账只给确定性建议，应用前可逐条核对。</p>
                    </div>
                    <div className="toiv-seg" role="group" aria-label="资产视图">
                        <Button variant={tab === "assets" ? "lime" : "ghost"} aria-pressed={tab === "assets"}
                            onClick={() => setTab("assets")}>资产</Button>
                        <Button variant={tab === "ledger" ? "lime" : "ghost"} aria-pressed={tab === "ledger"}
                            onClick={() => setTab("ledger")}>对账</Button>
                    </div>
                </header>
                {tab === "assets" ? (
                    failed ? (
                        <div className="toiv-empty" role="alert">
                            <p>资产载入失败 · 请检查项目是否仍在。</p>
                            <Button variant="lime" onClick={() => setReloadKey(key => key + 1)}>重新载入</Button>
                        </div>
                    ) : model === null ? (
                        <p className="meta" role="status">正在载入资产…</p>
                    ) : (
                        <div className="toiv-assets-columns">
                            <div className="toiv-assets-col">
                                <h3>角色 <span className="meta">{model.characters.length}</span></h3>
                                {model.characters.length === 0 ? <p className="meta">还没有角色设定卡。</p> : null}
                                <div className="toiv-grid">
                                    {model.characters.map((character) => (
                                        <article className="toiv-card" key={character.id || character.name}>
                                            {character.refImage
                                                ? <PrimeMediaThumb className="thumb" src={character.refImage} alt={character.name} />
                                                : <div className="thumb empty">无定妆</div>}
                                            <header><b>{character.name}</b><span className="src src-studio">{character.style}</span></header>
                                        </article>
                                    ))}
                                </div>
                            </div>
                            <div className="toiv-assets-col">
                                <h3>场景 <span className="meta">{model.scenes.length}</span></h3>
                                {model.scenes.length === 0 ? <p className="meta">还没有场景锚点。</p> : null}
                                <div className="toiv-grid">
                                    {model.scenes.map((scene) => (
                                        <article className="toiv-card" key={scene.id}>
                                            <div className="thumbs">
                                                {scene.views.map((view) => (
                                                    <span className="thumb" key={view.id} title={view.label}>
                                                        <PrimeMediaThumb src={view.src} alt={view.label} />
                                                    </span>
                                                ))}
                                            </div>
                                            <header><b>{scene.name}</b>{scene.frozen ? <span className="src src-studio">已冻结</span> : null}</header>
                                            <div className="meta">{scene.env}</div>
                                        </article>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )
                ) : (
                    <AssetLedgerPanel projectId={projectId}
                        onJumpToShot={(pid, shotId) => navigate(`/studio/${pid}?shot=${encodeURIComponent(shotId)}`)} />
                )}
            </section>
        </ToivShell>
    );
}

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Background, Controls, ReactFlow, type Edge, type Node, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Button from "../../components/ui/Button";
import { loadPrimeScenes, primeSceneNodes, type PrimeSceneNode, type PrimeSceneNodeData } from "../adapters/scenes";
import { CanvasTaskBar } from "../addons/CanvasTaskBar";
import CanvasWorkspace from "../shell/CanvasWorkspace";
import ToivShell from "../shell/ToivShell";

function SceneNode({ data }: { data: PrimeSceneNodeData }) {
    return (
        <div className={`toiv-node${data.frozen ? " frozen" : ""}`}>
            <header><b>{data.label}</b>{data.frozen ? <span className="tag">已冻结</span> : null}</header>
            <div className="env">{data.env}</div>
            <div className="views">
                {data.views.map((view) => (
                    <span className="view" key={view.id} title={view.label}>
                        {view.src ? <img src={view.src} alt={view.label} /> : <i>{view.label}</i>}
                    </span>
                ))}
            </div>
        </div>
    );
}

const nodeTypes = { scene: SceneNode };

export default function PrimeCanvas() {
    const { projectId = "" } = useParams();
    const navigate = useNavigate();
    const [scenes, setScenes] = useState<PrimeSceneNode[] | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        setScenes(null);
        setSelectedId(null);
        setFailed(false);
        loadPrimeScenes(projectId)
            .then((next) => { if (alive) setScenes(next); })
            .catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, [projectId]);

    const graph = useMemo(() => {
        if (!scenes) return null;
        const built = primeSceneNodes(scenes);
        return {
            nodes: built.nodes.map((node) => ({ ...node, type: "scene", selected: node.id === selectedId })) as Node<PrimeSceneNodeData>[],
            edges: built.edges as Edge[],
        };
    }, [scenes, selectedId]);

    const selected = scenes?.find((scene) => scene.id === selectedId) ?? null;
    const onNodeClick: NodeMouseHandler = (_event, node) => setSelectedId(node.id);

    return (
        <ToivShell flush>
            <CanvasWorkspace
                left={<>
                    <header className="toiv-workspace-head">
                        <h2>场景</h2>
                        <span className="meta">{scenes ? `${scenes.length} 个` : ""}</span>
                    </header>
                    {failed ? <p className="toiv-workspace-note">场景载入失败</p> : null}
                    {!scenes && !failed ? <p className="toiv-workspace-note" role="status">载入场景…</p> : null}
                    {scenes && scenes.length === 0 ? <p className="toiv-workspace-note">还没有场景。</p> : null}
                    <ul className="toiv-scene-list">
                        {scenes?.map((scene) => (
                            <li key={scene.id}>
                                <button type="button" className={`toiv-scene-item${scene.id === selectedId ? " active" : ""}`}
                                    aria-pressed={scene.id === selectedId} onClick={() => setSelectedId(scene.id)}>
                                    <b>{scene.name}</b>
                                    <span>{scene.env}</span>
                                    {scene.frozen ? <em>已冻结</em> : null}
                                </button>
                            </li>
                        ))}
                    </ul>
                </>}
                center={
                    <div className="toiv-canvas-flow">
                        {failed ? (
                            <div className="toiv-empty">
                                <p>场景载入失败 · 回项目库</p>
                                <Button variant="lime" onClick={() => navigate("/drama")}>回项目库</Button>
                            </div>
                        ) : null}
                        {graph ? (
                            <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes}
                                fitView minZoom={0.3} onNodeClick={onNodeClick}>
                                <Background color="var(--grid-color)" bgColor="var(--bg-canvas)" />
                                <Controls />
                            </ReactFlow>
                        ) : null}
                    </div>
                }
                right={<>
                    <header className="toiv-workspace-head"><h2>检查器</h2></header>
                    {selected ? (
                        <div className="toiv-inspector">
                            <h3>{selected.name}</h3>
                            <p className="toiv-inspector-env">{selected.env}</p>
                            <span className="tag">{selected.frozen ? "已冻结" : "未冻结"}</span>
                            <p className="toiv-workspace-note">{selected.variantCount} 个变体</p>
                            <div className="views">
                                {selected.views.map((view) => (
                                    <span className="view" key={view.id} title={view.label}>
                                        {view.src ? <img src={view.src} alt={view.label} /> : view.label}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ) : <p className="toiv-workspace-note">选择场景查看详情</p>}
                </>}
                taskbar={<CanvasTaskBar />}
            />
        </ToivShell>
    );
}

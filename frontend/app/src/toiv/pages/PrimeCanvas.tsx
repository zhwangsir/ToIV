import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Button from "../../components/ui/Button";
import { loadPrimeScenes, primeSceneNodes, type PrimeSceneNodeData } from "../adapters/scenes";
import { ToivWorkbar, type PrimeFace } from "../addons/ToivWorkbar";
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
    const [graph, setGraph] = useState<{ nodes: Node<PrimeSceneNodeData>[]; edges: Edge[] } | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let alive = true;
        loadPrimeScenes(projectId)
            .then((scenes) => {
                if (!alive) return;
                const built = primeSceneNodes(scenes);
                setGraph({
                    nodes: built.nodes.map((node) => ({ ...node, type: "scene" })),
                    edges: built.edges,
                });
            })
            .catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, [projectId]);
    return (
        <ToivShell>
            <ToivWorkbar face="canvas" runningCount={0}
                onFaceChange={(face: PrimeFace) => navigate(face === "canvas" ? "/drama" : face === "edit" ? "/history" : "/studio")}
                onOpenTasks={() => navigate("/history")} />
            <section className="toiv-canvas">
                {failed ? <div className="toiv-empty"><p>场景载入失败 · 回项目库</p><Button variant="lime" onClick={() => navigate("/drama")}>回项目库</Button></div> : null}
                {graph ? (
                    <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView minZoom={0.3}>
                        <Background />
                        <Controls />
                    </ReactFlow>
                ) : null}
            </section>
        </ToivShell>
    );
}

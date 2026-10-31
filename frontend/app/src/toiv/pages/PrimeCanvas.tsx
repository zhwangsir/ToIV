import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Button from "../../components/ui/Button";
import type { AgentApiGraph } from "../adapters/agent";
import { agentGraphToFlow, type AgentFlowNodeData } from "../adapters/agent-graph";
import { loadPrimeScenes, primeSceneNodes, type PrimeSceneNode, type PrimeSceneNodeData } from "../adapters/scenes";
import AgentPanel from "../addons/AgentPanel";
import { CanvasTaskBar } from "../addons/CanvasTaskBar";
import CanvasWorkspace from "../shell/CanvasWorkspace";
import ToivShell from "../shell/ToivShell";

function SceneNode({ data }: { data: PrimeSceneNodeData }) {
    return (
        <div className={`toiv-node${data.frozen ? " frozen" : ""}`}>
            <Handle type="target" position={Position.Left} />
            <Handle type="source" position={Position.Right} />
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

function ComfyNode({ data }: { data: AgentFlowNodeData }) {
    return (
        <div className="toiv-node toiv-comfy-node">
            <Handle type="target" position={Position.Left} />
            <Handle type="source" position={Position.Right} />
            <header><b>{data.label}</b><span className="tag">#{data.id}</span></header>
            {data.summary ? <div className="env">{data.summary}</div> : null}
        </div>
    );
}

const nodeTypes = { scene: SceneNode, comfy: ComfyNode };

type RightTab = "inspector" | "agent";
type CanvasLayer = "scenes" | "agent";

export default function PrimeCanvas() {
    const { projectId = "" } = useParams();
    const navigate = useNavigate();
    const [scenes, setScenes] = useState<PrimeSceneNode[] | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [rightTab, setRightTab] = useState<RightTab>("inspector");
    const [proposal, setProposal] = useState<{ title: string; graph: AgentApiGraph } | null>(null);
    const [proposalSeq, setProposalSeq] = useState(0);
    const [layer, setLayer] = useState<CanvasLayer>("scenes");

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

    const sceneFlow = useMemo(() => (scenes ? primeSceneNodes(scenes) : null), [scenes]);
    const agentFlow = useMemo(() => (proposal ? agentGraphToFlow(proposal.graph) : null), [proposal]);

    const graph = useMemo(() => {
        if (layer === "agent" && agentFlow) {
            return {
                nodes: agentFlow.nodes.map((node) => ({ ...node, type: "comfy", selected: node.id === selectedId })) as Node<AgentFlowNodeData>[],
                edges: agentFlow.edges as Edge[],
            };
        }
        if (!sceneFlow) return null;
        return {
            nodes: sceneFlow.nodes.map((node) => ({ ...node, type: "scene", selected: node.id === selectedId })) as Node<PrimeSceneNodeData>[],
            edges: sceneFlow.edges as Edge[],
        };
    }, [layer, agentFlow, sceneFlow, selectedId]);

    const selectedScene = scenes?.find((scene) => scene.id === selectedId) ?? null;
    const selectedComfy = layer === "agent" && agentFlow
        ? agentFlow.nodes.find((node) => node.id === selectedId) ?? null
        : null;

    const onNodeClick: NodeMouseHandler = (_event, node) => {
        setSelectedId(node.id);
        setRightTab("inspector");
    };

    const closeProposal = () => {
        setProposal(null);
        setLayer("scenes");
        setSelectedId(null);
    };

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
                                    aria-pressed={scene.id === selectedId}
                                    onClick={() => { setSelectedId(scene.id); setRightTab("inspector"); }}>
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
                        {proposal ? (
                            <div className="toiv-canvas-modes" role="group" aria-label="画布层">
                                <button type="button" aria-pressed={layer === "scenes"} onClick={() => setLayer("scenes")}>场景</button>
                                <button type="button" aria-pressed={layer === "agent"} onClick={() => setLayer("agent")}>Agent 提案</button>
                                <button type="button" onClick={closeProposal}>关闭提案</button>
                            </div>
                        ) : null}
                        {failed ? (
                            <div className="toiv-empty">
                                <p>场景载入失败 · 回项目库</p>
                                <Button variant="lime" onClick={() => navigate("/drama")}>回项目库</Button>
                            </div>
                        ) : null}
                        {graph ? (
                            <ReactFlow key={`${layer}:${proposalSeq}`} nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes}
                                fitView minZoom={0.3} onNodeClick={onNodeClick}>
                                <Background color="var(--grid-color)" bgColor="var(--bg-canvas)" />
                                <Controls />
                            </ReactFlow>
                        ) : null}
                    </div>
                }
                right={<>
                    <div className="toiv-right-tabs" role="tablist" aria-label="右栏">
                        <button type="button" role="tab" aria-selected={rightTab === "inspector"}
                            className={rightTab === "inspector" ? "active" : undefined}
                            onClick={() => setRightTab("inspector")}>检查器</button>
                        <button type="button" role="tab" aria-selected={rightTab === "agent"}
                            className={rightTab === "agent" ? "active" : undefined}
                            onClick={() => setRightTab("agent")}>Agent</button>
                    </div>
                    {rightTab === "inspector" ? (
                        <>
                            <header className="toiv-workspace-head"><h2>检查器</h2></header>
                            {selectedComfy ? (
                                <div className="toiv-inspector">
                                    <h3>{selectedComfy.data.label}</h3>
                                    <p className="toiv-inspector-env">{selectedComfy.data.summary || "无输入摘要"}</p>
                                    <span className="tag">节点 #{selectedComfy.data.id}</span>
                                </div>
                            ) : selectedScene ? (
                                <div className="toiv-inspector">
                                    <h3>{selectedScene.name}</h3>
                                    <p className="toiv-inspector-env">{selectedScene.env}</p>
                                    <span className="tag">{selectedScene.frozen ? "已冻结" : "未冻结"}</span>
                                    <p className="toiv-workspace-note">{selectedScene.variantCount} 个变体</p>
                                    <div className="views">
                                        {selectedScene.views.map((view) => (
                                            <span className="view" key={view.id} title={view.label}>
                                                {view.src ? <img src={view.src} alt={view.label} /> : view.label}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            ) : <p className="toiv-workspace-note">选择场景查看详情</p>}
                        </>
                    ) : null}
                    <div className="toiv-agent-pane" style={rightTab === "agent" ? undefined : { display: "none" }}>
                        <AgentPanel onCanvasProposal={(payload) => {
                            setProposal(payload);
                            setProposalSeq((seq) => seq + 1);
                            setLayer("agent");
                            setSelectedId(null);
                        }} />
                    </div>
                </>}
                taskbar={<CanvasTaskBar />}
            />
        </ToivShell>
    );
}

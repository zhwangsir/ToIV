import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Button from "../../components/ui/Button";
import { legacyDestination } from "../addons/LegacyHandoff";
import { loadLegacyCanvas, type PrimeLegacyCanvas as LegacyCanvasModel, type PrimeLegacyNode } from "../adapters/legacyCanvas";
import ToivShell from "../shell/ToivShell";

function LegacyNode({ data }: { data: PrimeLegacyNode }) {
    const image = data.kind === "video" ? data.poster : data.src;
    return (
        <div className="toiv-node toiv-legacy-node">
            <Handle type="target" position={Position.Left} />
            <Handle type="source" position={Position.Right} />
            <header><b>{data.title}</b><span className="tag">{data.kind}</span></header>
            {image ? (
                <div className="toiv-legacy-media">
                    <img src={image} alt={`${data.title} 预览`} loading="lazy" referrerPolicy="no-referrer" />
                    {data.kind === "video" ? <span className="toiv-legacy-play">视频</span> : null}
                </div>
            ) : null}
            {data.excerpt ? <p className="toiv-legacy-excerpt">{data.excerpt}</p> : null}
            {!image && !data.excerpt ? <div className="env">{data.kind}</div> : null}
        </div>
    );
}

const nodeTypes = { legacy: LegacyNode };

function prefersNarrow(): boolean {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches;
}

function formatStamp(value: string): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { hour12: false });
}

export default function PrimeLegacyCanvas() {
    const { id = "" } = useParams();
    const [canvas, setCanvas] = useState<LegacyCanvasModel | null>(null);
    const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const [narrow, setNarrow] = useState(prefersNarrow);

    useEffect(() => {
        const query = window.matchMedia("(max-width: 700px)");
        const sync = () => setNarrow(query.matches);
        query.addEventListener("change", sync);
        return () => query.removeEventListener("change", sync);
    }, []);

    useEffect(() => {
        let alive = true;
        setPhase("loading");
        setError("");
        loadLegacyCanvas(id)
            .then((next) => { if (alive) { setCanvas(next); setPhase("ready"); } })
            .catch((cause) => {
                if (!alive) return;
                setError(cause instanceof Error ? cause.message : "画布载入失败");
                setPhase("error");
            });
        return () => { alive = false; };
    }, [id, attempt]);

    const graph = useMemo(() => {
        if (!canvas) return null;
        return {
            nodes: canvas.nodes.map((node) => ({
                id: node.id, type: "legacy", position: { x: node.x, y: node.y },
                style: { width: node.width, height: node.height }, data: node,
            })) as Node<PrimeLegacyNode>[],
            edges: canvas.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })) as Edge[],
        };
    }, [canvas]);

    const editDestination = typeof window === "undefined" ? null : legacyDestination(
        import.meta.env?.VITE_LEGACY_BASE, `/canvas/${encodeURIComponent(id)}`, window.location.origin, import.meta.env?.BASE_URL || "/",
    );

    return (
        <ToivShell>
            <div className="toiv-legacy">
                <header className="toiv-legacy-head">
                    <div>
                        <p className="toiv-tool-crumb"><Link to="/drama">画布库</Link><span aria-hidden="true"> / </span>旧画布快照</p>
                        <h1>{canvas?.title ?? "旧画布"}</h1>
                        <p className="toiv-settings-note">只读查看：节点、连线与预览沿用旧画布数据，编辑仍由旧画布引擎负责。</p>
                    </div>
                    <div className="toiv-legacy-actions">
                        <span className="toiv-readonly-badge">只读</span>
                        {editDestination ? (
                            <Button variant="lime" size="sm" onClick={() => window.location.assign(editDestination)}>在旧编辑器中打开</Button>
                        ) : null}
                        <Button variant="outline" size="sm" to="/drama">回画布库</Button>
                    </div>
                </header>

                {phase === "ready" && canvas ? (
                    <p className="toiv-legacy-meta">
                        <span>{canvas.nodes.length} 个节点</span>
                        <span>{canvas.edges.length} 条连线</span>
                        {canvas.updatedAt ? <span>更新于 {formatStamp(canvas.updatedAt)}</span> : null}
                    </p>
                ) : null}

                {phase === "loading" ? <div className="toiv-empty" role="status"><p>正在载入旧画布…</p></div> : null}
                {phase === "error" ? (
                    <div className="toiv-empty" role="alert">
                        <p>{error}</p>
                        <div className="toiv-legacy-actions">
                            <Button variant="lime" size="sm" onClick={() => setAttempt((value) => value + 1)}>重试载入</Button>
                            <Button variant="outline" size="sm" to="/drama">回画布库</Button>
                        </div>
                    </div>
                ) : null}
                {phase === "ready" && canvas && canvas.nodes.length === 0 ? (
                    <div className="toiv-empty"><p>这块画布还没有节点。</p><Button variant="outline" size="sm" to="/drama">回画布库</Button></div>
                ) : null}

                {phase === "ready" && graph && canvas && canvas.nodes.length > 0 ? (
                    <div className="toiv-legacy-canvas" aria-label={`${canvas.title} 只读画布`}>
                        <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes}
                            fitView fitViewOptions={{ padding: 0.1, minZoom: narrow ? 0.5 : 0.2 }}
                            minZoom={0.2} maxZoom={2} nodesDraggable={false} nodesConnectable={false}>
                            <Background color="var(--grid-color)" bgColor="var(--bg-canvas)" />
                            <Controls showInteractive={false} />
                        </ReactFlow>
                    </div>
                ) : null}

                <p className="toiv-settings-note">
                    快照只读；需要改词或补镜头请回旧画布引擎。
                    {editDestination ? null : " 旧版入口未配置时，此处不会跳转。"}
                </p>
            </div>
        </ToivShell>
    );
}

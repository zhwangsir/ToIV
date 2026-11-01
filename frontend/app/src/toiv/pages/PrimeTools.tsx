import { Link } from "react-router-dom";
import Button from "../../components/ui/Button";
import ToivShell from "../shell/ToivShell";
import { PRIME_TOOLS } from "../tools/catalog";

export default function PrimeTools() {
    const ready = PRIME_TOOLS.filter((tool) => tool.available);
    const soon = PRIME_TOOLS.filter((tool) => !tool.available);
    return (
        <ToivShell>
            <div className="toiv-tools">
                <header className="toiv-tools-head">
                    <div>
                        <h1>工具</h1>
                        <p className="toiv-settings-note">独立生成台：不建项目也能出图出片，产物统一进任务中心。</p>
                    </div>
                    <Button variant="outline" size="sm" to="/tasks">去任务中心</Button>
                </header>

                <section className="toiv-settings-section" aria-labelledby="tools-ready">
                    <div className="toiv-settings-section-head">
                        <h2 id="tools-ready">现在可用</h2>
                        <span className="meta">{ready.length} 个工具</span>
                    </div>
                    <div className="toiv-tool-grid">
                        {ready.map((tool) => (
                            <Link key={tool.id} to={`/tools/${tool.id}`} className="toiv-tool-card">
                                <span className="toiv-tool-kind">{tool.kind === "video" ? "VIDEO" : "IMAGE"}</span>
                                <b>{tool.title}</b>
                                <small>{tool.blurb}</small>
                                <span className="toiv-tool-open">打开工具 →</span>
                            </Link>
                        ))}
                    </div>
                </section>

                <section className="toiv-settings-section" aria-labelledby="tools-soon">
                    <div className="toiv-settings-section-head">
                        <h2 id="tools-soon">即将开放</h2>
                        <span className="meta">按 ToIV 队列能力逐步接入</span>
                    </div>
                    <div className="toiv-tool-grid">
                        {soon.map((tool) => (
                            <article key={tool.id} className="toiv-tool-card is-soon" aria-disabled="true">
                                <span className="toiv-tool-kind">{tool.kind === "image" ? "IMAGE" : tool.kind === "video" ? "VIDEO" : "TOOL"}</span>
                                <b>{tool.title}</b>
                                <small>{tool.blurb}</small>
                                <span className="toiv-tool-open">即将开放</span>
                            </article>
                        ))}
                    </div>
                </section>
            </div>
        </ToivShell>
    );
}

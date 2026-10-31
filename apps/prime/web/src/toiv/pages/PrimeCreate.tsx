import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../../components/ui/Button";
import { createPrimeProject, retryPrimeImport, type PrimeCreateResult } from "../adapters/create";
import { ToivWorkbar } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

export default function PrimeCreate() {
    const navigate = useNavigate();
    const [title, setTitle] = useState("");
    const [premise, setPremise] = useState("");
    const [svml, setSvml] = useState("");
    const [notice, setNotice] = useState("");
    const [created, setCreated] = useState<PrimeCreateResult | null>(null);
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);
    const knownProject = useRef<PrimeCreateResult | null>(null);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        // State alone does not block two submit events in the same turn.
        if (pending.current || (!knownProject.current && !title.trim())) return;
        pending.current = true;
        setBusy(true);
        setNotice("");
        try {
            const result = knownProject.current
                ? await retryPrimeImport(knownProject.current, svml)
                : await createPrimeProject({ title, premise, svml });
            knownProject.current = result;
            setCreated(result);
            if (result.recovery) setNotice(`项目已创建，导入未完成 · ${result.recovery.message}`);
            else navigate(`/studio/${encodeURIComponent(result.id)}`);
        } catch (error) {
            setNotice(`创建未确认 · ${error instanceof Error ? error.message : "网络错误"} · 请先到项目库核对，避免重复创建`);
        } finally {
            pending.current = false;
            setBusy(false);
        }
    };
    return (
        <ToivShell>
            <ToivWorkbar face="pipeline" runningCount={0}
                onFaceChange={(face) => navigate(face === "canvas" ? "/drama" : face === "edit" ? "/history" : "/studio")}
                onOpenTasks={() => navigate("/history")} />
            <form className="toiv-create" onSubmit={submit} aria-label="新建项目" aria-busy={busy}>
                <h2>新建项目</h2>
                <label>标题<input value={title} disabled={busy || Boolean(created)} onChange={(event) => setTitle(event.target.value)} placeholder="例：雨夜便利店" /></label>
                <label>前提（可选）<textarea rows={2} value={premise} disabled={busy || Boolean(created)} onChange={(event) => setPremise(event.target.value)} /></label>
                <label>SVML 词锚脚本（可选）<textarea rows={6} value={svml} disabled={busy} onChange={(event) => setSvml(event.target.value)} placeholder={"[duration:60]\n推近||@{光}亮起@{/光}"} /></label>
                <p className="meta">创建空项目或导入已有 SVML；不会自动生成剧本、画面、配音或成片。</p>
                {created ? <p>已建项目：{created.title} · {created.id}。重试只导入此项目，不会重复创建。</p> : null}
                {notice ? <p className="toiv-saved" role="alert">{notice}</p> : null}
                <Button variant="lime" type="submit" disabled={busy || (created ? !svml.trim() : !title.trim())}>
                    {busy ? (created ? "正在重试导入…" : "正在创建并导入…") : created ? "重试导入到当前项目" : "创建并进入流水线"}
                </Button>
                {created ? <Button variant="outline" disabled={busy} onClick={() => navigate(`/studio/${encodeURIComponent(created.id)}`)}>打开已建项目</Button> : null}
            </form>
        </ToivShell>
    );
}

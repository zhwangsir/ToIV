import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../../components/ui/Button";
import { createPrimeProject } from "../adapters/create";
import { ToivWorkbar } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

export default function PrimeCreate() {
    const navigate = useNavigate();
    const [title, setTitle] = useState("");
    const [premise, setPremise] = useState("");
    const [svml, setSvml] = useState("");
    const [notice, setNotice] = useState("");
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setNotice("");
        try {
            const result = await createPrimeProject({ title, premise, svml });
            navigate(`/studio/${result.id}`);
        } catch (error) {
            setNotice(error instanceof Error && error.message.includes("import-svml")
                ? "项目已创建，但 SVML 导入失败 · 进入项目后重试"
                : "创建失败 · 稍后重试");
        }
    };
    return (
        <ToivShell>
            <ToivWorkbar face="pipeline" runningCount={0}
                onFaceChange={(face) => navigate(face === "canvas" ? "/drama" : face === "edit" ? "/history" : "/studio")}
                onOpenTasks={() => navigate("/history")} />
            <form className="toiv-create" onSubmit={submit} aria-label="新建项目">
                <h2>新建项目</h2>
                <label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例：雨夜便利店" /></label>
                <label>前提（可选）<textarea rows={2} value={premise} onChange={(event) => setPremise(event.target.value)} /></label>
                <label>SVML 词锚脚本（可选）<textarea rows={6} value={svml} onChange={(event) => setSvml(event.target.value)} placeholder={"[duration:60]\n推近||@{光}亮起@{/光}"} /></label>
                {notice ? <p className="toiv-saved" role="alert">{notice}</p> : null}
                <Button variant="lime" type="submit" disabled={!title.trim()}>创建并进入流水线</Button>
            </form>
        </ToivShell>
    );
}

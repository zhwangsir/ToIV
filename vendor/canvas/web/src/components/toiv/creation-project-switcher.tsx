/**
 * 合并创作台：项目切换器 + 台内「新建短剧」动作（侧栏一级不再放新建）。
 */
import { Clapperboard, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { createStudioProject, fetchDramaProjects, type ToivDramaProject } from "@/services/toiv/client";

type Props = {
    /** 当前项目 id（来自 ?project=） */
    projectId?: string | null;
};

export function CreationProjectSwitcher({ projectId }: Props) {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const [projects, setProjects] = useState<ToivDramaProject[]>([]);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const reload = useCallback(async () => {
        try {
            const rows = await fetchDramaProjects();
            setProjects(Array.isArray(rows) ? rows : []);
            setErr(null);
        } catch (e) {
            setErr(e instanceof Error ? e.message : "项目列表加载失败");
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    const selectProject = (id: string) => {
        const next = new URLSearchParams(searchParams);
        if (id) next.set("project", id);
        else next.delete("project");
        // 清掉旧 section/shot，避免串项目
        next.delete("section");
        next.delete("shot");
        setSearchParams(next, { replace: true });
    };

    const createNew = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const p = await createStudioProject({ title: `短剧 ${new Date().toLocaleString("zh-CN")}` });
            await reload();
            const id = String((p as { id?: string })?.id || "").trim();
            if (id) {
                navigate(`/create?project=${encodeURIComponent(id)}`, { replace: false });
            }
        } catch (e) {
            setErr(e instanceof Error ? e.message : "新建失败");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="toiv-creation-project-switcher" data-testid="creation-project-switcher">
            <div className="toiv-creation-project-switcher-main">
                <Clapperboard className="size-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden />
                <label className="sr-only" htmlFor="creation-project-select">
                    短剧项目
                </label>
                <select
                    id="creation-project-select"
                    className="toiv-creation-project-select"
                    value={projectId || ""}
                    onChange={(e) => selectProject(e.target.value)}
                    data-testid="creation-project-select"
                >
                    <option value="">自由创作（无项目）</option>
                    {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                            {(p as { title?: string; name?: string }).title ||
                                (p as { name?: string }).name ||
                                p.id}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="toiv-lumenx-hook"
                    onClick={() => void createNew()}
                    disabled={busy}
                    data-testid="creation-new-drama"
                    title="在创作台内新建短剧"
                >
                    <Plus className="size-3" aria-hidden />
                    新建短剧
                </button>
                <Link to="/toiv/drama" className="toiv-lumenx-hook" title="打开短剧项目列表">
                    项目列表
                </Link>
            </div>
            {err ? <p className="toiv-ws-creation-dock-meta">{err}</p> : null}
        </div>
    );
}

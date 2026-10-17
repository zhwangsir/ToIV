/**
 * P4 scene_asset(dramaclaw 设计采纳):场景锚点面板——场景/变体、冻结不可变快照、绑定分镜。
 * 绑定的锚点快照会被渲染链注入场景参考(跨镜共背景);冻结采用内容寻址,重冻不影响旧绑定。
 */
import { useCallback, useEffect, useState } from "react";
import {
    attachToivSceneToShot,
    createToivScene,
    freezeToivSceneAnchor,
    listToivScenes,
    type ToivSceneItem,
} from "@/services/toiv/client";
import { ToolButton } from "@/components/ui/base/buttons";

export function SceneAnchorPanel({
    projectId,
    shots,
}: {
    projectId: string;
    shots: Array<{ id: string; idx?: number | string; scene?: string }>;
}) {
    const [scenes, setScenes] = useState<ToivSceneItem[]>([]);
    const [name, setName] = useState("");
    const [env, setEnv] = useState("");
    const [snapUrl, setSnapUrl] = useState("");
    const [busySid, setBusySid] = useState<string | null>(null);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const reload = useCallback(async () => {
        try {
            const data = await listToivScenes(projectId);
            setScenes(data.scenes ?? []);
        } catch (e) {
            setErr(e instanceof Error ? e.message : "场景读取失败");
        }
    }, [projectId]);

    useEffect(() => {
        void reload();
    }, [reload]);

    const run = async (sid: string, fn: () => Promise<void>) => {
        setBusySid(sid);
        setErr(null);
        setMsg(null);
        try {
            await fn();
        } catch (e) {
            setErr(e instanceof Error ? e.message : "操作失败");
        } finally {
            setBusySid(null);
        }
    };

    return (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-[var(--border)] p-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">场景锚点</span>
                <span className="text-[var(--muted-foreground)]">冻结快照跨镜共背景;重冻不改旧绑定</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <input
                    className="w-32 rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5"
                    placeholder="新场景名"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label="新场景名"
                />
                <input
                    className="min-w-40 flex-1 rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5"
                    placeholder="环境提示词(可空)"
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                    aria-label="环境提示词"
                />
                <ToolButton
                    size="xs"
                    variant="ghost"
                    label="新建场景"
                    disabled={!name.trim() || busySid !== null}
                    onClick={() =>
                        void run("new", async () => {
                            await createToivScene(projectId, { name: name.trim(), environment_prompt: env.trim() });
                            setName("");
                            setEnv("");
                            setMsg("场景已创建");
                            await reload();
                        })
                    }
                />
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <input
                    className="min-w-40 flex-1 rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5"
                    placeholder="自选锚点图 URL(冻结时可选)"
                    value={snapUrl}
                    onChange={(e) => setSnapUrl(e.target.value)}
                    aria-label="锚点图 URL"
                />
            </div>
            {err && <p className="text-xs text-[var(--danger)]">{err}</p>}
            {msg && <p className="text-xs text-[var(--muted-foreground)]">{msg}</p>}
            {scenes.length ? (
                <ul className="flex flex-col gap-1.5">
                    {scenes.map((scene) => (
                        <li key={scene.id} className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] px-2 py-1.5">
                            <span className="font-medium text-foreground">{scene.name}</span>
                            {scene.frozen_anchor?.snapshot_url
                                ? <span className="text-[var(--accent)]">已冻结 · {scene.frozen_anchor.anchor_id ?? "锚点"}</span>
                                : <span className="text-[var(--muted-foreground)]">未冻结</span>}
                            <ToolButton
                                size="xs"
                                variant="ghost"
                                label={busySid === scene.id ? "处理中…" : snapUrl.trim() ? "冻结自选图" : "冻结主参考"}
                                disabled={busySid !== null}
                                onClick={() =>
                                    void run(scene.id, async () => {
                                        const useSelected = Boolean(snapUrl.trim());
                                        await freezeToivSceneAnchor(scene.id, {
                                            anchor_id: useSelected ? "selected" : "master",
                                            image_url: useSelected ? snapUrl.trim() : undefined,
                                        });
                                        setMsg(`已冻结「${scene.name}」锚点(不可变快照)`);
                                        await reload();
                                    })
                                }
                            />
                            <select
                                className="rounded border border-[var(--border)] bg-transparent px-1 py-0.5"
                                defaultValue=""
                                aria-label={`绑定分镜到 ${scene.name}`}
                                disabled={busySid !== null}
                                onChange={(e) => {
                                    const shotId = e.target.value;
                                    if (!shotId) return;
                                    void run(scene.id, async () => {
                                        await attachToivSceneToShot(scene.id, { shot_id: shotId, use_frozen: true });
                                        setMsg(`「${scene.name}」已绑定分镜,渲染将注入锚点快照`);
                                        e.target.value = "";
                                    });
                                }}
                            >
                                <option value="">绑定到分镜…</option>
                                {shots.map((s) => (
                                    <option key={s.id} value={s.id}>
                                        #{s.idx ?? "?"} {s.scene?.slice(0, 12) || s.id.slice(0, 6)}
                                    </option>
                                ))}
                            </select>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-[var(--muted-foreground)]">还没有场景。先新建场景,冻结锚点后绑定分镜。</p>
            )}
        </div>
    );
}

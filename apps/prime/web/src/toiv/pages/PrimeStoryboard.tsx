import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import { loadPrimeStoryboard, savePrimeShotPrompt, savePrimeShotBeats, pickPrimeTake, primeTakeMediaUrl,
    type PrimeShotCard, type PrimeStoryboardModel } from "../adapters/storyboard";
import { RecipePanelPrime } from "../addons/RecipePanelPrime";
import { ToivWorkbar, type PrimeFace } from "../addons/ToivWorkbar";
import ToivShell from "../shell/ToivShell";

const FACE_HREF: Record<PrimeFace, string> = { pipeline: "/studio", canvas: "/drama", edit: "/history" };
type Draft = { base: PrimeShotCard; prompt: string; texts: string[]; totalSec: string };
const draftFor = (shot: PrimeShotCard): Draft => ({ base: shot, prompt: shot.prompt, texts: shot.beats.map(b => b.text), totalSec: String(shot.durationSec) });
const isDirty = (draft: Draft) => draft.base.beats.length
    ? draft.totalSec !== String(draft.base.durationSec) || draft.texts.some((text, i) => text !== draft.base.beats[i].text)
    : draft.prompt !== draft.base.prompt;
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试";

export default function PrimeStoryboard() {
    const { id = "" } = useParams();
    return <Storyboard key={id} id={id} />;
}
function Storyboard({ id }: { id: string }) {
    const navigate = useNavigate();
    const [model, setModel] = useState<PrimeStoryboardModel | null>(null);
    const [failed, setFailed] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, Draft>>({});
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);
    const alive = useRef(true);
    const [tab, setTab] = useState<"shots" | "recipes">("shots");
    const hasDrafts = Object.keys(drafts).length > 0;
    useEffect(() => {
        alive.current = true;
        loadPrimeStoryboard(id).then(next => { if (alive.current) setModel(next); }).catch(error => {
            if (alive.current) { setFailed(true); setNotice(errorText(error)); }
        });
        return () => { alive.current = false; };
    }, [id]);
    useEffect(() => {
        if (!hasDrafts) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [hasDrafts]);
    const begin = () => {
        if (pending.current) return false;
        pending.current = true;
        setBusy(true);
        setNotice("");
        return true;
    };
    const finish = () => {
        pending.current = false;
        if (alive.current) setBusy(false);
    };
    const discard = (shotId: string) => setDrafts(prev => {
        const next = { ...prev }; delete next[shotId]; return next;
    });
    const edit = (shot: PrimeShotCard, patch: Partial<Pick<Draft, "prompt" | "texts" | "totalSec">>) => {
        setDrafts(prev => {
            const next = { ...prev };
            const draft = { ...(prev[shot.id] ?? draftFor(shot)), ...patch };
            if (isDirty(draft)) next[shot.id] = draft;
            else delete next[shot.id];
            return next;
        });
    };
    const refresh = async () => {
        if (!begin()) return;
        try {
            const next = await loadPrimeStoryboard(id);
            if (alive.current) {
                setModel(next); setFailed(false);
                setNotice(hasDrafts ? "已刷新；本地草稿和原修订基线仍保留。冲突时请先复制草稿，再放弃本地修改并重新编辑。" : "已刷新分镜");
            }
        } catch (error) { if (alive.current) setNotice(errorText(error)); }
        finally { finish(); }
    };
    const save = async (shotId: string) => {
        const draft = drafts[shotId];
        if (!model || !draft || !isDirty(draft) || !begin()) return;
        // A refresh or another shot's save must not rebase unsaved drafts onto a newer revision.
        const snapshot = { ...model, shots: model.shots.map(s => drafts[s.id]?.base ?? s) };
        try {
            const next = draft.base.beats.length
                ? await savePrimeShotBeats(snapshot, shotId, draft.texts, Number(draft.totalSec))
                : await savePrimeShotPrompt(snapshot, shotId, draft.prompt);
            if (alive.current) {
                setModel(next); discard(shotId);
                setNotice(`已保存 ${draft.base.title}${draft.base.beats.length ? " 并重排拍文本" : " 提示词"}`);
            }
        } catch (error) { if (alive.current) setNotice(`保存未完成 · ${errorText(error)}`); }
        finally { finish(); }
    };
    const pick = async (shot: PrimeShotCard, takeId: string) => {
        const take = shot.takes.find(t => t.id === takeId);
        if (!take || take.picked || take.status !== "done" || !take.src?.trim() || !begin()) return;
        try {
            const saved = await pickPrimeTake(shot, takeId);
            if (alive.current) {
                setModel(prev => prev ? { ...prev, shots: prev.shots.map(s => s.id === saved.id ? saved : s) } : prev);
                setNotice(`已采用 ${shot.title} ${take.label}`);
            }
        } catch (error) { if (alive.current) setNotice(`采用失败 · ${errorText(error)}`); }
        finally { finish(); }
    };
    // If another editor deletes a shot, keep its local text visible and copyable until explicitly discarded.
    const visibleShots = [...(model?.shots ?? []), ...Object.values(drafts).filter(d => !model?.shots.some(s => s.id === d.base.id)).map(d => d.base)];
    return (
        <ToivShell>
            <ToivWorkbar face="pipeline" runningCount={model?.runningCount ?? 0}
                onFaceChange={(face) => navigate(FACE_HREF[face])} onOpenTasks={() => navigate("/history")} />
            <section className="toiv-shots" aria-busy={busy}>
                <header className="toiv-shots-bar">
                    <h2>{model?.title ?? (failed ? "载入失败" : "载入中")}</h2>
                    <span className="meta">{model ? `${model.shots.length} 镜${model.runningCount > 0 ? ` · ${model.runningCount} 渲染中` : ""}` : "正在载入"}</span>
                    <Button className="toiv-shots-refresh" variant="outline" disabled={busy} onClick={() => void refresh()}>刷新分镜</Button>
                </header>
                <div className="toiv-seg" role="group" aria-label="分镜面板">
                    <Button variant={tab === "shots" ? "lime" : "ghost"} disabled={busy} aria-pressed={tab === "shots"} onClick={() => setTab("shots")}>分镜</Button>
                    <Button variant={tab === "recipes" ? "lime" : "ghost"} disabled={busy} aria-pressed={tab === "recipes"} onClick={() => setTab("recipes")}>配方</Button>
                </div>
                <p className="meta">本页支持编辑、重排和采用已有候选；未接入画面生成、配音或成片生成。编辑不会触发生成。</p>
                {hasDrafts ? <p className="meta">有未保存修改；切换面板保留草稿，离开页面前请保存或复制。</p> : null}
                {failed ? <div className="toiv-empty"><p>分镜载入失败 · 可刷新重试</p><Button variant="lime" onClick={() => navigate("/studio")}>回项目库</Button></div> : null}
                {notice ? <p className="toiv-saved" role="status">{notice}</p> : null}
                {tab === "recipes" ? <RecipePanelPrime shotId={model?.shots[0]?.id} onNotice={setNotice} /> : null}
                {tab === "shots" && model && !visibleShots.length ? <p className="toiv-empty">暂无分镜；本页不会自动生成镜头。</p> : null}
                {tab === "shots" ? visibleShots.map(shot => {
                    const draft = drafts[shot.id] ?? draftFor(shot);
                    const dirty = Boolean(drafts[shot.id]);
                    const missing = !model?.shots.some(s => s.id === shot.id);
                    return (
                        <article className={`toiv-shot st-${shot.status}`} key={shot.id}>
                            <header>
                                <b>{shot.title}</b><span className="meta">{shot.camera} · {shot.durationSec}s</span>
                                <span className={`flag flag-${shot.status}`}>{shot.status === "done" ? "完成" : shot.status === "run" ? "渲染中" : shot.status === "error" ? "失败" : "排队"}</span>
                            </header>
                            {shot.error ? <p role="alert">{shot.error}</p> : null}
                            {missing ? <p role="alert">该镜头已不在服务端列表中，本地草稿仍保留供复制。</p> : null}
                            {draft.base.beats.length ? <>
                                <div className="toiv-beats">{draft.base.beats.map((beat, index) => (
                                    <label className="toiv-prompt" key={index}>第 {index + 1} 拍 · {beat.kind === "v" ? "画面" : beat.kind === "d" ? "对白" : "未标通道"}
                                        <textarea aria-label={`第 ${index + 1} 拍文本`} rows={2} value={draft.texts[index]} disabled={busy}
                                            onChange={event => edit(shot, { texts: draft.texts.map((text, i) => i === index ? event.target.value : text) })} />
                                    </label>
                                ))}</div>
                                <label className="toiv-prompt">总时长（秒）<input type="number" min={3} max={60} step={1} value={draft.totalSec} disabled={busy}
                                    onChange={event => edit(shot, { totalSec: event.target.value })} /></label>
                                <label className="toiv-prompt">派生提示词<textarea rows={3} value={shot.prompt} readOnly /></label>
                                <p className="meta">按拍文本为真源；保存后重排并回读派生内容，不增删拍。</p>
                            </> : <label className="toiv-prompt">提示词
                                <textarea rows={3} value={draft.prompt} disabled={busy} onChange={event => edit(shot, { prompt: event.target.value })} />
                            </label>}
                            <div className="toiv-seg">
                                <Button variant="lime" disabled={!dirty || busy || missing} onClick={() => void save(shot.id)}>{draft.base.beats.length ? "保存并重排" : "保存提示词"}</Button>
                                {dirty ? <><span className="meta">未保存</span><Button variant="ghost" disabled={busy} onClick={() => discard(shot.id)}>放弃本地修改</Button></> : null}
                            </div>
                            <div className="toiv-takes" role="group" aria-label={`${shot.title} 候选 Takes`}>
                                {shot.takes.map(take => {
                                    const src = primeTakeMediaUrl(take.src);
                                    return <section key={take.id} aria-label={`${take.label} 候选比较`}>
                                        <h3>{take.label} · {take.status}{take.picked ? " · 当前采用" : ""}</h3>
                                        {src ? <video width="320" src={src} controls muted playsInline preload="none" aria-label={`${take.label} 预览`} /> : <p className="meta">暂无可预览产物</p>}
                                        <dl>
                                            <dt>候选 ID</dt><dd>{take.id}</dd>
                                            <dt>Seed</dt><dd>{take.seed ?? "未提供"}</dd>
                                            <dt>引擎</dt><dd>{take.videoModel || "未提供"}</dd>
                                            <dt>管线</dt><dd>{take.pipeline || "未提供"}</dd>
                                            <dt>修订</dt><dd>{take.revisionId || "未提供"}</dd>
                                            <dt>QA</dt><dd>{take.qaVerdict || "未提供"}</dd>
                                        </dl>
                                        {take.error ? <p>{take.error}</p> : null}
                                        <Button variant={take.picked ? "lime" : "outline"} size="sm" aria-label={`采用 ${take.label}`} aria-pressed={take.picked}
                                            disabled={busy || missing || take.picked || take.status !== "done" || !take.src?.trim() || !shot.candidatesDigest}
                                            onClick={() => void pick(shot, take.id)}>采用 {take.label}</Button>
                                    </section>;
                                })}
                                {shot.takes.length === 0 ? <span className="meta">暂无候选</span> : <span className="meta">仅 done 且有产物 URL 的候选可采用；候选变化请刷新。</span>}
                            </div>
                        </article>
                    );
                }) : null}
            </section>
        </ToivShell>
    );
}

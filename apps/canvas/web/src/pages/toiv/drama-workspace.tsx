/**
 * v2 项目工作区骨架（S2/W1.1，2026-10-11）。
 *
 * 六段式：剧本 → 资产 → 分镜 → 镜头 → 时间线 → 成片（docs/ops/PLATFORM_V2_CONTRACT.md §1）。
 * 本页挂在独立路由 /toiv/ws/:id/:section（不动现役 /toiv/drama/:id，零回归——绞杀者纪律）；
 * S3/S4 逐段把经典端能力迁进来，迁移齐后 W1.2 末步做路由对调。
 * 现在各段为只读骨架：头部项目状态 + 各段已有数据的轻量呈现 + 落地批次的说明。
 */
import { BookOpen, Clapperboard, Film, IdCard, Layers, ListOrdered, Loader2, PlayCircle, RefreshCw, ScrollText, Sparkles, Users, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { EmptyState } from "@/components/ui/product/empty-state";
import { WorkspacePage } from "@/components/layout/workspace-page";
import {
    createStudioCharacter,
    fetchCharacterSheets,
    fetchDramaProject,
    generateCharacterSheetStrict,
    patchStudioProject,
    pollScriptParse,
    saveStudioShots,
    submitScriptParse,
    triggerBatchRender,
    triggerShotRender,
    triggerShotVoice,
    type ToivCharacterSheet,
    type ToivDramaCharacter,
    type ToivDramaDetail,
} from "@/services/toiv/client";

const SECTIONS = [
    { key: "script", label: "剧本", icon: BookOpen, batch: "S3" },
    { key: "assets", label: "资产", icon: Users, batch: "S3" },
    { key: "storyboard", label: "分镜", icon: ListOrdered, batch: "S5" },
    { key: "shots", label: "镜头", icon: Clapperboard, batch: "S3/S4" },
    { key: "timeline", label: "时间线", icon: Layers, batch: "S9" },
    { key: "final", label: "成片", icon: Film, batch: "S9" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

function normalizeSection(raw: string | undefined): SectionKey {
    return (SECTIONS.find((s) => s.key === raw)?.key ?? "script") as SectionKey;
}

const STATUS_TONE: Record<string, "success" | "warning" | "error" | "neutral"> = {
    done: "success",
    ready: "success",
    generating: "warning",
    storyboard: "warning",
    error: "error",
    draft: "neutral",
    pending: "neutral",
};

function SectionShell({ title, batch, children }: { title: string; batch: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-foreground">{title}</h2>
                <StatusBadge variant="filled" tone="neutral" label={`${batch} 迁入`} size="sm" />
            </div>
            {children}
        </section>
    );
}

function StatusLine({ project }: { project: ToivDramaDetail }) {
    const p = project.pipeline;
    const parts: string[] = [];
    if (p) {
        parts.push(`镜头 ${p.total_shots}`);
        const done = p.by_status?.done ?? 0;
        if (p.total_shots > 0) parts.push(`完成 ${done}/${p.total_shots}`);
        if (p.next_step) parts.push(`下一步 ${p.next_step.label}×${p.next_step.todo}`);
    }
    if (project.width && project.height) parts.push(`${project.width}×${project.height}@${project.fps ?? "?"}fps`);
    return <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">{parts.join(" · ") || "暂无管线数据"}</p>;
}

export default function DramaWorkspacePage() {
    const { id } = useParams<{ id: string }>();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const section = normalizeSection(searchParams.get("section") ?? undefined);

    const [detail, setDetail] = useState<ToivDramaDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        if (!id) return;
        setLoading(true);
        setError(false);
        try {
            const d = await fetchDramaProject(id);
            setDetail(d);
            setPremiseText(d.premise || "");
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    const goSection = (key: SectionKey) => navigate(`/toiv/ws/${id}?section=${key}`, { replace: true });
    const shots = detail?.shots ?? [];
    const characters = detail?.characters ?? [];

    // ---- W2.1: 剧本→分镜自动化(后端既有 studio/script/parse 异步链路) ----
    const [premiseText, setPremiseText] = useState("");
    const [numShots, setNumShots] = useState(8);
    const [parsing, setParsing] = useState(false);
    const [parseMsg, setParseMsg] = useState<string | null>(null);
    const [parseError, setParseError] = useState<string | null>(null);
    const pollStop = useRef(false);

    useEffect(() => () => { pollStop.current = true; }, []);

    // ---- W1.3: 资产段设定卡抽屉 ----
    const [sheetChar, setSheetChar] = useState<ToivDramaCharacter | null>(null);
    const [sheets, setSheets] = useState<ToivCharacterSheet[]>([]);
    const [sheetsLoading, setSheetsLoading] = useState(false);
    const [regenStyle, setRegenStyle] = useState<string | null>(null);
    const [sheetError, setSheetError] = useState<string | null>(null);

    const openSheets = useCallback(async (c: ToivDramaCharacter) => {
        setSheetChar(c);
        setSheets([]);
        setSheetError(null);
        setSheetsLoading(true);
        try {
            setSheets(await fetchCharacterSheets(c.id));
        } catch {
            setSheets([]);
        } finally {
            setSheetsLoading(false);
        }
    }, []);

    const regenSheet = useCallback(async (cid: string, style: string) => {
        setRegenStyle(style);
        setSheetError(null);
        try {
            await generateCharacterSheetStrict(cid, style);
            setSheets(await fetchCharacterSheets(cid));
        } catch (e) {
            setSheetError(e instanceof Error ? e.message : "设定卡生成失败");
        } finally {
            setRegenStyle(null);
        }
    }, []);

    // ---- W1.4: 镜头段生成操作(渲染/配音/整批) ----
    const [busyShots, setBusyShots] = useState<Set<string>>(new Set());
    const [batchRendering, setBatchRendering] = useState(false);
    const markBusy = (sid: string, on: boolean) =>
        setBusyShots((prev) => {
            const n = new Set(prev);
            if (on) n.add(sid); else n.delete(sid);
            return n;
        });
    const RENDERED_STATES = new Set(["rendering", "rendered", "voiced", "lipsynced", "done"]);
    const runShotRender = useCallback(async (sid: string) => {
        markBusy(sid, true);
        try {
            await triggerShotRender(sid);
            await load();
        } finally {
            markBusy(sid, false);
        }
    }, [load]);
    const runShotVoice = useCallback(async (sid: string) => {
        markBusy(sid, true);
        try {
            await triggerShotVoice(sid);
            await load();
        } finally {
            markBusy(sid, false);
        }
    }, [load]);
    const runBatchRender = useCallback(async () => {
        if (!id) return;
        setBatchRendering(true);
        try {
            await triggerBatchRender(id);
            await load();
        } finally {
            setBatchRendering(false);
        }
    }, [id, load]);

    const runAutoStoryboard = useCallback(async () => {
        if (!id || parsing) return;
        pollStop.current = false;
        setParsing(true);
        setParseError(null);
        setParseMsg("保存剧本并提交拆解…");
        try {
            const premise = premiseText.trim();
            if (!premise) throw new Error("剧本为空,先写下或粘贴剧情概要");
            await patchStudioProject(id, { premise });
            const { job_id } = await submitScriptParse(id, premise, { num_shots: numShots, style: detail?.style });
            setParseMsg(`AI 拆解中(约 20-40s)…`);
            // 2.5s 轮询,上限 150s
            for (let i = 0; i < 60 && !pollStop.current; i++) {
                await new Promise((r) => setTimeout(r, 2500));
                const r = await pollScriptParse(id, job_id);
                if (r.status === "error") throw new Error(r.error || "拆解失败");
                if (r.status === "done" && r.shots) {
                    setParseMsg(`拆解完成:${r.shots.length} 镜 / ${(r.characters ?? []).length} 角色,正在落库…`);
                    // 新角色入库(按名字去重)
                    const existing = new Set((detail?.characters ?? []).map((c) => (c.name || "").trim()));
                    for (const c of r.characters ?? []) {
                        const n = (c.name || "").trim();
                        if (n && !existing.has(n)) {
                            await createStudioCharacter(id, c);
                            existing.add(n);
                        }
                    }
                    await saveStudioShots(id, r.shots);
                    await load();
                    setParseMsg(`已生成 ${r.shots.length} 镜并保存,已跳转分镜表`);
                    goSection("storyboard");
                    return;
                }
            }
            if (!pollStop.current) throw new Error("拆解超时,可在任务中心查看进度后重试");
        } catch (e) {
            setParseError(e instanceof Error ? e.message : "拆解失败,请重试");
            setParseMsg(null);
        } finally {
            setParsing(false);
        }
    }, [id, parsing, premiseText, numShots, detail, load, goSection]);

    return (
        <WorkspacePage fluid className="toiv-drama-workspace">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
                <header className="flex items-start justify-between gap-4">
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                            <h1 className="text-xl font-semibold leading-7 text-foreground">
                                {detail?.title || (loading ? "加载中…" : "项目工作区")}
                            </h1>
                            {detail && (
                                <StatusBadge
                                    variant="filled"
                                    tone={STATUS_TONE[detail.status] ?? "neutral"}
                                    label={detail.status}
                                    size="sm"
                                />
                            )}
                        </div>
                        {detail && <StatusLine project={detail} />}
                        <p className="text-xs leading-5 text-[var(--muted-foreground,#a8a8a8)]">
                            v2 六段工作区（骨架）· 各段能力按批次迁入 · 数据与经典端同源只读
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                        <Link to={`/toiv/drama/${id}`}>
                            <ToolButton variant="default" icon={<ScrollText />} label="经典详情" />
                        </Link>
                        <Link to="/toiv/drama">
                            <ToolButton variant="default" icon={<Clapperboard />} label="项目列表" />
                        </Link>
                    </div>
                </header>

                <nav className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface,transparent)] p-1" aria-label="工作区分区">
                    {SECTIONS.map((s) => {
                        const Icon = s.icon;
                        const active = s.key === section;
                        return (
                            <button
                                key={s.key}
                                type="button"
                                onClick={() => goSection(s.key)}
                                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                                    active
                                        ? "bg-[var(--surface-active,rgba(255,255,255,0.1))] text-foreground"
                                        : "text-[var(--muted-foreground,#a8a8a8)] hover:text-foreground"
                                }`}
                            >
                                <Icon className="size-3.5" aria-hidden />
                                {s.label}
                            </button>
                        );
                    })}
                </nav>

                {loading ? (
                    <div className="flex min-h-64 items-center justify-center">
                        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" />
                    </div>
                ) : error || !detail ? (
                    <EmptyState description="项目加载失败,请刷新重试" />
                ) : (
                    <div className="flex flex-col gap-4 rounded-xl border border-[var(--border)] p-4">
                        {section === "script" && (
                            <SectionShell title="剧本" batch="S5/W2.1">
                                <textarea
                                    value={premiseText}
                                    onChange={(e) => setPremiseText(e.target.value)}
                                    rows={8}
                                    placeholder="写下或粘贴剧情概要/剧本,然后交给 AI 拆解为分镜…"
                                    className="w-full resize-y rounded-lg border border-[var(--border)] bg-transparent p-3 text-sm leading-6 text-foreground outline-none focus:border-[var(--workspace-accent,#666)]"
                                    aria-label="剧本正文"
                                />
                                <div className="flex flex-wrap items-center gap-2">
                                    <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                        目标镜数
                                        <select
                                            value={numShots}
                                            onChange={(e) => setNumShots(Number(e.target.value))}
                                            className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-foreground"
                                            aria-label="目标镜数"
                                        >
                                            {[4, 6, 8, 12, 16].map((n) => (
                                                <option key={n} value={n}>
                                                    {n}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <ToolButton
                                        variant="default"
                                        icon={<Sparkles />}
                                        label={parsing ? "拆解中…" : "AI 拆解为分镜"}
                                        onClick={() => void runAutoStoryboard()}
                                        loading={parsing}
                                    />
                                    <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                        已有 {shots.length} 镜 · 拆解保存为全量替换(旧分镜会被覆盖)
                                    </span>
                                </div>
                                {parseMsg && (
                                    <p className="flex items-center gap-1.5 text-xs text-foreground">
                                        {parsing && <Loader2 className="size-3 animate-spin" aria-hidden />}
                                        {parseMsg}
                                    </p>
                                )}
                                {parseError && (
                                    <p className="text-xs text-[var(--danger,#e5484d)]">{parseError}</p>
                                )}
                            </SectionShell>
                        )}
                        {section === "assets" && (
                            <SectionShell title="资产（角色/场景/道具）" batch="S3">
                                {characters.length === 0 ? (
                                    <EmptyState description="暂无角色资产(AI 拆镜会自动入库,或在经典详情添加)" />
                                ) : (
                                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                                        {characters.map((c) => (
                                            <li key={c.id} className="flex flex-col gap-1.5 rounded-lg border border-[var(--border)] p-3">
                                                <span className="text-sm font-medium text-foreground">{c.name || "未命名"}</span>
                                                <span className="line-clamp-2 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                                    {c.description || c.visual_prompt || "无描述"}
                                                </span>
                                                <ToolButton
                                                    size="sm"
                                                    variant="default"
                                                    icon={<IdCard />}
                                                    label="设定卡"
                                                    onClick={() => void openSheets(c)}
                                                />
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </SectionShell>
                        )}
                        {section === "storyboard" && (
                            <SectionShell title="分镜表" batch="S5">
                                {shots.length === 0 ? (
                                    <EmptyState description="暂无分镜(剧本→自动分镜 S5 落地)" />
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left text-xs">
                                            <thead className="text-[var(--muted-foreground,#a8a8a8)]">
                                                <tr>
                                                    <th className="px-2 py-1.5">#</th>
                                                    <th className="px-2 py-1.5">场景</th>
                                                    <th className="px-2 py-1.5">台词</th>
                                                    <th className="px-2 py-1.5">时长</th>
                                                    <th className="px-2 py-1.5">状态</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {shots.map((s) => (
                                                    <tr key={s.id} className="border-t border-[var(--border)]">
                                                        <td className="px-2 py-1.5 tabular-nums">{s.idx}</td>
                                                        <td className="max-w-72 truncate px-2 py-1.5">{s.scene || "—"}</td>
                                                        <td className="max-w-72 truncate px-2 py-1.5">{s.dialogue || "—"}</td>
                                                        <td className="px-2 py-1.5 tabular-nums">{s.duration_sec ?? "—"}s</td>
                                                        <td className="px-2 py-1.5">
                                                            <StatusBadge variant="filled" tone={STATUS_TONE[s.status] ?? "neutral"} label={s.status} size="sm" />
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </SectionShell>
                        )}
                        {section === "shots" && (
                            <SectionShell title="镜头（生成状态）" batch="S3/S4">
                                {shots.length === 0 ? (
                                    <EmptyState description="暂无镜头(先在剧本段 AI 拆解)" />
                                ) : (
                                    <>
                                        <div className="flex items-center gap-2">
                                            <ToolButton
                                                variant="default"
                                                icon={<PlayCircle />}
                                                label={batchRendering ? "整批渲染中…" : "整批渲染(全部未完成镜)"}
                                                onClick={() => void runBatchRender()}
                                                loading={batchRendering}
                                            />
                                            <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                                渲染走 H3 管线,同步等待数分钟;完成后状态自动刷新(N 候选选优 UI 属 S3/S4)
                                            </span>
                                        </div>
                                        <ul className="flex flex-col gap-2">
                                            {shots.map((s) => {
                                                const busy = busyShots.has(s.id);
                                                const canRender = !RENDERED_STATES.has(s.status) && !busy;
                                                const canVoice = s.status === "rendered" && !s.voice_url && !busy;
                                                return (
                                                    <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
                                                        <span className="w-8 tabular-nums text-[var(--muted-foreground,#a8a8a8)]">#{s.idx}</span>
                                                        <span className="min-w-0 flex-1 truncate">{s.scene || s.prompt || "—"}</span>
                                                        <StatusBadge variant="filled" tone={STATUS_TONE[s.status] ?? "neutral"} label={s.status} size="sm" />
                                                        {s.video_url && <StatusBadge variant="filled" tone="success" label="视频" size="sm" />}
                                                        {s.voice_url && <StatusBadge variant="filled" tone="success" label="配音" size="sm" />}
                                                        {s.final_clip_url && <StatusBadge variant="filled" tone="success" label="成片段" size="sm" />}
                                                        {canVoice && (
                                                            <ToolButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<Volume2 />}
                                                                label={busy ? "配音中…" : "配音"}
                                                                onClick={() => void runShotVoice(s.id)}
                                                            />
                                                        )}
                                                        {canRender && (
                                                            <ToolButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<PlayCircle />}
                                                                label={busy ? "渲染中…" : "渲染"}
                                                                onClick={() => void runShotRender(s.id)}
                                                            />
                                                        )}
                                                        {busy && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </>
                                )}
                            </SectionShell>
                        )}
                        {section === "timeline" && (
                            <SectionShell title="时间线（汇编）" batch="S9">
                                <EmptyState description="播放列表式汇编(排序/时长/预览/合成)S9 落地;契约见 PLATFORM_V2_CONTRACT RenderVersion" />
                            </SectionShell>
                        )}
                        {section === "final" && (
                            <SectionShell title="成片" batch="S9">
                                {detail.final_url ? (
                                    <video src={detail.final_url} controls className="max-h-96 w-full rounded-lg border border-[var(--border)]" />
                                ) : (
                                    <EmptyState description="暂无成片;版本化交付(RenderVersion)S9 落地" />
                                )}
                            </SectionShell>
                        )}
                    </div>
                )}
            </div>
            <AppDrawer open={!!sheetChar} onClose={() => setSheetChar(null)} width={440} title={sheetChar?.name || "角色设定卡"}>
                {sheetChar && (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm leading-relaxed text-foreground">{sheetChar.description || sheetChar.visual_prompt || "无描述"}</p>
                        {sheetChar.visual_prompt && (
                            <p className="rounded-xl bg-[var(--muted,rgba(255,255,255,0.05))] p-3 text-xs leading-relaxed text-muted-foreground">{sheetChar.visual_prompt}</p>
                        )}
                        <div className="flex flex-col gap-2">
                            <span className="text-xs font-medium text-foreground">设定卡（{sheets.length}）</span>
                            {sheetError && (
                                <p className="rounded-lg border border-[var(--border)] bg-[var(--muted,rgba(255,255,255,0.05))] p-2.5 text-xs text-[var(--danger,#e5484d)]">
                                    {sheetError}
                                </p>
                            )}
                            {sheetsLoading ? (
                                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="加载中" />
                            ) : sheets.length === 0 ? (
                                <div className="flex flex-col gap-2">
                                    <EmptyState size="compact" description="暂无设定卡,选择风格生成(走 GPU,约 1-3 分钟)" />
                                    <div className="flex justify-center gap-2">
                                        {(["ancient_realistic", "anime"] as const).map((st) => (
                                            <ToolButton
                                                key={st}
                                                size="sm"
                                                variant="default"
                                                icon={<IdCard />}
                                                label={st === "ancient_realistic" ? "古风写实" : "二次元"}
                                                loading={regenStyle === st}
                                                onClick={() => void regenSheet(sheetChar.id, st)}
                                            />
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                sheets.map((sh) => (
                                    <div key={sh.style} className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] p-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[11px] text-muted-foreground">
                                                {sh.style}
                                                {sh.mtime ? ` · ${new Date(sh.mtime).toLocaleDateString("zh-CN")}` : ""}
                                            </span>
                                            <ToolButton
                                                size="xs"
                                                icon={<RefreshCw />}
                                                label="重生成"
                                                loading={regenStyle === sh.style}
                                                onClick={() => void regenSheet(sheetChar.id, sh.style)}
                                            />
                                        </div>
                                        {sh.sheet_url && <img src={sh.sheet_url} alt="" className="w-full rounded-lg" loading="lazy" />}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}
            </AppDrawer>
        </WorkspacePage>
    );
}

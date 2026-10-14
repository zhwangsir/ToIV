/**
 * v2 项目工作区骨架（S2/W1.1，2026-10-11）。
 *
 * 六段式：剧本 → 资产 → 分镜 → 镜头 → 时间线 → 成片（docs/ops/PLATFORM_V2_CONTRACT.md §1）。
 * 本页挂在独立路由 /toiv/ws/:id/:section（不动现役 /toiv/drama/:id，零回归——绞杀者纪律）；
 * S3/S4 逐段把经典端能力迁进来，迁移齐后 W1.2 末步做路由对调。
 * 现在各段为只读骨架：头部项目状态 + 各段已有数据的轻量呈现 + 落地批次的说明。
 */
import { ArrowDown, ArrowUp, BookOpen, Camera, Captions, Check, Clapperboard, FileText, Film, IdCard, Layers, ListOrdered, Loader2, Mic, PlayCircle, RefreshCw, Save, ScrollText, Sparkles, Users, Volume2 } from "lucide-react";
import { Select } from "antd";
import type { ToivFrameVariant, ToivSharedAsset } from "@/services/toiv/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { ToolButton } from "@/components/ui/base/buttons";
import { StatusBadge } from "@/components/ui/base/badges";
import { AppDrawer } from "@/components/ui/product/app-drawer";
import { EmptyState } from "@/components/ui/product/empty-state";
import { WorkspacePage } from "@/components/layout/workspace-page";
import {
    adoptSheetAsReference,
    buildMakeupCChainFromDrama,
    createCChain,
    createStudioCharacter,
    fetchCharacterSheets,
    fetchDramaProject,
    fetchAccelTiers,
    formatAccelTierLabel,
    formatAccelTierNote,
    OFF_ACCEL_TIER,
    patchStudioProject,
    pollScriptParse,
    pickShotCandidate,
    applySharedAsset,
    assembleStudioProject,
    buildSubtitles,
    lipsyncShotStrict,
    burnSubtitles,
    fetchSharedAssets,
    pollFrameVariants,
    pollSheetJob,
    renderShotAsync,
    renderShotStrict,
    saveStudioShots,
    submitFrameVariants,
    importSvmlStudio,
    submitScriptParse,
    submitSheetAsync,
    triggerBatchRender,
    triggerShotVoice,
    type ToivCharacterSheet,
    type ToivDramaCharacter,
    type ToivDramaDetail,
    type ToivAccelTier,
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
    const [sheetMsg, setSheetMsg] = useState<string | null>(null);

    const openSheets = useCallback(async (c: ToivDramaCharacter) => {
        setSheetChar(c);
        setSheets([]);
        setSheetError(null);
        setSheetMsg(null);
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
        setSheetMsg(null);
        try {
            const { job_id } = await submitSheetAsync(cid, style);
            setSheetMsg(`后台生成中(作业 ${job_id.slice(0, 8)}…,全程 15-20 分钟;可关抽屉稍后再看,任务中心可见)`);
            for (let i = 0; i < 300 && !pollStop.current; i++) {
                await new Promise((r) => setTimeout(r, 5000));
                const r = await pollSheetJob(cid, job_id);
                if (r.status === "error") throw new Error(r.error || "生成失败");
                if (r.status === "done") {
                    setSheets(await fetchCharacterSheets(cid));
                    setSheetMsg("生成完成,可点「采用为参考图」");
                    await load();
                    break;
                }
            }
        } catch (e) {
            setSheetError(e instanceof Error ? e.message : "设定卡生成失败");
        } finally {
            setRegenStyle(null);
        }
    }, [load]);

    // ---- S3-a: 管线C(c_hybrid 妆容链)一键启动 ----
    const [chainBusy, setChainBusy] = useState(false);
    const [chainMsg, setChainMsg] = useState<string | null>(null);
    const startCChain = useCallback(async () => {
        if (!detail) return;
        setChainBusy(true);
        setChainMsg(null);
        try {
            const body = buildMakeupCChainFromDrama(detail, { num_candidates: 2, auto_assemble: true });
            const ack = await createCChain(body);
            setChainMsg(`管线C 已提交(作业 ${String(ack.job_id).slice(0, 8)}…)→ 任务中心跟踪`);
        } catch (e) {
            setChainMsg(e instanceof Error ? e.message : "管线C 提交失败");
        } finally {
            setChainBusy(false);
        }
    }, [detail]);

    // 设定卡分格(无分格则整卡)采用为 ref2va 定妆参考图(正/侧/全身约定取前三格)
    const [adopting, setAdopting] = useState<string | null>(null);
    const adoptSheet = useCallback(async (cid: string, style: string, urls: string[]) => {
        const picked = urls.filter(Boolean).slice(0, 8);
        if (picked.length === 0) return;
        setAdopting(style);
        setSheetError(null);
        try {
            await adoptSheetAsReference(cid, style, picked);
            setSheetChar((prev) => (prev ? { ...prev, reference_images: picked } : prev));
            await load();
        } catch (e) {
            setSheetError(e instanceof Error ? e.message : "参考图写入失败");
        } finally {
            setAdopting(null);
        }
    }, [load]);

    // ---- S6: 共享资产库(跨项目 DramaAsset,只读+选用) ----
    const [sharedAssets, setSharedAssets] = useState<ToivSharedAsset[]>([]);
    const [sharedLoading, setSharedLoading] = useState(false);
    const [applyingAsset, setApplyingAsset] = useState<string | null>(null);
    const [assetMsg, setAssetMsg] = useState<string | null>(null);
    const [assetError, setAssetError] = useState<string | null>(null);

    const loadShared = useCallback(async () => {
        setSharedLoading(true);
        try {
            setSharedAssets(await fetchSharedAssets("character"));
        } catch {
            setSharedAssets([]);
        } finally {
            setSharedLoading(false);
        }
    }, []);

    useEffect(() => {
        if (section === "assets") void loadShared();
    }, [section, loadShared]);

    const runApplyAsset = useCallback(async (aid: string, name?: string) => {
        if (!id) return;
        setApplyingAsset(aid);
        setAssetMsg(null);
        setAssetError(null);
        try {
            await applySharedAsset(aid, id);
            await load();
            setAssetMsg(`已选用「${name ?? "资产"}」为项目角色`);
        } catch (e) {
            setAssetError(e instanceof Error ? e.message : "选用失败");
        } finally {
            setApplyingAsset(null);
        }
    }, [id, load]);

    // ---- W1.4: 镜头段生成操作(渲染/配音/整批) ----
    const [busyShots, setBusyShots] = useState<Set<string>>(new Set());
    const [batchRendering, setBatchRendering] = useState(false);
    const [renderError, setRenderError] = useState<string | null>(null);
    const markBusy = (sid: string, on: boolean) =>
        setBusyShots((prev) => {
            const n = new Set(prev);
            if (on) n.add(sid); else n.delete(sid);
            return n;
        });
    const RENDERED_STATES = new Set(["rendering", "rendered", "voiced", "lipsynced", "done"]);
    // S4-b:异步提交(wait=false)+轮询镜状态——reload/断连不再僵死,离开页面也无碍
    const [renderMsg, setRenderMsg] = useState<string | null>(null);
    // ---- 任务 #24:显式加速档(产品默认满血 off;选项来自 /api/acceleration/tiers h3 族) ----
    const [accelTiers, setAccelTiers] = useState<ToivAccelTier[]>([OFF_ACCEL_TIER]);
    const [accelLevel, setAccelLevel] = useState<string>("off");
    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const tiers = await fetchAccelTiers("h3");
                if (alive) setAccelTiers(tiers.length > 0 ? tiers : [OFF_ACCEL_TIER]);
            } catch {
                if (alive) setAccelTiers([OFF_ACCEL_TIER]);
            }
        })();
        return () => { alive = false; };
    }, []);
    const selectedAccelTier = accelTiers.find((t) => t.level === accelLevel) ?? OFF_ACCEL_TIER;
    const runShotRender = useCallback(async (sid: string) => {
        markBusy(sid, true);
        setRenderError(null);
        setRenderMsg(null);
        try {
            const { job_id } = await renderShotAsync(sid, { num_candidates: 2, accel: accelLevel });
            setRenderMsg(`渲染已入后台(作业 ${job_id.slice(0, 8)}…,双候选约 10-20 分钟;可离开本页,任务中心可见)`);
            for (let i = 0; i < 240 && !pollStop.current; i++) {
                await new Promise((r) => setTimeout(r, 10000));
                const d = await fetchDramaProject(id!);
                const st = (d.shots ?? []).find((x) => x.id === sid)?.status;
                if (st && !["queued", "rendering"].includes(st)) {
                    await load();
                    setRenderMsg("渲染完成");
                    break;
                }
            }
        } catch (e) {
            setRenderError(e instanceof Error ? e.message : "渲染失败");
        } finally {
            markBusy(sid, false);
        }
    }, [id, load, accelLevel]);

    // ---- S9 正式: 时间线排序/时长编辑(PUT shots 全量保存契约) ----
    const [tlOrder, setTlOrder] = useState<string[]>([]);          // shot id 顺序
    const [tlDuration, setTlDuration] = useState<Record<string, number>>({}); // id→秒
    const [tlSeam, setTlSeam] = useState<Record<string, string>>({}); // id→seam_to_next(W2.5)
    const [tlDirty, setTlDirty] = useState(false);
    const [tlSaving, setTlSaving] = useState(false);
    const [tlMsg, setTlMsg] = useState<string | null>(null);
    const [tlError, setTlError] = useState<string | null>(null);

    useEffect(() => {
        // detail 刷新同步本地编辑态(未脏时)
        if (!tlDirty && shots.length > 0) {
            setTlOrder(shots.map((x) => x.id));
            setTlDuration(Object.fromEntries(shots.map((x) => [x.id, x.duration_sec ?? 6])));
            setTlSeam(Object.fromEntries(shots.map((x) => [x.id, x.seam_to_next || "hardcut"])));
        }
    }, [shots, tlDirty]);

    const tlShots = useMemo(
        () => (tlOrder.length ? tlOrder.map((sid) => shots.find((x) => x.id === sid)).filter(Boolean) : shots) as typeof shots,
        [tlOrder, shots],
    );

    const tlMove = (sid: string, dir: -1 | 1) => {
        setTlDirty(true);
        setTlOrder((prev) => {
            const cur = prev.length ? prev : shots.map((x) => x.id);
            const i = cur.indexOf(sid);
            const j = i + dir;
            if (i < 0 || j < 0 || j >= cur.length) return cur;
            const n = [...cur];
            [n[i], n[j]] = [n[j], n[i]];
            return n;
        });
    };

    const tlSetDuration = (sid: string, v: number) => {
        setTlDirty(true);
        setTlDuration((p) => ({ ...p, [sid]: Math.max(1, Math.min(60, v)) }));
    };

    const tlSave = useCallback(async () => {
        if (!id) return;
        setTlSaving(true);
        setTlMsg(null);
        setTlError(null);
        try {
            const payload = tlShots.map((x) => ({
                id: x.id,
                scene: x.scene ?? "",
                prompt: x.prompt ?? "",
                camera: x.camera ?? "",
                dialogue: x.dialogue ?? "",
                speaker: x.speaker ?? "",
                duration_sec: tlDuration[x.id] ?? x.duration_sec ?? 6,
                characters: (x.characters ?? []) as string[],
                render_mode: x.render_mode ?? "video",
                seam_to_next: tlSeam[x.id] ?? x.seam_to_next ?? "hardcut", // W2.5:衔接持久化
            }));
            await saveStudioShots(id, payload);
            setTlDirty(false);
            await load();
            setTlMsg("排序与时长已保存(重排后新顺序即合成顺序)");
        } catch (e) {
            setTlError(e instanceof Error ? e.message : "保存失败");
        } finally {
            setTlSaving(false);
        }
    }, [id, tlShots, tlDuration, tlSeam, load]);

    // ---- W2.2: 多视角分镜扩展(配景) ----
    const [frameBusy, setFrameBusy] = useState<Set<string>>(new Set());
    const [frameVariants, setFrameVariants] = useState<Record<string, ToivFrameVariant[]>>({});
    const [frameError, setFrameError] = useState<string | null>(null);
    const runFrameVariants = useCallback(async (sid: string) => {
        setFrameBusy((p) => new Set(p).add(sid));
        setFrameError(null);
        try {
            const { job_id } = await submitFrameVariants(sid);
            for (let i = 0; i < 120 && !pollStop.current; i++) {
                await new Promise((r) => setTimeout(r, 3000));
                const r = await pollFrameVariants(sid, job_id);
                if (r.status === "error") throw new Error(r.error || "配景生成失败");
                if (r.status === "done" && r.variants) {
                    setFrameVariants((p) => ({ ...p, [sid]: r.variants ?? [] }));
                    break;
                }
            }
        } catch (e) {
            setFrameError(e instanceof Error ? e.message : "配景生成失败");
        } finally {
            setFrameBusy((p) => { const n = new Set(p); n.delete(sid); return n; });
        }
    }, []);

    // ---- S9-lite: 成片合成 ----
    const [assembling, setAssembling] = useState(false);
    const [assembleMsg, setAssembleMsg] = useState<string | null>(null);
    const [assembleError, setAssembleError] = useState<string | null>(null);
    const runAssemble = useCallback(async () => {
        if (!id) return;
        setAssembling(true);
        setAssembleError(null);
        setAssembleMsg(null);
        try {
            await assembleStudioProject(id);
            await load();
            setAssembleMsg("成片合成完成,见「成片」段");
        } catch (e) {
            setAssembleError(e instanceof Error ? e.message : "成片合成失败");
        } finally {
            setAssembling(false);
        }
    }, [id, load]);

    // ---- S9: 字幕对齐(台词↔whisper,SRT 双出) ----
    const [subsBusy, setSubsBusy] = useState<"build" | "burn" | null>(null);
    const [subsMsg, setSubsMsg] = useState<string | null>(null);
    const [subsError, setSubsError] = useState<string | null>(null);
    const runSubtitles = useCallback(async (mode: "build" | "burn") => {
        if (!id) return;
        setSubsBusy(mode);
        setSubsMsg(null);
        setSubsError(null);
        try {
            if (mode === "build") {
                const r = await buildSubtitles(id);
                setSubsMsg(`SRT 生成:覆盖 ${r.shots_covered} 个配音镜 / ${r.cues.length} 条 / 全长 ${r.total_duration}s → ${r.srt_url.split("/").pop()}`);
            } else {
                const r = await burnSubtitles(id);
                setSubsMsg(`字幕已内嵌 → ${r.video_url.split("/").pop()}(覆盖 ${r.shots_covered} 镜)`);
            }
        } catch (e) {
            setSubsError(e instanceof Error ? e.message : "字幕操作失败");
        } finally {
            setSubsBusy(null);
        }
    }, [id]);

    // S4:候选选用
    const [pickingCand, setPickingCand] = useState<string | null>(null);
    const runPick = useCallback(async (sid: string, cid: string) => {
        setPickingCand(cid);
        setRenderError(null);
        try {
            await pickShotCandidate(sid, cid);
            await load();
        } catch (e) {
            setRenderError(e instanceof Error ? e.message : "选用候选失败");
        } finally {
            setPickingCand(null);
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
    // ---- S11: 对口型(voiced 镜:LatentSync 产物覆盖 final_clip) ----
    const [lipsyncBusy, setLipsyncBusy] = useState<Set<string>>(new Set());
    const [lipsyncMsg, setLipsyncMsg] = useState<string | null>(null);
    const runLipsync = useCallback(async (sid: string) => {
        setLipsyncBusy((p) => new Set(p).add(sid));
        setLipsyncMsg(null);
        try {
            await lipsyncShotStrict(sid);
            await load();
            setLipsyncMsg("对口型完成(final_clip 已更新)");
        } catch (e) {
            setRenderError(e instanceof Error ? e.message : "对口型失败");
        } finally {
            setLipsyncBusy((p) => { const n = new Set(p); n.delete(sid); return n; });
        }
    }, [load]);

    // ---- FU1-b:hypit SVML 词锚定脚本导入(确定性拆镜,不经 LLM) ----
    const [svmlOpen, setSvmlOpen] = useState(false);
    const [svmlText, setSvmlText] = useState("");
    const [svmlBusy, setSvmlBusy] = useState(false);
    const [svmlMsg, setSvmlMsg] = useState<string | null>(null);
    const [svmlErr, setSvmlErr] = useState<string | null>(null);
    const runSvmlImport = useCallback(async () => {
        if (!id || svmlBusy) return;
        setSvmlBusy(true);
        setSvmlErr(null);
        setSvmlMsg(null);
        try {
            const script = svmlText.trim();
            if (!script) throw new Error("脚本文本为空");
            const r = await importSvmlStudio(id, script);
            setSvmlMsg(`解析出 ${r.count} 镜 / ${r.characters.length} 角色,正在落库…`);
            // 复用 AI 拆解同一落库链:新角色入库 → PUT shots 全量替换
            const existing = new Set((detail?.characters ?? []).map((c) => (c.name || "").trim()));
            for (const name of r.characters) {
                const n = (name || "").trim();
                if (n && !existing.has(n)) {
                    await createStudioCharacter(id, { name: n });
                    existing.add(n);
                }
            }
            await saveStudioShots(id, r.shots);
            await load();
            setSvmlMsg(`已导入 ${r.count} 镜(词锚定估时),已跳转分镜表`);
            setSvmlOpen(false);
            setSvmlText("");
            goSection("storyboard");
        } catch (e) {
            let msg = e instanceof Error ? e.message : "导入失败";
            // api 未部署窗口(404)给可行动文案,避免裸 Not Found
            const status = (e as { response?: { status?: number } })?.response?.status;
            if (status === 404) msg = "后端尚未更新(SVML 端点随下一批 api 部署生效)";
            else if (status === 422) msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || msg;
            setSvmlErr(msg.includes("SVML") || status === 404 ? msg : `导入失败:${msg}`);
            setSvmlMsg(null);
        } finally {
            setSvmlBusy(false);
        }
    }, [id, svmlBusy, svmlText, detail?.characters, load, goSection]);

    const runBatchRender = useCallback(async () => {
        if (!id) return;
        setBatchRendering(true);
        try {
            await triggerBatchRender(id, accelLevel);
            await load();
        } finally {
            setBatchRendering(false);
        }
    }, [id, load, accelLevel]);

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
                                    <ToolButton
                                        variant="default"
                                        icon={<FileText />}
                                        label="导入词锚定脚本"
                                        onClick={() => setSvmlOpen((v) => !v)}
                                    />
                                    <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                        已有 {shots.length} 镜 · 拆解/导入均为全量替换(旧分镜会被覆盖)
                                    </span>
                                </div>
                                {svmlOpen && (
                                    <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
                                        <textarea
                                            value={svmlText}
                                            onChange={(e) => setSvmlText(e.target.value)}
                                            rows={8}
                                            placeholder={"词锚定脚本(hypit SVML 语法):\n[scene:雨夜巷口][mood:紧张]\n<林夏> 别跟着我。||我说了,@{回头}猛地回头@{/回头}别跟着我。\n镜头缓推 || 霓虹闪烁\n---\n(空行或 --- 分镜;|| 分拍;@{锚}词@{/锚} 词级锚点;时长按字数自动估算)"}
                                            className="w-full resize-y rounded-lg border border-[var(--border)] bg-transparent p-3 font-mono text-xs leading-5 text-foreground outline-none focus:border-[var(--workspace-accent,#666)]"
                                            aria-label="词锚定脚本文本"
                                        />
                                        <div className="flex items-center gap-2">
                                            <ToolButton
                                                variant="default"
                                                icon={<Sparkles />}
                                                label={svmlBusy ? "解析导入中…" : "解析并导入分镜"}
                                                onClick={() => void runSvmlImport()}
                                                loading={svmlBusy}
                                            />
                                            <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                                确定性解析不经 LLM · 台词字数自动估时(2–15s)
                                            </span>
                                        </div>
                                        {svmlMsg && (
                                            <p className="flex items-center gap-1.5 text-xs text-foreground">
                                                {svmlBusy && <Loader2 className="size-3 animate-spin" aria-hidden />}
                                                {svmlMsg}
                                            </p>
                                        )}
                                        {svmlErr && <p className="text-xs text-[var(--danger,#e5484d)]">{svmlErr}</p>}
                                    </div>
                                )}
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
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="text-sm font-medium text-foreground">{c.name || "未命名"}</span>
                                                    {(c.reference_images?.length ?? 0) > 0 && (
                                                        <StatusBadge variant="filled" tone="success" label={`参考图 ${c.reference_images?.length}`} size="sm" />
                                                    )}
                                                </div>
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
                                <div className="mt-3 flex flex-col gap-2 rounded-lg border border-dashed border-[var(--border)] p-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-xs font-medium text-foreground">全局主体库（跨项目角色 · {sharedAssets.length}）</span>
                                        <ToolButton size="xs" variant="ghost" icon={<RefreshCw />} label="刷新" loading={sharedLoading} onClick={() => void loadShared()} />
                                    </div>
                                    {assetMsg && <p className="text-xs text-foreground">{assetMsg}</p>}
                                    {assetError && <p className="text-xs text-[var(--danger,#e5484d)]">{assetError}</p>}
                                    {sharedAssets.length === 0 ? (
                                        <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">暂无全局主体(在经典端「资源中心-主体库」创建后跨项目复用)</p>
                                    ) : (
                                        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
                                            {sharedAssets.map((a) => {
                                                const already = characters.some((c) => (c.name || "").trim() === (a.name || "").trim());
                                                return (
                                                    <div key={a.id} className="flex flex-col gap-1 rounded-lg border border-[var(--border)] p-2.5">
                                                        <span className="truncate text-xs font-medium text-foreground">{a.name || "未命名"}</span>
                                                        <span className="line-clamp-2 text-[11px] text-[var(--muted-foreground,#a8a8a8)]">{a.description || a.visual_prompt || "无描述"}</span>
                                                        <ToolButton
                                                            size="xs"
                                                            variant={already ? "ghost" : "default"}
                                                            icon={<Check />}
                                                            label={already ? "已在项目" : applyingAsset === a.id ? "选用中…" : "选用到项目"}
                                                            disabled={already}
                                                            loading={applyingAsset === a.id}
                                                            onClick={() => void runApplyAsset(a.id, a.name)}
                                                        />
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </SectionShell>
                        )}
                        {section === "storyboard" && (
                            <SectionShell title="分镜表" batch="S5">
                                {shots.length === 0 ? (
                                    <EmptyState description="暂无分镜(剧本→自动分镜 S5 落地)" />
                                ) : (
                                    <>
                                    {frameError && (
                                        <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-[var(--danger,#e5484d)]">{frameError}</p>
                                    )}
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left text-xs">
                                            <thead className="text-[var(--muted-foreground,#a8a8a8)]">
                                                <tr>
                                                    <th className="px-2 py-1.5">#</th>
                                                    <th className="px-2 py-1.5">场景</th>
                                                    <th className="px-2 py-1.5">台词</th>
                                                    <th className="px-2 py-1.5">时长</th>
                                                    <th className="px-2 py-1.5">衔接</th>
                                                    <th className="px-2 py-1.5">状态</th>
                                                    <th className="px-2 py-1.5">配景</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {shots.map((s) => (
                                                    <tr key={s.id} className="border-t border-[var(--border)]">
                                                        <td className="px-2 py-1.5 tabular-nums">{s.idx}</td>
                                                        <td className="max-w-72 truncate px-2 py-1.5">{s.scene || "—"}</td>
                                                        <td className="max-w-72 truncate px-2 py-1.5">{s.dialogue || "—"}</td>
                                                        <td className="px-2 py-1.5 tabular-nums">{s.duration_sec ?? "—"}s</td>
                                                        <td className="px-2 py-1.5">{s.seam_to_next || "hardcut"}{s.seam_anchor ? `·${s.seam_anchor}` : ""}</td>
                                                        <td className="px-2 py-1.5">
                                                            <StatusBadge variant="filled" tone={STATUS_TONE[s.status] ?? "neutral"} label={s.status} size="sm" />
                                                        </td>
                                                        <td className="px-2 py-1.5">
                                                            <div className="flex items-center gap-1">
                                                                <ToolButton
                                                                    size="xs"
                                                                    variant="ghost"
                                                                    icon={<Camera />}
                                                                    label={frameBusy.has(s.id) ? "配景中…" : "AI 配景"}
                                                                    loading={frameBusy.has(s.id)}
                                                                    onClick={() => void runFrameVariants(s.id)}
                                                                />
                                                                {(frameVariants[s.id] ?? []).map((v) => (
                                                                    <img key={v.scale} src={v.url} alt={v.scale} title={v.scale} className="h-10 w-16 rounded border border-[var(--border)] object-cover" loading="lazy" />
                                                                ))}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    </>
                                )}
                            </SectionShell>
                        )}
                        {section === "shots" && (
                            <SectionShell title="镜头（生成状态）" batch="S3/S4">
                                {shots.length === 0 ? (
                                    <EmptyState description="暂无镜头(先在剧本段 AI 拆解)" />
                                ) : (
                                    <>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <ToolButton
                                                variant="default"
                                                icon={<PlayCircle />}
                                                label={batchRendering ? "整批渲染中…" : "整批渲染(全部未完成镜)"}
                                                onClick={() => void runBatchRender()}
                                                loading={batchRendering}
                                            />
                                            <ToolButton
                                                variant="default"
                                                icon={<Clapperboard />}
                                                label={chainBusy ? "管线C 提交中…" : "启动管线C(连续妆容链)"}
                                                onClick={() => void startCChain()}
                                                loading={chainBusy}
                                            />
                                            <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                                加速档
                                                <Select
                                                    size="small"
                                                    value={accelLevel}
                                                    onChange={(v) => setAccelLevel(v)}
                                                    style={{ minWidth: 220 }}
                                                    aria-label="加速档"
                                                    options={accelTiers.map((t) => ({
                                                        value: t.level,
                                                        label: formatAccelTierLabel(t),
                                                    }))}
                                                />
                                            </label>
                                            <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                                单镜/整批走 H3 ref2va(需角色定妆参考图);管线C 为 c_hybrid 连续生成,作业进任务中心
                                            </span>
                                        </div>
                                        <p className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                            {formatAccelTierNote(selectedAccelTier) || "满血档:原生采样,质量优先(产品默认)。"}
                                        </p>
                                        {chainMsg && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{chainMsg}</p>
                                        )}
                                        {renderError && (
                                            <p className="rounded-lg border border-[var(--border)] bg-[var(--muted,rgba(255,255,255,0.05))] p-2.5 text-xs text-[var(--danger,#e5484d)]">
                                                {renderError}
                                            </p>
                                        )}
                                        {renderMsg && (
                                            <p className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">
                                                <Loader2 className="size-3 animate-spin" aria-hidden />
                                                {renderMsg}
                                            </p>
                                        )}
                                        {lipsyncMsg && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{lipsyncMsg}</p>
                                        )}
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
                                                        {(s.candidates ?? []).filter((c) => c.url).length > 1 && (
                                                            <span className="flex items-center gap-1">
                                                                {(s.candidates ?? []).filter((c) => c.url).map((c) => (
                                                                    <span key={c.id} className="flex items-center gap-0.5">
                                                                        <video src={c.url} className="h-10 w-auto rounded border border-[var(--border)]" preload="metadata" muted />
                                                                        {c.is_picked ? (
                                                                            <StatusBadge variant="filled" tone="success" label="已选" size="sm" />
                                                                        ) : (
                                                                            <ToolButton
                                                                                size="xs"
                                                                                variant="ghost"
                                                                                icon={<Check />}
                                                                                label={pickingCand === c.id ? "选…" : "选为成片"}
                                                                                loading={pickingCand === c.id}
                                                                                onClick={() => void runPick(s.id, c.id)}
                                                                            />
                                                                        )}
                                                                    </span>
                                                                ))}
                                                            </span>
                                                        )}
                                                        {canVoice && (
                                                            <ToolButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<Volume2 />}
                                                                label={busy ? "配音中…" : "配音"}
                                                                onClick={() => void runShotVoice(s.id)}
                                                            />
                                                        )}
                                                        {s.voice_url && !["lipsyncing", "lipsynced"].includes(s.status) && (
                                                            <ToolButton
                                                                size="xs"
                                                                variant="ghost"
                                                                icon={<Mic />}
                                                                label={lipsyncBusy.has(s.id) ? "对口型中…" : "对口型"}
                                                                loading={lipsyncBusy.has(s.id)}
                                                                onClick={() => void runLipsync(s.id)}
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
                            <SectionShell title="时间线（汇编）" batch="S9-lite">
                                {shots.length === 0 ? (
                                    <EmptyState description="暂无分镜" />
                                ) : (
                                    <>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <ToolButton
                                                variant="default"
                                                icon={<Save />}
                                                label={tlSaving ? "保存中…" : tlDirty ? "保存排序与时长*" : "保存排序与时长"}
                                                onClick={() => void tlSave()}
                                                loading={tlSaving}
                                            />
                                            <ToolButton
                                                variant="default"
                                                icon={<Film />}
                                                label={assembling ? "合成中…" : "合成成片(拼接全部就绪镜)"}
                                                onClick={() => void runAssemble()}
                                                loading={assembling}
                                            />
                                            <ToolButton
                                                variant="default"
                                                icon={<Captions />}
                                                label={subsBusy === "build" ? "生成中…" : "生成字幕 SRT(外挂)"}
                                                onClick={() => void runSubtitles("build")}
                                                loading={subsBusy === "build"}
                                            />
                                            <ToolButton
                                                variant="default"
                                                icon={<Captions />}
                                                label={subsBusy === "burn" ? "内嵌中…" : "字幕内嵌视频"}
                                                onClick={() => void runSubtitles("burn")}
                                                loading={subsBusy === "burn"}
                                            />
                                            <span className="text-xs text-[var(--muted-foreground,#a8a8a8)]">
                                                就绪 {shots.filter((x) => x.final_clip_url).length}/{shots.length} 镜;配音镜 {shots.filter((x) => x.voice_url).length} 个(字幕源)
                                            </span>
                                        </div>
                                        {subsMsg && <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{subsMsg}</p>}
                                        {subsError && <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-[var(--danger,#e5484d)]">{subsError}</p>}
                                        {tlMsg && <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{tlMsg}</p>}
                                        {tlError && <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-[var(--danger,#e5484d)]">{tlError}</p>}
                                        {assembleError && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-[var(--danger,#e5484d)]">{assembleError}</p>
                                        )}
                                        {assembleMsg && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{assembleMsg}</p>
                                        )}
                                        <ol className="flex flex-col gap-1.5">
                                            {tlShots.map((x, i) => (
                                                <li key={x.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
                                                    <span className="flex flex-col gap-0.5">
                                                        <button type="button" aria-label={`上移 ${x.scene?.slice(0, 8) ?? x.id.slice(0, 6)}`} disabled={i === 0} onClick={() => tlMove(x.id, -1)} className="text-[var(--muted-foreground,#a8a8a8)] hover:text-foreground disabled:opacity-30"><ArrowUp className="size-3" /></button>
                                                        <button type="button" aria-label={`下移 ${x.scene?.slice(0, 8) ?? x.id.slice(0, 6)}`} disabled={i === tlShots.length - 1} onClick={() => tlMove(x.id, 1)} className="text-[var(--muted-foreground,#a8a8a8)] hover:text-foreground disabled:opacity-30"><ArrowDown className="size-3" /></button>
                                                    </span>
                                                    <span className="w-8 tabular-nums text-[var(--muted-foreground,#a8a8a8)]">{String(i + 1).padStart(2, "0")}</span>
                                                    <span className="min-w-0 flex-1 truncate">{x.scene || x.prompt || "—"}</span>
                                                    <label className="flex items-center gap-1 text-[var(--muted-foreground,#a8a8a8)]">
                                                        时长
                                                        <input
                                                            type="number" min={1} max={60} value={tlDuration[x.id] ?? x.duration_sec ?? 6}
                                                            onChange={(e) => tlSetDuration(x.id, Number(e.target.value) || 1)}
                                                            className="w-14 rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-xs tabular-nums text-foreground"
                                                            aria-label={`时长 ${x.scene?.slice(0, 8) ?? x.id.slice(0, 6)}`}
                                                        />s
                                                    </label>
                                                    <select
                                                        value={tlSeam[x.id] ?? x.seam_to_next ?? "hardcut"}
                                                        onChange={(e) => { setTlDirty(true); setTlSeam((p) => ({ ...p, [x.id]: e.target.value })); }}
                                                        className="rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-xs text-foreground"
                                                        aria-label={`衔接 ${x.scene?.slice(0, 6) ?? x.id.slice(0, 4)}`}
                                                        title="与下一镜的衔接:continue=末帧续写(渲染自动走 c 管线)"
                                                    >
                                                        <option value="hardcut">硬切</option>
                                                        <option value="continue">续写</option>
                                                        <option value="matchcut">匹配切</option>
                                                        <option value="overlap">重叠</option>
                                                    </select>
                                                    {x.final_clip_url
                                                        ? <StatusBadge variant="filled" tone="success" label="就绪" size="sm" />
                                                        : <StatusBadge variant="filled" tone={STATUS_TONE[x.status] ?? "neutral"} label={x.status} size="sm" />}
                                                </li>
                                            ))}
                                        </ol>
                                    </>
                                )}
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
                            {sheetMsg && (
                                <p className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">
                                    {regenStyle && <Loader2 className="size-3 animate-spin" aria-hidden />}
                                    {sheetMsg}
                                </p>
                            )}
                            {sheetsLoading ? (
                                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="加载中" />
                            ) : sheets.length === 0 ? (
                                <div className="flex flex-col gap-2">
                                    <EmptyState size="compact" description="暂无设定卡,选择风格生成(后台 Job,全程约 15-20 分钟)" />
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
                                                {sh.mtime ? ` · ${new Date(Number(sh.mtime) * 1000).toLocaleDateString("zh-CN")}` : ""}
                                            </span>
                                            <div className="flex items-center gap-1">
                                                <ToolButton
                                                    size="xs"
                                                    icon={<Check />}
                                                    label={adopting === sh.style ? "采用中…" : "采用为参考图"}
                                                    loading={adopting === sh.style}
                                                    onClick={() => {
                                                        const panels = sh.panel_urls ? Object.values(sh.panel_urls) : [];
                                                        void adoptSheet(sheetChar.id, sh.style, panels.length > 0 ? panels : [sh.sheet_url]);
                                                    }}
                                                />
                                                <ToolButton
                                                    size="xs"
                                                    icon={<RefreshCw />}
                                                    label="重生成"
                                                    loading={regenStyle === sh.style}
                                                    onClick={() => void regenSheet(sheetChar.id, sh.style)}
                                                />
                                            </div>
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

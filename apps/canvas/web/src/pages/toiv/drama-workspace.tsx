/**
 * v2 项目工作区骨架（S2/W1.1，2026-10-11）。
 *
 * 六段式：剧本 → 资产 → 分镜 → 镜头 → 时间线 → 成片（docs/ops/PLATFORM_V2_CONTRACT.md §1）。
 * 本页挂在独立路由 /toiv/ws/:id/:section（不动现役 /toiv/drama/:id，零回归——绞杀者纪律）；
 * S3/S4 逐段把经典端能力迁进来，迁移齐后 W1.2 末步做路由对调。
 * 现在各段为只读骨架：头部项目状态 + 各段已有数据的轻量呈现 + 落地批次的说明。
 */
import { ArrowDown, ArrowUp, BookOpen, Camera, Captions, Check, Clapperboard, Columns3, FileText, GitBranch, Film, IdCard, Layers, List, ListOrdered, Loader2, Mic, PlayCircle, RefreshCw, Save, ScrollText, Sparkles, Users, Volume2, X } from "lucide-react";
import { Select } from "antd";
import type { ToivFrameVariant, ToivSharedAsset } from "@/services/toiv/client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { TasksCenterLink } from "@/components/toiv/tasks-center-link";
import { Switch } from "@/components/ui/base/switch";
import { CREW_ASSIST_GATE_HINT, isCrewAssistMode, setCrewAssistMode } from "@/services/toiv/crew-assist-mode";
import {
    CREW_ONE_CLICK_EXPERT_HINT,
    CREW_ONE_CLICK_LABEL,
    CREW_ONE_CLICK_TITLE,
    CrewOneClickGateError,
    crewOneClickRunPath,
    startCrewOneClick,
} from "@/services/toiv/crew-one-click";
import {
    CHARACTER_STYLE_VARIANTS,
    EXTENDED_VARIANT_API_GAP,
    pendingSheetVariantOrders,
} from "@/services/toiv/character-style-variants";
import { ComputeStatusStrip, depBlocksCta } from "@/components/toiv/compute-status-strip";
import { ControlReadinessLamps } from "@/components/toiv/control-readiness-lamps";
import { BgmBedPanel } from "@/components/toiv/bgm-bed-panel";
import { JianyingExportButton } from "@/components/toiv/jianying-export-button";
import { KpiNorthboundPanel } from "@/components/toiv/kpi-northbound-panel";
import { projectControlReadinessLamps } from "@/services/toiv/control-readiness";
import {
    DEFAULT_STORYBOARD_DRIVE_MODE,
    KEYFRAME_DRIVE_BADGE,
    STORYBOARD_DRIVE_OPTIONS,
    defaultShotViewModeForDrive,
    normalizeStoryboardDriveMode,
    videoRenderGate,
    type StoryboardDriveMode,
} from "@/services/toiv/storyboard-drive";
import { studioQaHumanMessage, studioQaMessageWithHint } from "@/services/toiv/studio-qa-failure";
import { parseBgmFromProject, type BgmBedConfig } from "@/services/toiv/bgm-bed";
import { recordConsistencyRework, recordQueueWait, touchDramaWorkspace } from "@/services/toiv/product-kpi";
import { formatClientTimeoutMessage, isClientTimeoutError, isStillRunningMessage, userFacingCaughtError } from "@/services/toiv/client-timeout";
import { SheetGateJobError, sheetFailureFromCaughtError, sheetFailureFromJobResult, type SheetFailureView } from "@/services/toiv/sheet-gate-failure";
import { toivMediaUrl } from "@/services/toiv/cover-url";

import { ToolButton } from "@/components/ui/base/buttons";
import { WordAnchorTimeline } from "@/components/toiv/word-anchor-timeline";
import { SceneAnchorPanel } from "@/components/toiv/scene-anchor-panel";
import { WsCreationDock } from "@/components/toiv/ws-creation-dock";
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
    fetchCharacterAsset,
    type ToivCharacterAsset,
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
    skipLipsyncShot,
    burnSubtitles,
    fetchSharedAssets,
    pollFrameVariants,
    adoptShotKeyframe,
    keepRejectedSheet,
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
    type ToivRenderPipeline,
    type ToivDepItem,
} from "@/services/toiv/client";
import {
    DRAMA_BOARD_COLUMNS,
    DRAMA_PIPELINE_STAGES,
    dramaPipelineCellLabel,
    groupShotsByBoardColumn,
    toDramaPipelineRows,
    toDramaShotProjection,
    type DramaShotViewMode,
} from "@/pages/toiv/drama-shot-board";

const SECTIONS = [
    { key: "script", label: "剧本", icon: BookOpen, batch: "S3" },
    { key: "assets", label: "资产/定妆", icon: Users, batch: "S3" },
    { key: "storyboard", label: "分镜准备", icon: ListOrdered, batch: "S5" },
    { key: "shots", label: "生成·配音·口型", icon: Clapperboard, batch: "S3/S4" },
    { key: "timeline", label: "时间线", icon: Layers, batch: "S9" },
    { key: "final", label: "合成", icon: Film, batch: "S9" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

function normalizeSection(raw: string | undefined): SectionKey {
    return (SECTIONS.find((s) => s.key === raw)?.key ?? "script") as SectionKey;
}

/** Wave P2 阶段轨叙事(与 next_step / section 对齐;prepared≠generating) */
const STAGE_RAIL: { key: string; label: string; sections: SectionKey[]; steps: string[] }[] = [
    { key: "script", label: "剧本", sections: ["script"], steps: [] },
    { key: "assets", label: "定妆", sections: ["assets"], steps: [] },
    { key: "storyboard", label: "分镜", sections: ["storyboard"], steps: ["render"] },
    { key: "generate", label: "生成", sections: ["shots"], steps: ["render"] },
    { key: "voice", label: "配音", sections: ["shots"], steps: ["voice"] },
    { key: "lipsync", label: "口型", sections: ["shots"], steps: ["lipsync"] },
    { key: "assemble", label: "合成", sections: ["timeline", "final"], steps: ["assemble", "done"] },
];

const PIPELINE_OPTIONS: { value: ToivRenderPipeline; label: string; note: string; expert?: boolean }[] = [
    { value: "ref2va", label: "参考生视频（推荐）", note: "H3 Ref2VA 默认主路" },
    { value: "c", label: "续写管线 C", note: "专家：连续续写", expert: true },
    { value: "c_hybrid", label: "混合 C", note: "专家：妆容链/混合", expert: true },
];

function shotHasDialogue(dialogue?: string | null): boolean {
    return Boolean((dialogue ?? "").trim());
}

function characterHasMakeup(c: ToivDramaCharacter): boolean {
    if ((c.reference_images?.length ?? 0) > 0) return true;
    const byStyle = c.reference_images_by_style ?? {};
    return Object.values(byStyle).some((urls) => (urls?.length ?? 0) > 0);
}

const STATUS_TONE: Record<string, "success" | "warning" | "error" | "neutral"> = {
    done: "success",
    ready: "success",
    prepared: "success",
    rendered: "success",
    voiced: "success",
    lipsynced: "success",
    generating: "warning",
    rendering: "warning",
    queued: "warning",
    storyboard: "warning",
    error: "error",
    failed: "error",
    draft: "neutral",
    pending: "neutral",
    canceled: "neutral",
    cancelled: "neutral",
};

/** Wave P1: 镜头/项目状态展示层中文，禁止裸英文枚举 */
const STATUS_LABEL: Record<string, string> = {
    draft: "草稿",
    ready: "已就绪",
    prepared: "已就绪",
    queued: "排队中",
    rendering: "生成中",
    generating: "生成中",
    storyboard: "分镜中",
    rendered: "已出视频",
    voiced: "已配音",
    lipsynced: "已对口型",
    done: "已完成",
    error: "失败",
    failed: "失败",
    canceled: "已取消",
    cancelled: "已取消",
    pending: "待处理",
};

function statusLabelZh(status?: string | null): string {
    const key = String(status ?? "").trim();
    if (!key) return "未知";
    return STATUS_LABEL[key] ?? key;
}

function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
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
        if (p.next_step) {
            parts.push(`下一步「${p.next_step.label}」×${p.next_step.todo}`);
        }
    }
    if (project.width && project.height) parts.push(`${project.width}×${project.height}@${project.fps ?? "?"}fps`);
    return <p className="text-xs text-[var(--muted-foreground)]">{parts.join(" · ") || "暂无管线数据"}</p>;
}

function StageRail({ section, nextStep }: { section: SectionKey; nextStep?: string }) {
    const step = nextStep || "";
    return (
        <ol className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--muted)]/30 px-2 py-1.5" aria-label="短剧阶段轨">
            {STAGE_RAIL.map((st, i) => {
                const onSection = st.sections.includes(section);
                const isNext = st.steps.includes(step) || (step === "done" && st.key === "assemble");
                const tone = isNext
                    ? "bg-[var(--workspace-accent)]/15 text-foreground ring-1 ring-[var(--workspace-accent)]/40"
                    : onSection
                      ? "bg-[var(--surface-active)] text-foreground"
                      : "text-[var(--muted-foreground)]";
                return (
                    <li key={st.key} className="flex items-center gap-1">
                        {i > 0 ? <span className="text-[10px] text-[var(--muted-foreground)]" aria-hidden>→</span> : null}
                        <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${tone}`}>
                            {st.label}
                            {isNext ? <span className="ml-1 font-normal opacity-80">当前</span> : null}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

export default function DramaWorkspacePage({ projectIdOverride }: { projectIdOverride?: string } = {}) {
    const params = useParams<{ id: string }>();
    const id = (projectIdOverride || params.id || "").trim() || undefined;
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const section = normalizeSection(searchParams.get("section") ?? undefined);
    const focusShotId = (searchParams.get("shot") || "").trim();

    /** Wave P3 / D2-A：列表↔看板投影；选中态跨视图保持 */
    const [shotViewMode, setShotViewMode] = useState<DramaShotViewMode>("pipeline");
    const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
    /** F1：关键帧驱动默认；与 preferred_drive_mode 同步 */
    const [driveMode, setDriveMode] = useState<StoryboardDriveMode>(DEFAULT_STORYBOARD_DRIVE_MODE);
    const [driveHydrated, setDriveHydrated] = useState(false);

    /** D5-A 剧组协助：默认关；按项目 localStorage；开启后露 F2 专家一键（不 auto-approve） */
    const [crewAssist, setCrewAssist] = useState(false);
    useEffect(() => {
        setCrewAssist(isCrewAssistMode(id));
    }, [id]);
    const toggleCrewAssist = (on: boolean) => {
        setCrewAssist(on);
        setCrewAssistMode(on, id);
    };

    /** F3：声床配置（与项目 bgm_* 同步） */
    const [bgmBed, setBgmBed] = useState<BgmBedConfig>(() => parseBgmFromProject(null));

    const [detail, setDetail] = useState<ToivDramaDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    /** F2：专家一键成片（仅剧组协助 ON；建 run 不 auto-approve） */
    const [oneClickBusy, setOneClickBusy] = useState(false);
    const [oneClickMsg, setOneClickMsg] = useState<string | null>(null);
    const startOneClick = useCallback(async () => {
        if (!id || !detail) return;
        setOneClickBusy(true);
        setOneClickMsg(null);
        try {
            const r = await startCrewOneClick({
                id,
                title: detail.title,
                premise: detail.premise,
                style: detail.style,
                preferred_pipeline: detail.preferred_pipeline,
            });
            setOneClickMsg(r.ack || "已建计划，请在详情页确认人闸");
            navigate(crewOneClickRunPath(r.runId));
        } catch (e) {
            const msg =
                e instanceof CrewOneClickGateError
                    ? e.message
                    : userFacingCaughtError(e) || "一键成片失败";
            setOneClickMsg(msg);
        } finally {
            setOneClickBusy(false);
        }
    }, [id, detail, navigate]);

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

    const goSection = (key: SectionKey) => {
        if (!id) return;
        const next = new URLSearchParams(searchParams);
        next.set("project", id);
        next.set("section", key);
        navigate(`/create?${next.toString()}`, { replace: true });
    };
    const shots = detail?.shots ?? [];
    const characters = detail?.characters ?? [];

    useEffect(() => {
        if (!focusShotId) return;
        setSelectedShotId(focusShotId);
        if (loading) return;
        const t = window.setTimeout(() => {
            document.getElementById(`shot-${focusShotId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
        return () => window.clearTimeout(t);
    }, [focusShotId, loading, section, shots.length]);

    const selectedShot = useMemo(
        () => (selectedShotId ? shots.find((s) => s.id === selectedShotId) ?? null : null),
        [selectedShotId, shots],
    );
    const boardGroups = useMemo(() => groupShotsByBoardColumn(shots), [shots]);

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
    const [sheetFailure, setSheetFailure] = useState<SheetFailureView | null>(null);
    const [softKeepBusy, setSoftKeepBusy] = useState(false);
    const [sheetMsg, setSheetMsg] = useState<string | null>(null);
    const [lastSheetStyle, setLastSheetStyle] = useState<string>("anime");
    /** L2 style_variants 登记（只读展示）；下单走设定卡 async */
    const [characterAsset, setCharacterAsset] = useState<ToivCharacterAsset | null>(null);

    const openSheets = useCallback(async (c: ToivDramaCharacter) => {
        setSheetChar(c);
        setSheets([]);
        setCharacterAsset(null);
        setSheetError(null);
        setSheetFailure(null);
        setSheetMsg(null);
        setSheetsLoading(true);
        try {
            const [listed, asset] = await Promise.all([
                fetchCharacterSheets(c.id),
                fetchCharacterAsset(c.id, "anime").catch(() => null),
            ]);
            setSheets(listed);
            setCharacterAsset(asset);
        } catch {
            setSheets([]);
        } finally {
            setSheetsLoading(false);
        }
    }, []);

    const regenSheet = useCallback(async (cid: string, style: string) => {
        setRegenStyle(style);
        setLastSheetStyle(style);
        setSheetError(null);
        setSheetFailure(null);
        setSheetMsg(null);
        try {
            const { job_id } = await submitSheetAsync(cid, style);
            setSheetMsg(`后台生成中(作业 ${job_id.slice(0, 8)}…,全程 15-20 分钟;可关抽屉稍后再看,任务中心可见)`);
            let sheetDone = false;
            for (let i = 0; i < 300 && !pollStop.current; i++) {
                await new Promise((r) => setTimeout(r, 5000));
                const r = await pollSheetJob(cid, job_id);
                if (r.status === "error") {
                    const view = sheetFailureFromJobResult({ ...r, status: "error", style: r.style || style }, style);
                    throw new SheetGateJobError(view);
                }
                if (r.status === "done") {
                    setSheets(await fetchCharacterSheets(cid));
                    setSheetMsg("生成完成,可点「采用为参考图」");
                    await load();
                    sheetDone = true;
                    break;
                }
            }
            // 前端轮询等到上限 ≠ Job 失败：作业可能仍在后台
            if (!sheetDone && !pollStop.current) {
                setSheetMsg(formatClientTimeoutMessage());
                setSheetError(null);
                setSheetFailure(null);
            }
        } catch (e) {
            if (isClientTimeoutError(e)) {
                setSheetMsg(formatClientTimeoutMessage());
                setSheetError(null);
                setSheetFailure(null);
            } else {
                const view = sheetFailureFromCaughtError(e, style);
                setSheetFailure(view);
                setSheetError(view.reasonZh);
                setSheetMsg(null);
            }
        } finally {
            setRegenStyle(null);
        }
    }, [load]);

    const softKeepRejected = useCallback(async () => {
        if (!sheetChar || !sheetFailure?.previewUrl) return;
        setSoftKeepBusy(true);
        setSheetError(null);
        try {
            void recordConsistencyRework(id, "keep_rejected_sheet");
            await keepRejectedSheet(sheetChar.id, {
                style: sheetFailure.style || lastSheetStyle || "anime",
                preview_url: sheetFailure.previewUrl,
                reason_zh: sheetFailure.reasonZh,
                technical_detail: sheetFailure.technicalDetail,
            });
            setSheets(await fetchCharacterSheets(sheetChar.id));
            setSheetMsg("已警告保留到工作区（未宣称质检通过）；可再生成或采用为参考图");
            setSheetFailure(null);
            setSheetError(null);
        } catch (e) {
            setSheetError(userFacingCaughtError(e, "警告保留失败"));
        } finally {
            setSoftKeepBusy(false);
        }
    }, [sheetChar, sheetFailure, lastSheetStyle, id]);

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
            setChainMsg(userFacingCaughtError(e, "管线C 提交失败"));
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
    // FU:Toonflow 门控确认——生成前展示数量/加速档,确认才推进(不是静默开火)
    const [gateOpen, setGateOpen] = useState(false);
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
    // Wave P2 / D7-A:管线选择器默认 ref2va;c / c_hybrid 为专家档；持久化到项目 preferred_pipeline
    const [renderPipeline, setRenderPipeline] = useState<ToivRenderPipeline>("ref2va");
    const [pipelineHydrated, setPipelineHydrated] = useState(false);
    useEffect(() => { setPipelineHydrated(false); setDriveHydrated(false); }, [id]);
    useEffect(() => {
        const pref = detail?.preferred_pipeline;
        if (!pref || pipelineHydrated) return;
        if (pref === "ref2va" || pref === "c" || pref === "c_hybrid") {
            setRenderPipeline(pref);
            setPipelineHydrated(true);
        }
    }, [detail?.preferred_pipeline, pipelineHydrated]);
    useEffect(() => {
        if (driveHydrated) return;
        const mode = normalizeStoryboardDriveMode(detail?.preferred_drive_mode ?? DEFAULT_STORYBOARD_DRIVE_MODE);
        setDriveMode(mode);
        setShotViewMode(defaultShotViewModeForDrive(mode));
        if (detail) setDriveHydrated(true);
    }, [detail, detail?.preferred_drive_mode, driveHydrated]);
    useEffect(() => {
        if (!detail) return;
        setBgmBed(parseBgmFromProject(detail));
    }, [detail?.id, detail?.bgm_url, detail?.bgm_volume, detail?.bgm_duck]);
    useEffect(() => {
        if (!id) return;
        void touchDramaWorkspace(id);
    }, [id]);
    const onPipelineChange = useCallback(async (v: ToivRenderPipeline) => {
        setRenderPipeline(v);
        if (!id) return;
        try {
            await patchStudioProject(id, { preferred_pipeline: v });
        } catch (e) {
            setRenderError(studioQaHumanMessage("generic", e, userFacingCaughtError(e, "管线偏好保存失败")));
        }
    }, [id]);
    const onDriveModeChange = useCallback(async (v: StoryboardDriveMode) => {
        setDriveMode(v);
        setShotViewMode(defaultShotViewModeForDrive(v));
        if (!id) return;
        try {
            await patchStudioProject(id, { preferred_drive_mode: v });
        } catch (e) {
            setRenderError(studioQaHumanMessage("generic", e, userFacingCaughtError(e, "分镜驱动偏好保存失败")));
        }
    }, [id]);
    const [deps, setDeps] = useState<ToivDepItem[]>([]);
    const voiceBlocked = depBlocksCta(deps, "tts");
    const videoBlocked = depBlocksCta(deps, "h3");
    const pipelineRows = useMemo(() => toDramaPipelineRows(shots, renderPipeline), [shots, renderPipeline]);
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
        const target = shots.find((x) => x.id === sid);
        const gate = videoRenderGate(target || {}, driveMode);
        if (!gate.allowed) {
            const msg = studioQaMessageWithHint(
                "keyframe",
                { code: gate.code, message: gate.hint },
                gate.hint,
            );
            setRenderError(msg);
            return;
        }
        markBusy(sid, true);
        setRenderError(null);
        setRenderMsg(null);
        try {
            const queueStarted = Date.now();
            const { job_id } = await renderShotAsync(sid, {
                num_candidates: 2,
                accel: accelLevel,
                pipeline: renderPipeline,
                force_direct: driveMode === "direct",
            });
            setRenderMsg(`渲染已入后台(作业 ${job_id.slice(0, 8)}…,双候选约 10-20 分钟;可离开本页,任务中心可见)`);
            for (let i = 0; i < 240 && !pollStop.current; i++) {
                await new Promise((r) => setTimeout(r, 10000));
                const d = await fetchDramaProject(id!);
                const st = (d.shots ?? []).find((x) => x.id === sid)?.status;
                if (st && !["queued", "rendering"].includes(st)) {
                    await load();
                    setRenderMsg("渲染完成");
                    void recordQueueWait(Date.now() - queueStarted, id);
                    break;
                }
            }
        } catch (e) {
            if (isClientTimeoutError(e)) {
                setRenderMsg(formatClientTimeoutMessage());
                setRenderError(null);
            } else {
                setRenderError(studioQaHumanMessage("render", e, userFacingCaughtError(e, "渲染失败")));
            }
        } finally {
            markBusy(sid, false);
        }
    }, [id, load, accelLevel, renderPipeline, driveMode, shots]);

    // ---- S9 正式: 时间线排序/时长编辑(PUT shots 全量保存契约) ----
    const [tlOrder, setTlOrder] = useState<string[]>([]);          // shot id 顺序
    const [tlDuration, setTlDuration] = useState<Record<string, number>>({}); // id→秒
    const [tlSeam, setTlSeam] = useState<Record<string, string>>({}); // id→seam_to_next(W2.5)
    const [tlDirty, setTlDirty] = useState(false);
    const [tlSaving, setTlSaving] = useState(false);
    const [tlMsg, setTlMsg] = useState<string | null>(null);
    const [tlError, setTlError] = useState<string | null>(null);
    const [beatEditing, setBeatEditing] = useState<Set<string>>(new Set());
    const onBeatEditingChange = useCallback((sid: string, editing: boolean) => {
        setBeatEditing((prev) => {
            if (prev.has(sid) === editing) return prev;
            const next = new Set(prev);
            if (editing) next.add(sid); else next.delete(sid);
            return next;
        });
    }, []);

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
        setTlDuration((p) => ({ ...p, [sid]: Math.max(3, Math.min(60, v)) }));
    };

    const tlSave = useCallback(async () => {
        if (!id || tlSaving || beatEditing.size > 0) return;
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
                beats: x.beats ?? [],
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
    }, [id, tlShots, tlDuration, tlSeam, load, tlSaving, beatEditing]);

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
            setFrameError(studioQaHumanMessage("keyframe", e, userFacingCaughtError(e, "配景生成失败")));
        } finally {
            setFrameBusy((p) => { const n = new Set(p); n.delete(sid); return n; });
        }
    }, []);
    const adoptFrameAsKeyframe = useCallback(async (sid: string, url: string) => {
        setFrameError(null);
        try {
            await adoptShotKeyframe(sid, url);
            await load();
            setRenderMsg("已采用关键帧；可在「生成」段开拍视频");
        } catch (e) {
            setFrameError(studioQaMessageWithHint("keyframe", e, userFacingCaughtError(e, "采用关键帧失败")));
        }
    }, [load]);

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
            setAssembleMsg("合成预览已完成，可到「合成」段看片；也可留在时间线继续调序。");
            goSection("final");
        } catch (e) {
            setAssembleError(studioQaHumanMessage("assemble", e, userFacingCaughtError(e, "成片合成失败")));
        } finally {
            setAssembling(false);
        }
    }, [id, load, goSection]);

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
            setSubsError(userFacingCaughtError(e, "字幕操作失败"));
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
            setRenderError(studioQaHumanMessage("pick", e, userFacingCaughtError(e, "选用候选失败")));
        } finally {
            setPickingCand(null);
        }
    }, [load]);
    const runShotVoice = useCallback(async (sid: string) => {
        markBusy(sid, true);
        setRenderError(null);
        try {
            await triggerShotVoice(sid);
            await load();
        } catch (e) {
            // 失败必须给反馈:此前异常直接吞成 unhandled rejection,点了配音毫无动静
            setRenderError(studioQaHumanMessage("voice", e, userFacingCaughtError(e, "配音失败")));
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
            setRenderError(studioQaHumanMessage("lipsync", e, userFacingCaughtError(e, "对口型失败")));
        } finally {
            setLipsyncBusy((p) => { const n = new Set(p); n.delete(sid); return n; });
        }
    }, [load]);
    const runSkipLipsync = useCallback(async (sid: string) => {
        const ok = window.confirm("跳过口型后，成片将标注「未对口型」，配音会直接叠到画面上。确定继续？");
        if (!ok) return;
        setLipsyncBusy((p) => new Set(p).add(sid));
        setLipsyncMsg(null);
        try {
            await skipLipsyncShot(sid);
            await load();
            setLipsyncMsg("已跳过口型（成片标「未对口型」）");
        } catch (e) {
            setRenderError(studioQaHumanMessage("lipsync_skip", e, userFacingCaughtError(e, "跳过口型失败")));
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
        const blocked = shots.filter((s) => !videoRenderGate(s, driveMode).allowed);
        if (blocked.length > 0) {
            setRenderError(
                studioQaMessageWithHint(
                    "keyframe",
                    { code: "KEYFRAME_REQUIRED", message: `${blocked.length} 镜缺关键帧` },
                    `关键帧驱动：还有 ${blocked.length} 镜未采用关键帧，请先在分镜「AI 配景」采用，或改为「直接出视频（专家）」。`,
                ),
            );
            return;
        }
        setBatchRendering(true);
        setRenderError(null);
        try {
            await triggerBatchRender(id, accelLevel, renderPipeline);
            await load();
        } catch (e) {
            // 失败必须给反馈:此前 try/finally 无 catch,整批渲染失败无任何提示
            setRenderError(studioQaHumanMessage("batch", e, userFacingCaughtError(e, "整批渲染提交失败，可在任务中心查看详情后重试")));
        } finally {
            setBatchRendering(false);
        }
    }, [id, load, accelLevel, renderPipeline, driveMode, shots]);

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
            if (!pollStop.current) throw new Error(formatClientTimeoutMessage());
        } catch (e) {
            setParseError(userFacingCaughtError(e, "拆解失败,请重试"));
            setParseMsg(null);
        } finally {
            setParsing(false);
        }
    }, [id, parsing, premiseText, numShots, detail, load, goSection]);

    const charactersWithMakeup = useMemo(
        () => characters.filter(characterHasMakeup),
        [characters],
    );
    const makeupReady = characters.length === 0 || charactersWithMakeup.length > 0;
    const makeupGateHint = makeupReady
        ? null
        : "请先完成定妆选角：至少为一名角色生成/锁定设定卡参考图后，才能批量生成视频。";
    const continueSeamCount = useMemo(
        () => shots.filter((s) => (s.seam_to_next || "") === "continue").length,
        [shots],
    );
    const pipelineNote = PIPELINE_OPTIONS.find((p) => p.value === renderPipeline)?.note ?? "";
    const controlLamps = useMemo(
        () =>
            projectControlReadinessLamps({
                shots,
                charactersWithMakeup: charactersWithMakeup.length,
                characterCount: characters.length,
                videoBlocked: videoBlocked.blocked,
            }),
        [shots, charactersWithMakeup.length, characters.length, videoBlocked.blocked],
    );

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
                                    label={statusLabelZh(detail.status)}
                                    size="sm"
                                />
                            )}
                        </div>
                        {detail && <StatusLine project={detail} />}
                        <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                            剧本 → 定妆 → 分镜 → 生成 → 配音 → 口型 → 合成（就绪≠生成中；无对白镜自动越过配音/口型）
                        </p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]" title="开启后露出专家一键成片；三点人闸与计划/合成确认门仍强制">
                            <span className="whitespace-nowrap">剧组协助</span>
                            <Switch
                                size="sm"
                                checked={crewAssist}
                                onChange={toggleCrewAssist}
                                aria-label="剧组协助"
                            />
                        </label>
                        {crewAssist && (
                            <div className="flex max-w-xs flex-col items-end gap-1.5" data-testid="crew-one-click-panel">
                                <p className="text-right text-[11px] leading-4 text-[var(--muted-foreground)]">
                                    {CREW_ONE_CLICK_EXPERT_HINT}
                                </p>
                                <ToolButton
                                    variant="default"
                                    icon={oneClickBusy ? <Loader2 className="animate-spin" /> : <Sparkles />}
                                    label={CREW_ONE_CLICK_LABEL}
                                    title={CREW_ONE_CLICK_TITLE}
                                    aria-label={CREW_ONE_CLICK_TITLE}
                                    data-testid="crew-one-click-btn"
                                    disabled={oneClickBusy || !detail}
                                    loading={oneClickBusy}
                                    onClick={() => void startOneClick()}
                                />
                                {oneClickMsg && (
                                    <p className="text-right text-[11px] leading-4 text-foreground" data-testid="crew-one-click-msg">
                                        {oneClickMsg}
                                    </p>
                                )}
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                        <ToolButton variant="default" icon={<RefreshCw />} label="刷新" onClick={() => void load()} loading={loading} />
                        <Link to={`/toiv/drama/${id}`}>
                            <ToolButton variant="default" icon={<ScrollText />} label="经典详情" />
                        </Link>
                        <Link to="/toiv/drama">
                            <ToolButton variant="default" icon={<Clapperboard />} label="项目列表" />
                        </Link>
                        </div>
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
                                aria-current={active ? "page" : undefined}
                                onClick={() => goSection(s.key)}
                                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                                    active
                                        ? "bg-[var(--surface-active)] text-foreground"
                                        : "text-[var(--muted-foreground)] hover:text-foreground"
                                }`}
                            >
                                <Icon className="size-3.5" aria-hidden />
                                {s.label}
                            </button>
                        );
                    })}
                </nav>

                {detail && (
                    <StageRail section={section} nextStep={detail.pipeline?.next_step?.step} />
                )}
                <ComputeStatusStrip variant="compact" onDeps={setDeps} />
                <ControlReadinessLamps lamps={controlLamps} variant="full" />
                {id ? (
                    <WsCreationDock
                        projectId={id}
                        pipelineLabel={PIPELINE_OPTIONS.find((p) => p.value === renderPipeline)?.label ?? renderPipeline}
                        onJumpShots={() => goSection("shots")}
                    />
                ) : null}
                <div className="px-1 pb-2">
                    <KpiNorthboundPanel days={30} compact />
                </div>
                <p className="text-[11px] text-[var(--muted-foreground)]" data-testid="keyframe-drive-badge">{KEYFRAME_DRIVE_BADGE} · 当前：{STORYBOARD_DRIVE_OPTIONS.find((o) => o.value === driveMode)?.label ?? driveMode}</p>

                {loading ? (
                    <div className="flex min-h-64 items-center justify-center">
                        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="加载中" />
                    </div>
                ) : error || !detail ? (
                    <EmptyState description="项目加载失败,请刷新重试" />
                ) : (
                    <div className="flex flex-col gap-4 rounded-xl border border-[var(--border)] p-4">
                        {section === "script" && (
                            <SectionShell title="剧本">
                                <textarea
                                    value={premiseText}
                                    onChange={(e) => setPremiseText(e.target.value)}
                                    rows={8}
                                    placeholder="写下或粘贴剧情概要/剧本,然后交给 AI 拆解为分镜…"
                                    className="w-full resize-y rounded-lg border border-[var(--border)] bg-transparent p-3 text-sm leading-6 text-foreground outline-none focus:border-[var(--workspace-accent)]"
                                    aria-label="剧本正文"
                                />
                                <div className="flex flex-wrap items-center gap-2">
                                    <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
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
                                    <span className="text-xs text-[var(--muted-foreground)]">
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
                                            className="w-full resize-y rounded-lg border border-[var(--border)] bg-transparent p-3 font-mono text-xs leading-5 text-foreground outline-none focus:border-[var(--workspace-accent)]"
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
                                            <span className="text-xs text-[var(--muted-foreground)]">
                                                确定性解析不经 LLM · 台词字数自动估时(2–15s)
                                            </span>
                                        </div>
                                        {svmlMsg && (
                                            <p className="flex items-center gap-1.5 text-xs text-foreground">
                                                {svmlBusy && <Loader2 className="size-3 animate-spin" aria-hidden />}
                                                {svmlMsg}
                                            </p>
                                        )}
                                        {svmlErr && <p className="text-xs text-[var(--danger)]">{svmlErr}</p>}
                                    </div>
                                )}
                                {parseMsg && (
                                    <p className="flex items-center gap-1.5 text-xs text-foreground">
                                        {parsing && <Loader2 className="size-3 animate-spin" aria-hidden />}
                                        {parseMsg}
                                    </p>
                                )}
                                {parseError && (
                                    <p className={`text-xs ${isStillRunningMessage(parseError) ? "text-muted-foreground" : "text-[var(--danger)]"}`}>
                                        {parseError}
                                        {isStillRunningMessage(parseError) && <>{" · "}<TasksCenterLink /></>}
                                    </p>
                                )}
                            </SectionShell>
                        )}
                        {section === "assets" && (
                            <SectionShell title="资产 / 定妆（选角锁定参考）">
                                {characters.length === 0 ? (
                                    <EmptyState description="暂无角色资产(AI 拆镜会自动入库,或在经典详情添加)" />
                                ) : (
                                    <>
                                    {!makeupReady && (
                                        <p className="rounded-lg border border-[var(--border)] bg-[var(--muted)] p-2.5 text-xs text-foreground">
                                            尚未定妆：批量生成已禁用。请为角色打开「设定卡」生成并采用参考图。
                                        </p>
                                    )}
                                    {crewAssist && (
                                        <p className="rounded-lg border border-dashed border-[var(--border)] p-2.5 text-xs text-[var(--muted-foreground)]" data-testid="crew-assist-gate-hint">
                                            人闸·定妆选角：{CREW_ASSIST_GATE_HINT}
                                        </p>
                                    )}
                                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                                        {characters.map((c) => (
                                            <li key={c.id} className="flex flex-col gap-1.5 rounded-lg border border-[var(--border)] p-3">
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="text-sm font-medium text-foreground">{c.name || "未命名"}</span>
                                                    {characterHasMakeup(c) ? (
                                                        <StatusBadge variant="filled" tone="success" label="已定妆" size="sm" />
                                                    ) : (
                                                        <StatusBadge variant="filled" tone="warning" label="待定妆" size="sm" />
                                                    )}
                                                </div>
                                                <span className="line-clamp-2 text-xs text-[var(--muted-foreground)]">
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
                                    </>
                                )}
                                <div className="mt-3 flex flex-col gap-2 rounded-lg border border-dashed border-[var(--border)] p-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-xs font-medium text-foreground">全局主体库（跨项目角色 · {sharedAssets.length}）</span>
                                        <ToolButton size="xs" variant="ghost" icon={<RefreshCw />} label="刷新" loading={sharedLoading} onClick={() => void loadShared()} />
                                    </div>
                                    {assetMsg && <p className="text-xs text-foreground">{assetMsg}</p>}
                                    {assetError && <p className="text-xs text-[var(--danger)]">{assetError}</p>}
                                    {sharedAssets.length === 0 ? (
                                        <p className="text-xs text-[var(--muted-foreground)]">暂无全局主体(在经典端「资源中心-主体库」创建后跨项目复用)</p>
                                    ) : (
                                        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
                                            {sharedAssets.map((a) => {
                                                const already = characters.some((c) => (c.name || "").trim() === (a.name || "").trim());
                                                return (
                                                    <div key={a.id} className="flex flex-col gap-1 rounded-lg border border-[var(--border)] p-2.5">
                                                        <span className="truncate text-xs font-medium text-foreground">{a.name || "未命名"}</span>
                                                        <span className="line-clamp-2 text-[11px] text-[var(--muted-foreground)]">{a.description || a.visual_prompt || "无描述"}</span>
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
                            <SectionShell title="分镜表">
                                {shots.length === 0 ? (
                                    <EmptyState description="暂无分镜（在「剧本」段用 AI 拆解或导入词锚定脚本生成）" />
                                ) : (
                                    <>
                                    {frameError && (
                                        <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-[var(--danger)]">{frameError}</p>
                                    )}
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left text-xs">
                                            <thead className="text-[var(--muted-foreground)]">
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
                                                            <StatusBadge variant="filled" tone={STATUS_TONE[s.status] ?? "neutral"} label={statusLabelZh(s.status)} size="sm" />
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
                                                                    <button
                                                                        key={v.scale}
                                                                        type="button"
                                                                        className="rounded border border-[var(--border)] p-0"
                                                                        title={`采用为关键帧（${v.scale}）`}
                                                                        aria-label={`采用${v.scale}为关键帧`}
                                                                        onClick={() => void adoptFrameAsKeyframe(s.id, v.url)}
                                                                    >
                                                                        <img src={v.url} alt={v.scale} className="h-10 w-16 rounded object-cover" loading="lazy" />
                                                                    </button>
                                                                ))}
                                                                {s.image_url ? (
                                                                    <StatusBadge variant="filled" tone="success" label="已有关键帧" size="sm" />
                                                                ) : null}
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
                            <SectionShell title="生成 · 配音 · 口型">
                                {shots.length === 0 ? (
                                    <EmptyState description="暂无镜头(先在剧本段 AI 拆解)" />
                                ) : (
                                    <>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                                                分镜驱动
                                                <Select
                                                    size="small"
                                                    value={driveMode}
                                                    onChange={(v) => void onDriveModeChange(v as StoryboardDriveMode)}
                                                    style={{ minWidth: 200 }}
                                                    popupMatchSelectWidth={false}
                                                    aria-label="分镜驱动"
                                                    options={STORYBOARD_DRIVE_OPTIONS.map((p) => ({
                                                        value: p.value,
                                                        label: p.expert ? `${p.label}（专家）` : p.label,
                                                    }))}
                                                />
                                            </label>
                                            <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                                                视频管线
                                                <Select
                                                    size="small"
                                                    value={renderPipeline}
                                                    onChange={(v) => void onPipelineChange(v as ToivRenderPipeline)}
                                                    style={{ minWidth: 200 }}
                                                    popupMatchSelectWidth={false}
                                                    aria-label="视频管线"
                                                    options={PIPELINE_OPTIONS.map((p) => ({
                                                        value: p.value,
                                                        label: p.expert ? `${p.label}（专家）` : p.label,
                                                    }))}
                                                />
                                            </label>
                                            <ToolButton
                                                variant="default"
                                                icon={<PlayCircle />}
                                                label={batchRendering ? "整批渲染中…" : "整批渲染(全部未完成镜)"}
                                                onClick={() => {
                                                    if (!makeupReady) {
                                                        setRenderError(makeupGateHint);
                                                        return;
                                                    }
                                                    setGateOpen(true);
                                                }}
                                                loading={batchRendering}
                                                disabled={!makeupReady || videoBlocked.blocked}
                                                title={videoBlocked.blocked ? videoBlocked.hint : undefined}
                                            />
                                            <ToolButton
                                                variant="default"
                                                icon={<Clapperboard />}
                                                label={chainBusy ? "管线C 提交中…" : "启动管线C(连续妆容链)"}
                                                onClick={() => void startCChain()}
                                                loading={chainBusy}
                                            />
                                            <label className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                                                加速档
                                                <Select
                                                    size="small"
                                                    value={accelLevel}
                                                    onChange={(v) => setAccelLevel(v)}
                                                    style={{ minWidth: 220 }}
                                                    popupMatchSelectWidth={false}
                                                    aria-label="加速档"
                                                    options={accelTiers.map((t) => ({
                                                        value: t.level,
                                                        label: formatAccelTierLabel(t),
                                                    }))}
                                                />
                                            </label>
                                            <span className="text-xs text-[var(--muted-foreground)]">
                                                {pipelineNote}；需角色定妆参考图；续写接缝(continue)将走管线 C；作业进任务中心
                                            </span>
                                        </div>
                                        <p className="text-xs text-[var(--muted-foreground)]">
                                            {formatAccelTierNote(selectedAccelTier) || "满血档:原生采样,质量优先(产品默认)。"}
                                            {continueSeamCount > 0 ? ` · 当前有 ${continueSeamCount} 镜衔接=续写，渲染时自动走管线 C` : ""}
                                        </p>
                                        {!makeupReady && (
                                            <p className="rounded-lg border border-[var(--border)] bg-[var(--muted)] p-2.5 text-xs text-foreground">
                                                {makeupGateHint}
                                            </p>
                                        )}
                                        {gateOpen && (
                                            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 text-xs">
                                                <p className="mb-2 font-medium text-foreground">生成前确认</p>
                                                <ul className="mb-2 flex flex-col gap-0.5 text-[var(--muted-foreground)]">
                                                    <li>· 待渲染：{shots.filter((x) => !RENDERED_STATES.has(x.status)).length} / {shots.length} 镜</li>
                                                    <li>· 管线：{PIPELINE_OPTIONS.find((p) => p.value === renderPipeline)?.label ?? renderPipeline} · 加速档：{formatAccelTierLabel(selectedAccelTier)}</li>
                                                    <li>· 定妆：已定妆 {charactersWithMakeup.length}/{characters.length || 0} 角色</li>
                                                    <li>· 说明：{formatAccelTierNote(selectedAccelTier) || "满血档:原生采样,质量优先。"}</li>
                                                    <li>· 算力消耗以舰队实跑为准；作业进任务中心可中止。</li>
                                                    {crewAssist && (
                                                        <li className="text-foreground">· 剧组协助：过脸/门禁与合成闸仍须确认，不会自动越过。</li>
                                                    )}
                                                </ul>
                                                <div className="flex gap-2">
                                                    <ToolButton
                                                        variant="default"
                                                        icon={<PlayCircle />}
                                                        label={batchRendering ? "提交中…" : "确认并开始整批渲染"}
                                                        loading={batchRendering}
                                                        onClick={() => {
                                                            setGateOpen(false);
                                                            void runBatchRender();
                                                        }}
                                                    />
                                                    <ToolButton variant="ghost" label="取消" onClick={() => setGateOpen(false)} />
                                                </div>
                                            </div>
                                        )}
                                        {chainMsg && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{chainMsg}</p>
                                        )}
                                        {renderError && (
                                            <p className="rounded-lg border border-[var(--border)] bg-[var(--muted)] p-2.5 text-xs text-[var(--danger)]">
                                                {renderError}
                                            </p>
                                        )}
                                        {renderMsg && (
                                            <p className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">
                                                {(batchRendering || busyShots.size > 0) && <Loader2 className="size-3 animate-spin" aria-hidden />}
                                                {renderMsg}
                                            </p>
                                        )}
                                        {lipsyncMsg && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{lipsyncMsg}</p>
                                        )}
                                        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="镜头视图">
                                            <ToolButton
                                                size="xs"
                                                variant="ghost"
                                                active={shotViewMode === "list"}
                                                icon={<List />}
                                                label="列表"
                                                onClick={() => setShotViewMode("list")}
                                            />
                                            <ToolButton
                                                size="xs"
                                                variant="ghost"
                                                active={shotViewMode === "board"}
                                                icon={<Columns3 />}
                                                label="看板"
                                                onClick={() => setShotViewMode("board")}
                                            />
                                            <ToolButton
                                                size="xs"
                                                variant="ghost"
                                                active={shotViewMode === "pipeline"}
                                                icon={<GitBranch />}
                                                label="流水线"
                                                onClick={() => setShotViewMode("pipeline")}
                                            />
                                            <span className="text-[11px] text-[var(--muted-foreground)]">同源投影 · 切换不丢选中</span>
                                        </div>
                                        <div className="flex min-h-0 flex-col gap-3 lg:flex-row">
                                            <div className="min-w-0 flex-1">
                                                {shotViewMode === "list" ? (
                                                    <ul className="flex flex-col gap-2">
                                                        {shots.map((s) => {
                                                            const busy = busyShots.has(s.id);
                                                            const canRender = !RENDERED_STATES.has(s.status) && !busy && makeupReady;
                                                            const hasDlg = shotHasDialogue(s.dialogue);
                                                            const canVoice = hasDlg && s.status === "rendered" && !s.voice_url && !busy;
                                                            const skippedAudio = !hasDlg && RENDERED_STATES.has(s.status) && s.status !== "rendering" && s.status !== "queued";
                                                            const focused = (selectedShotId || focusShotId) === s.id;
                                                            return (
                                                                <li
                                                                    key={s.id}
                                                                    id={`shot-${s.id}`}
                                                                    role="button"
                                                                    tabIndex={0}
                                                                    onClick={() => setSelectedShotId(s.id)}
                                                                    onKeyDown={(e) => {
                                                                        if (e.key === "Enter" || e.key === " ") {
                                                                            e.preventDefault();
                                                                            setSelectedShotId(s.id);
                                                                        }
                                                                    }}
                                                                    className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs ${focused ? "border-[var(--workspace-accent)] ring-1 ring-[var(--workspace-accent)]/50" : "border-[var(--border)]"}`}
                                                                >
                                                                    <span className="w-8 tabular-nums text-[var(--muted-foreground)]">#{s.idx}</span>
                                                                    <span className="min-w-0 flex-1 truncate">{s.scene || s.prompt || "—"}</span>
                                                                    <StatusBadge variant="filled" tone={STATUS_TONE[s.status] ?? "neutral"} label={statusLabelZh(s.status)} size="sm" />
                                                                    {skippedAudio && <StatusBadge variant="filled" tone="neutral" label="无对白·已跳过配音" size="sm" />}
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
                                                                                            onClick={(e) => {
                                                                                                e.stopPropagation();
                                                                                                void runPick(s.id, c.id);
                                                                                            }}
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
                                                                            disabled={voiceBlocked.blocked}
                                                                            title={voiceBlocked.blocked ? voiceBlocked.hint : undefined}
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                void runShotVoice(s.id);
                                                                            }}
                                                                        />
                                                                    )}
                                                                    {s.voice_url && !["lipsyncing", "lipsynced"].includes(s.status) && (
                                                                        <>
                                                                        <ToolButton
                                                                            size="xs"
                                                                            variant="ghost"
                                                                            icon={<Mic />}
                                                                            label={lipsyncBusy.has(s.id) ? "对口型中…" : "对口型"}
                                                                            loading={lipsyncBusy.has(s.id)}
                                                                            disabled={voiceBlocked.blocked}
                                                                            title={voiceBlocked.blocked ? voiceBlocked.hint : undefined}
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                void runLipsync(s.id);
                                                                            }}
                                                                        />
                                                                        <ToolButton
                                                                            size="xs"
                                                                            variant="ghost"
                                                                            icon={<Check />}
                                                                            label="跳过口型"
                                                                            loading={lipsyncBusy.has(s.id)}
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                void runSkipLipsync(s.id);
                                                                            }}
                                                                        />
                                                                        </>
                                                                    )}
                                                                    {s.lipsync_skipped && <StatusBadge variant="filled" tone="warning" label="未对口型" size="sm" />}
                                                                    {canRender && (
                                                                        <ToolButton
                                                                            size="xs"
                                                                            variant="ghost"
                                                                            icon={<PlayCircle />}
                                                                            label={busy ? "渲染中…" : "渲染"}
                                                                            disabled={videoBlocked.blocked}
                                                                            title={videoBlocked.blocked ? videoBlocked.hint : undefined}
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                void runShotRender(s.id);
                                                                            }}
                                                                        />
                                                                    )}
                                                                    {busy && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />}
                                                                </li>
                                                            );
                                                        })}
                                                    </ul>
                                                ) : shotViewMode === "board" ? (
                                                    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="drama-shot-board">
                                                        {DRAMA_BOARD_COLUMNS.map((col) => (
                                                            <div key={col.id} className="flex min-h-[140px] flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--muted)]/20 p-2">
                                                                <div className="flex items-center justify-between px-1">
                                                                    <h3 className="text-xs font-semibold text-foreground">{col.label}</h3>
                                                                    <span className="tabular-nums text-[10px] text-[var(--muted-foreground)]">{boardGroups[col.id].length}</span>
                                                                </div>
                                                                <ul className="flex flex-col gap-1.5">
                                                                    {boardGroups[col.id].map((s) => {
                                                                        const focused = selectedShotId === s.id;
                                                                        return (
                                                                            <li key={s.id} id={`shot-board-${s.id}`}>
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={() => setSelectedShotId(s.id)}
                                                                                    className={`w-full rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${focused ? "border-[var(--workspace-accent)] bg-[var(--card)] ring-1 ring-[var(--workspace-accent)]/40" : "border-[var(--border)] bg-[var(--card)] hover:border-[var(--workspace-accent)]/60"}`}
                                                                                >
                                                                                    <div className="flex items-center gap-1.5">
                                                                                        <span className="tabular-nums text-[var(--muted-foreground)]">#{s.idx}</span>
                                                                                        <StatusBadge variant="filled" tone={STATUS_TONE[s.status] ?? "neutral"} label={statusLabelZh(s.status)} size="sm" />
                                                                                    </div>
                                                                                    <p className="mt-1 line-clamp-2 text-foreground">{s.scene || s.prompt || "—"}</p>
                                                                                    <div className="mt-1 flex flex-wrap gap-1">
                                                                                        {s.video_url && <StatusBadge variant="filled" tone="success" label="视频" size="sm" />}
                                                                                        {s.voice_url && <StatusBadge variant="filled" tone="success" label="配音" size="sm" />}
                                                                                        {s.final_clip_url && <StatusBadge variant="filled" tone="success" label="成片" size="sm" />}
                                                                                    </div>
                                                                                </button>
                                                                            </li>
                                                                        );
                                                                    })}
                                                                    {boardGroups[col.id].length === 0 && (
                                                                        <p className="px-1 py-3 text-[10px] text-[var(--muted-foreground)]">空列</p>
                                                                    )}
                                                                </ul>
                                                            </div>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <div className="flex flex-col gap-2" data-testid="drama-shot-pipeline">
                                                        <div className="grid grid-cols-[48px_repeat(5,minmax(0,1fr))] gap-1 px-1 text-[10px] font-medium text-[var(--muted-foreground)]">
                                                            <span>#</span>
                                                            {DRAMA_PIPELINE_STAGES.map((st) => (
                                                                <span key={st.id} className="truncate text-center">{st.label}</span>
                                                            ))}
                                                        </div>
                                                        <ul className="flex flex-col gap-1.5">
                                                            {pipelineRows.map((row) => {
                                                                const focused = selectedShotId === row.shotId;
                                                                return (
                                                                    <li key={row.shotId} id={`shot-pipeline-${row.shotId}`}>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => setSelectedShotId(row.shotId)}
                                                                            className={`grid w-full grid-cols-[48px_repeat(5,minmax(0,1fr))] items-center gap-1 rounded-md border px-1.5 py-1.5 text-left text-[11px] transition-colors ${focused ? "border-[var(--workspace-accent)] bg-[var(--card)] ring-1 ring-[var(--workspace-accent)]/40" : "border-[var(--border)] bg-[var(--card)] hover:border-[var(--workspace-accent)]/60"}`}
                                                                        >
                                                                            <span className="tabular-nums text-[var(--muted-foreground)]">#{row.idx}</span>
                                                                            {DRAMA_PIPELINE_STAGES.map((st) => {
                                                                                const state = row.cells[st.id];
                                                                                const tone =
                                                                                    state === "ready"
                                                                                        ? "success"
                                                                                        : state === "busy"
                                                                                          ? "warning"
                                                                                          : state === "failed"
                                                                                            ? "error"
                                                                                            : "neutral";
                                                                                return (
                                                                                    <span key={st.id} className="flex justify-center">
                                                                                        <StatusBadge variant="filled" tone={tone} label={dramaPipelineCellLabel(state)} size="sm" />
                                                                                    </span>
                                                                                );
                                                                            })}
                                                                        </button>
                                                                        <p className="mt-0.5 truncate px-1 text-[10px] text-[var(--muted-foreground)]">{row.projection.scene || row.projection.prompt || "—"}</p>
                                                                    </li>
                                                                );
                                                            })}
                                                            {pipelineRows.length === 0 && (
                                                                <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--muted-foreground)]">
                                                                    暂无镜头 · 从分镜生成后可在此查看「文→帧→视频」投影
                                                                </p>
                                                            )}
                                                        </ul>
                                                    </div>
                                                )}
                                            </div>
                                            <aside
                                                className="w-full shrink-0 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 lg:w-72"
                                                aria-label="镜头检视器"
                                                data-testid="drama-shot-inspector"
                                            >
                                                {selectedShot ? (
                                                    (() => {
                                                        const proj = toDramaShotProjection(selectedShot, renderPipeline);
                                                        const busy = busyShots.has(selectedShot.id);
                                                        const canRender = !RENDERED_STATES.has(selectedShot.status) && !busy && makeupReady;
                                                        const hasDlg = shotHasDialogue(selectedShot.dialogue);
                                                        const canVoice = hasDlg && selectedShot.status === "rendered" && !selectedShot.voice_url && !busy;
                                                        return (
                                                            <div className="flex flex-col gap-2 text-xs">
                                                                <div className="flex items-start justify-between gap-2">
                                                                    <div>
                                                                        <p className="text-sm font-semibold text-foreground">镜头 #{proj.idx}</p>
                                                                        <p className="text-[10px] text-[var(--muted-foreground)]">id {proj.shotId.slice(0, 8)}…</p>
                                                                    </div>
                                                                    <ToolButton size="xs" variant="ghost" icon={<X />} label="关闭" onClick={() => setSelectedShotId(null)} />
                                                                </div>
                                                                <StatusBadge variant="filled" tone={STATUS_TONE[selectedShot.status] ?? "neutral"} label={statusLabelZh(selectedShot.status)} size="sm" />
                                                                <p className="text-[var(--muted-foreground)]">管线 · {PIPELINE_OPTIONS.find((x) => x.value === renderPipeline)?.label ?? renderPipeline}</p>
                                                                <div>
                                                                    <p className="mb-0.5 font-medium text-foreground">提示语</p>
                                                                    <p className="whitespace-pre-wrap break-words text-[var(--muted-foreground)]">{proj.prompt || proj.scene || "—"}</p>
                                                                </div>
                                                                <div>
                                                                    <p className="mb-0.5 font-medium text-foreground">台词</p>
                                                                    <p className="whitespace-pre-wrap break-words text-[var(--muted-foreground)]">{proj.dialogue?.trim() || "（无对白）"}</p>
                                                                </div>
                                                                {(proj.imageUrl || proj.videoUrl) && (
                                                                    <div className="flex flex-col gap-1.5">
                                                                        {proj.imageUrl && <img src={toivMediaUrl(proj.imageUrl) || proj.imageUrl} alt="" className="max-h-28 w-full rounded border border-[var(--border)] object-cover" />}
                                                                        {proj.videoUrl && <video src={toivMediaUrl(proj.videoUrl) || proj.videoUrl} className="max-h-36 w-full rounded border border-[var(--border)]" controls preload="metadata" />}
                                                                    </div>
                                                                )}
                                                                <div className="flex flex-wrap gap-1">
                                                                    {proj.voiceUrl && <StatusBadge variant="filled" tone="success" label="已配音" size="sm" />}
                                                                    {proj.finalClipUrl && <StatusBadge variant="filled" tone="success" label="成片段" size="sm" />}
                                                                    {selectedShot.error && <StatusBadge variant="filled" tone="error" label="失败" size="sm" />}
                                                                </div>
                                                                {selectedShot.error && (
                                                                    <p className="rounded border border-[var(--border)] bg-[var(--muted)] p-2 text-[var(--danger)]">{selectedShot.error}</p>
                                                                )}
                                                                <div className="flex flex-wrap gap-1.5 pt-1">
                                                                    {canRender && (
                                                                        <ToolButton size="xs" variant="default" icon={<PlayCircle />} label={busy ? "渲染中…" : "渲染"} onClick={() => void runShotRender(selectedShot.id)} />
                                                                    )}
                                                                    {canVoice && (
                                                                        <ToolButton size="xs" variant="ghost" icon={<Volume2 />} label="配音" onClick={() => void runShotVoice(selectedShot.id)} />
                                                                    )}
                                                                    {selectedShot.voice_url && !["lipsyncing", "lipsynced"].includes(selectedShot.status) && (
                                                                        <>
                                                                        <ToolButton size="xs" variant="ghost" icon={<Mic />} label="对口型" loading={lipsyncBusy.has(selectedShot.id)} disabled={voiceBlocked.blocked} title={voiceBlocked.blocked ? voiceBlocked.hint : undefined} onClick={() => void runLipsync(selectedShot.id)} />
                                                                        <ToolButton size="xs" variant="ghost" icon={<Check />} label="跳过口型" loading={lipsyncBusy.has(selectedShot.id)} onClick={() => void runSkipLipsync(selectedShot.id)} />
                                                                        </>
                                                                    )}
                                                                    {selectedShot.lipsync_skipped && <StatusBadge variant="filled" tone="warning" label="未对口型" size="sm" />}
                                                                </div>
                                                            </div>
                                                        );
                                                    })()
                                                ) : (
                                                    <p className="text-xs text-[var(--muted-foreground)]">选中一镜后，在此查看提示语 / 管线 / 声画状态（参数进检视器，减少浮层挡操作）。</p>
                                                )}
                                            </aside>
                                        </div>
                                    </>
                                )}
                            </SectionShell>
                        )}
                        {section === "timeline" && (
                            <SectionShell title="时间线（汇编）">
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
                                                disabled={tlSaving || beatEditing.size > 0}
                                            />
                                            {beatEditing.size > 0 && <span className="text-xs text-muted-foreground">请先应用改词重排，再保存排序与时长</span>}
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
                                            <span className="text-xs text-[var(--muted-foreground)]">
                                                就绪 {shots.filter((x) => x.final_clip_url).length}/{shots.length} 镜;配音镜 {shots.filter((x) => x.voice_url).length} 个(字幕源)
                                            </span>
                                        </div>
                                        {subsMsg && <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{subsMsg}</p>}
                                        {subsError && <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-[var(--danger)]">{subsError}</p>}
                                        {tlMsg && <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{tlMsg}</p>}
                                        {tlError && <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-[var(--danger)]">{tlError}</p>}
                                        {assembleError && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-[var(--danger)]">{assembleError}</p>
                                        )}
                                        {assembleMsg && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{assembleMsg}</p>
                                        )}
                                        {id && (
                                            <BgmBedPanel projectId={id} value={bgmBed} onChange={setBgmBed} disabled={assembling} />
                                        )}
                                        <ol className="flex flex-col gap-1.5">
                                            {tlShots.map((x, i) => (
                                                <Fragment key={x.id}>
                                                <li className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
                                                    <span className="flex flex-col gap-0.5">
                                                        <button type="button" aria-label={`上移 ${x.scene?.slice(0, 8) ?? x.id.slice(0, 6)}`} disabled={i === 0} onClick={() => tlMove(x.id, -1)} className="text-[var(--muted-foreground)] hover:text-foreground disabled:opacity-30"><ArrowUp className="size-3" /></button>
                                                        <button type="button" aria-label={`下移 ${x.scene?.slice(0, 8) ?? x.id.slice(0, 6)}`} disabled={i === tlShots.length - 1} onClick={() => tlMove(x.id, 1)} className="text-[var(--muted-foreground)] hover:text-foreground disabled:opacity-30"><ArrowDown className="size-3" /></button>
                                                    </span>
                                                    <span className="w-8 tabular-nums text-[var(--muted-foreground)]">{String(i + 1).padStart(2, "0")}</span>
                                                    <span className="min-w-0 flex-1 truncate">{x.scene || x.prompt || "—"}</span>
                                                    <label className="flex items-center gap-1 text-[var(--muted-foreground)]">
                                                        时长
                                                        <input
                                                            type="number" min={3} max={60} value={tlDuration[x.id] ?? x.duration_sec ?? 6}
                                                            disabled={tlSaving || beatEditing.has(x.id)}
                                                            onChange={(e) => tlSetDuration(x.id, Number(e.target.value) || 3)}
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
                                                        : <StatusBadge variant="filled" tone={STATUS_TONE[x.status] ?? "neutral"} label={statusLabelZh(x.status)} size="sm" />}
                                                </li>
                                                    {(x.beats?.length ?? 0) > 0 && (
                                                        <li key={`${x.id}-beats`} className="px-1">
                                                            <WordAnchorTimeline
                                                                shot={x}
                                                                totalSec={tlDuration[x.id] ?? x.duration_sec}
                                                                disabled={tlSaving}
                                                                onEditingChange={onBeatEditingChange}
                                                                onUpdated={(patch) => {
                                                                    if (patch.duration_sec != null) tlSetDuration(x.id, patch.duration_sec);
                                                                    setDetail((prev) => prev ? {
                                                                        ...prev,
                                                                        shots: prev.shots?.map((s) => s.id === x.id ? { ...s, ...patch } : s),
                                                                    } : prev);
                                                                }}
                                                            />
                                                        </li>
                                                    )}
                                                </Fragment>
                                            ))}
                                        </ol>
                                        {id && (
                                            <SceneAnchorPanel
                                                projectId={id}
                                                shots={tlShots.map((x) => ({ id: x.id, idx: x.idx, scene: x.scene }))}
                                            />
                                        )}
                                    </>
                                )}
                            </SectionShell>
                        )}
                        {section === "final" && (
                            <SectionShell title="合成预览">
                                {id && (
                                    <BgmBedPanel projectId={id} value={bgmBed} onChange={setBgmBed} disabled={assembling} />
                                )}
                                {detail.final_url ? (
                                    <div className="flex flex-col gap-3">
                                        <video src={toivMediaUrl(detail.final_url) || detail.final_url} controls className="max-h-96 w-full rounded-lg border border-[var(--border)]" />
                                        <div className="flex flex-wrap gap-2">
                                            <ToolButton
                                                variant="default"
                                                icon={<Film />}
                                                label="在本页重看成片"
                                                onClick={() => {
                                                    const el = document.querySelector<HTMLVideoElement>("section video, .toiv-drama-workspace video");
                                                    el?.play?.();
                                                }}
                                            />
                                            <ToolButton
                                                variant="ghost"
                                                icon={<Layers />}
                                                label="回时间线调序"
                                                onClick={() => goSection("timeline")}
                                            />
                                            {id && (
                                                <div className="w-full">
                                                    <JianyingExportButton
                                                        projectId={id}
                                                        shots={detail.shots ?? tlShots}
                                                        disabled={assembling}
                                                    />
                                                </div>
                                            )}
                                            {crewAssist && (
                                                <p className="w-full rounded-lg border border-dashed border-[var(--border)] p-2 text-[11px] text-[var(--muted-foreground)]">
                                                    人闸·合成：{CREW_ASSIST_GATE_HINT}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-3">
                                        <EmptyState description="暂无成片。镜头就绪后可在时间线合成，或直接在此发起合成预览。" />
                                        {crewAssist && (
                                            <p className="rounded-lg border border-dashed border-[var(--border)] p-2.5 text-xs text-[var(--muted-foreground)]">
                                                人闸·合成：{CREW_ASSIST_GATE_HINT}
                                            </p>
                                        )}
                                        <div className="flex flex-wrap gap-2">
                                            <ToolButton
                                                variant="default"
                                                icon={<Film />}
                                                label={assembling ? "合成中…" : "合成预览"}
                                                loading={assembling}
                                                onClick={() => void runAssemble()}
                                            />
                                            <ToolButton variant="ghost" icon={<Layers />} label="去时间线检查片段" onClick={() => goSection("timeline")} />
                                        </div>
                                        {id && (
                                            <JianyingExportButton
                                                projectId={id}
                                                shots={detail.shots ?? tlShots}
                                                disabled={assembling}
                                            />
                                        )}
                                        {assembleError && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-[var(--danger)]">{assembleError}</p>
                                        )}
                                        {assembleMsg && (
                                            <p className="rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">{assembleMsg}</p>
                                        )}
                                    </div>
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
                            <p className="rounded-xl bg-[var(--muted)] p-3 text-xs leading-relaxed text-muted-foreground">{sheetChar.visual_prompt}</p>
                        )}
                        <div className="flex flex-col gap-2">
                            <span className="text-xs font-medium text-foreground">设定卡（{sheets.length}）</span>
                            {(sheetFailure || sheetError) && (
                                <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--muted)] p-2.5">
                                    <p className="text-xs font-medium text-[var(--danger)]">
                                        {sheetFailure?.reasonZh || sheetError}
                                    </p>
                                    {sheetFailure?.previewUrl && (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-[11px] text-muted-foreground">被拒预览（门禁未过）</span>
                                            <img
                                                src={toivMediaUrl(sheetFailure.previewUrl)}
                                                alt="被拒设定卡预览"
                                                className="w-full rounded-lg border border-[var(--border)]"
                                                loading="lazy"
                                            />
                                        </div>
                                    )}
                                    {sheetFailure?.technicalDetail && sheetFailure.technicalDetail !== sheetFailure.reasonZh && (
                                        <details className="text-[11px] text-muted-foreground">
                                            <summary className="cursor-pointer select-none">技术细节</summary>
                                            <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-black/20 p-2">{sheetFailure.technicalDetail}</pre>
                                        </details>
                                    )}
                                    <div className="flex flex-wrap gap-2">
                                        {sheetChar && (
                                            <ToolButton
                                                size="xs"
                                                icon={<RefreshCw />}
                                                label="再生成"
                                                loading={!!regenStyle}
                                                onClick={() => void regenSheet(sheetChar.id, sheetFailure?.style || lastSheetStyle || "anime")}
                                            />
                                        )}
                                        {sheetFailure?.softKeepAvailable && sheetFailure.previewUrl && (
                                            <ToolButton
                                                size="xs"
                                                variant="default"
                                                icon={<Check />}
                                                label={softKeepBusy ? "保留中…" : "仍保留此图（仅警告）"}
                                                loading={softKeepBusy}
                                                onClick={() => void softKeepRejected()}
                                            />
                                        )}
                                    </div>
                                </div>
                            )}
                            {sheetMsg && (
                                <p className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border)] p-2.5 text-xs text-foreground">
                                    {regenStyle && <Loader2 className="size-3 animate-spin" aria-hidden />}
                                    <span>{sheetMsg}</span>
                                    {isStillRunningMessage(sheetMsg) && <TasksCenterLink />}
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
                                        {sh.gate_warning && (
                                            <p className="rounded-md bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200">
                                                警告保留：{sh.gate_warning_zh || "门禁未过，仅供本地学习继续用"}
                                            </p>
                                        )}
                                        {sh.sheet_url && <img src={toivMediaUrl(sh.sheet_url)} alt="" className="w-full rounded-lg" loading="lazy" />}
                                    </div>
                                ))
                            )}
                            {/* D5/AUDIT：角色资产变体下单（现有设定卡 async；扩展画风标明 API 缺口） */}
                            <div className="mt-2 flex flex-col gap-2 rounded-lg border border-dashed border-[var(--border)] p-2.5" data-testid="character-variant-order">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-medium text-foreground">画风变体 · 下单</span>
                                    <span className="text-[11px] text-[var(--muted-foreground)]">锚点优先于画风</span>
                                </div>
                                {pendingSheetVariantOrders(sheets.map((s) => s.style)).length > 0 ? (
                                    <div className="flex flex-wrap gap-2">
                                        {pendingSheetVariantOrders(sheets.map((s) => s.style)).map((spec) => (
                                            <ToolButton
                                                key={spec.key}
                                                size="xs"
                                                variant="default"
                                                icon={<Sparkles />}
                                                label={`下单变体：${spec.zh}`}
                                                loading={regenStyle === spec.key}
                                                onClick={() => void regenSheet(sheetChar.id, spec.key)}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-[11px] text-[var(--muted-foreground)]">
                                        可下单的设定卡画风（古风写实 / 二次元）已齐；可对上方卡片「重生成」。
                                    </p>
                                )}
                                {CHARACTER_STYLE_VARIANTS.some((s) => !s.sheetOrderable) && (
                                    <div className="flex flex-col gap-1">
                                        <p className="text-[11px] text-[var(--muted-foreground)]">{EXTENDED_VARIANT_API_GAP}</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {CHARACTER_STYLE_VARIANTS.filter((s) => !s.sheetOrderable).map((spec) => {
                                                const registered = Boolean(characterAsset?.style_variants?.[spec.key]?.url);
                                                return (
                                                    <StatusBadge
                                                        key={spec.key}
                                                        variant="filled"
                                                        tone={registered ? "success" : "neutral"}
                                                        label={registered ? `${spec.zh}·已登记` : `${spec.zh}·待 API`}
                                                        size="sm"
                                                    />
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                                {characterAsset?.style_variants && Object.keys(characterAsset.style_variants).length > 0 && (
                                    <div className="grid grid-cols-2 gap-2">
                                        {Object.entries(characterAsset.style_variants).map(([key, rec]) => {
                                            const url = typeof rec?.url === "string" ? rec.url : "";
                                            if (!url) return null;
                                            const zh = CHARACTER_STYLE_VARIANTS.find((s) => s.key === key)?.zh || key;
                                            return (
                                                <div key={key} className="flex flex-col gap-1 rounded-md border border-[var(--border)] p-1.5">
                                                    <span className="text-[11px] text-muted-foreground">{zh}</span>
                                                    <img src={toivMediaUrl(url)} alt={`${zh} 变体`} className="w-full rounded" loading="lazy" />
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </AppDrawer>
        </WorkspacePage>
    );
}

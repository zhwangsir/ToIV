"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Field, Select, Textarea } from "@/components/ui/Input";
import { Popover } from "@/components/ui/Popover";
import { Ripple } from "@/components/ui/Ripple";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { usePoll } from "@/hooks/usePoll";
import { useAutoResize } from "@/hooks/useAutoResize";
import { invalidateJobs, apiFetch, authHeaders, listRecipes, type CommunityRecipe } from "@/lib/api";
import type { JobItem } from "@/lib/types";
import { consumeEngineDraft, type EngineDraft } from "@/lib/engine";
import {
  engineDefaults,
  engineMaxImages,
  engineNeedsAudio,
  engineNeedsImage,
  engineNeedsVideo,
  engineSupportsNegative,
  fetchEngines,
  refreshEngines,
  submitEngineGeneration,
  type EngineInfo,
  type EngineKind,
} from "@/lib/engines";
import { R18_CHANGED_EVENT } from "@/lib/r18";
import { useGeneration } from "@/lib/useGeneration";
import { BREAKPOINTS } from "@/lib/useBreakpoint";
import { friendlyError } from "@/lib/friendlyError";

import { EngineInfoCard } from "./EngineInfoCard";
import { ParamField } from "./ParamField";
import { applyAspectPair } from "@/lib/aspectPair";
import { PARAM_PANEL_GROUPS, groupEngineParams } from "./paramGroups";
import { PromptBar } from "./PromptBar";
import { RefAudioUpload, type UploadedAudio } from "./RefAudioUpload";
import { RefImageUpload, type UploadedRef } from "./RefImageUpload";
import { RefImagesUpload } from "./RefImagesUpload";
import { RefVideoUpload, type UploadedVideo } from "./RefVideoUpload";
import { ResultPanel, type HistoryEntry } from "./ResultPanel";

function newEntryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成工作台初始草稿:prompt/参考图预填;target 决定初始模式(image→图像,video→视频)。 */
export interface GenerateDraft extends EngineDraft {
  refImage?: UploadedRef | null;
}

interface GenerateViewProps {
  /**
   * 外部注入的初始草稿(W3 旧视图退役:图像/视频生成的草稿流并入此处)。
   * 未提供(prop 为 undefined)时自动消费 localStorage 引擎草稿(lib/engine);
   * 显式传 null 表示禁用草稿(如 /nsfw 内嵌,不消费主站草稿)。
   */
  initialDraft?: GenerateDraft | null;
  /**
   * M1 三大板块拆分:传入时工作台锁定为该引擎 kind(图片/视频/音频),
   * 顶部模式段控隐藏;未传保持旧行为(图像|视频段控,兼容旧用法)。
   */
  lockedKind?: EngineKind;
  /**
   * (2026-08-18 页头整体移除:灵动岛已指示当前板块;原 hideHeader prop 退役)
   */
}

/** 板块标题/文案用的 kind 中文名。 */
const KIND_LABEL: Record<EngineKind, string> = {
  image: "AI图片",
  video: "AI视频",
  audio: "AI音频",
};

/** 文生/图生分组标签(按 kind 语义化)。 */
const GROUP_LABEL: Record<EngineKind, { gen: string; edit: string }> = {
  image: { gen: "文生图", edit: "图生图" },
  video: { gen: "文生视频", edit: "图生视频" },
  audio: { gen: "生成", edit: "编辑" },
};

/** 尺寸参数 key(两项都存在时吸附到提示词条的尺寸 chip,浮板「画幅与时长」组不再重复渲染)。 */
const SIZE_PARAM_KEYS: ReadonlySet<string> = new Set(["width", "height"]);

/**
 * 统一生成工作台(W1 信息架构 + WS2 剧场化布局)。
 *
 * 信息架构:接入新引擎 = 后端注册表(services/engine_registry)加条目,前端不再开新视图。
 * - 顶部模式段控:图像 | 视频(引擎列表按 kind 过滤;传 lockedKind 时锁定并隐藏)
 * - 板块内「生成 | 编辑」段控(数据驱动:params 含 images 类型 = 编辑组,否则生成组;
 *   两组都有引擎时才显示,默认「生成」)
 * - 暗舞台结果区(ResultPanel):全出血 contain 展示 + 底部胶片条 + A/B 对比,
 *   ←/→ 方向键在舞台容器上切换选中条目
 * - 提示词条(PromptBar):底部居中悬浮玻璃条,自动增高 textarea + 引擎/尺寸 chips
 *   + OptimizeButton + 生成/取消按钮
 * - 参数浮板(2026-08-17 Inspector 化):position:absolute 浮于舞台右侧(不占布局列,
 *   舞台始终全宽),收起态为右下角悬浮球;头部「参数台+引擎名」固定在滚动区外
 *   (内容超高滚动时不再裁剪标题),参数按 paramGroups 分组卡渲染(模型与引擎/
 *   画幅与时长/采样/LoRA 叠加),负向提示词与未识别 key 收进「高级参数」折叠区;
 *   引擎行 ⓘ 按钮弹出引擎说明卡(description/出处/参数个数,EngineInfoCard)
 * 提交链路:按引擎 id 路由到既有 API(lib/engines.submitEngineGeneration),
 * SSE 进度复用 useGeneration/trackJob;NSFW 引擎由后端按 R18 上下文过滤,前端不判断。
 */
export function GenerateView({ initialDraft, lockedKind }: GenerateViewProps) {
  // 草稿:显式 prop 优先;否则消费 localStorage 引擎草稿(target=drama/manju 由短剧/漫剧视图消费,此处忽略)。
  // 锁定 kind 时只消费 target 匹配的草稿(不匹配不消费,留给对应板块;audio 无草稿来源,天然为空)。
  const draft = useMemo<GenerateDraft | null>(
    () => (initialDraft !== undefined ? initialDraft : consumeEngineDraft(lockedKind)),
    [initialDraft, lockedKind],
  );
  // lockedKind 为受控模式:prop 变化(如 /nsfw tab 切换复用同一组件实例)时 mode 必须跟随,
  // 否则引擎列表停留在旧 kind。非锁定(主站图像|视频段控)走内部 state。
  const [modeState, setMode] = useState<EngineKind>(
    lockedKind ?? (draft?.target === "video" ? "video" : "image"),
  );
  const mode = lockedKind ?? modeState;
  const toast = useToast();
  // 高级参数抽屉引用:优化回填负向提示词时自动展开,让用户看见填入结果
  const advDetailsRef = useRef<HTMLDetailsElement>(null);
  const negativeRef = useRef<HTMLTextAreaElement | null>(null);
  // 提示词输入框句柄(T3):快速开始卡点击后聚焦,用户即刻开写
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  // 引擎说明卡(T2):ⓘ 按钮为 Popover 锚点,卡片内容见 EngineInfoCard
  const [engineInfoOpen, setEngineInfoOpen] = useState(false);
  const engineInfoBtnRef = useRef<HTMLButtonElement | null>(null);
  // 参数浮板开关:收起时为右下角悬浮球(会话级);窄屏(≤1023px,与 stage.css 浮板底部抽屉档一致)默认收起为 FAB,舞台优先
  const [paramsOpen, setParamsOpen] = useState(
    () =>
      !(
        typeof window !== "undefined" &&
        window.matchMedia(`(max-width: ${BREAKPOINTS.lg - 1}px)`).matches
      ),
  );
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  const [refreshingEngines, setRefreshingEngines] = useState(false);

  // 引擎列表加载:30s 轮询与 R18 切换事件共用同一拉取函数
  const loadEngines = useCallback(async () => {
    try {
      setEngines(await fetchEngines());
      setEnginesError(null);
    } catch (e) {
      setEnginesError(e instanceof Error ? e.message : "加载引擎列表失败");
    }
  }, []);

  // 引擎注册表:进入即拉取 + 30s 轮询刷新可用性(worker 上下线会反映到状态点)
  usePoll(loadEngines, { intervalMs: 30_000, enabled: true, backoff: true });

  // R18 全局模式切换(M9):后端按 X-NSFW 上下文混入/剔除 R18 引擎,
  // 监听广播事件立即重拉(engines 无 SWR 缓存,直接重 fetch)
  useEffect(() => {
    const handler = () => void loadEngines();
    window.addEventListener(R18_CHANGED_EVENT, handler);
    return () => window.removeEventListener(R18_CHANGED_EVENT, handler);
  }, [loadEngines]);

  /** 「重新检测」:强制后端清探测缓存重查,返回的全量引擎直接覆盖本地状态。 */
  async function onRefreshEngines() {
    if (refreshingEngines) return;
    setRefreshingEngines(true);
    try {
      setEngines(await refreshEngines());
      setEnginesError(null);
      toast.success("引擎可用性已重新检测");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "重新检测引擎失败");
    } finally {
      setRefreshingEngines(false);
    }
  }

  const kindEngines = useMemo(
    () => (engines ?? []).filter((e) => e.kind === mode),
    [engines, mode],
  );

  // 板块内「生成 | 编辑」分组(数据驱动:params 含 images 类型 = 编辑组,否则生成组)。
  // 两组都有引擎时才显示段控(如音频板块当前仅 ace-music 生成组,段控自动不显示)。
  const genGroup = useMemo(() => kindEngines.filter((e) => engineNeedsImage(e) === null), [kindEngines]);
  const editGroup = useMemo(() => kindEngines.filter((e) => engineNeedsImage(e) !== null), [kindEngines]);
  const showGroupTabs = genGroup.length > 0 && editGroup.length > 0;
  const [groupByKind, setGroupByKind] = useState<Partial<Record<EngineKind, "gen" | "edit">>>({});
  const group = groupByKind[mode] ?? "gen";
  const visibleEngines = showGroupTabs ? (group === "gen" ? genGroup : editGroup) : kindEngines;

  const [engineIdByKind, setEngineIdByKind] = useState<Partial<Record<EngineKind, string>>>({});
  const engine = useMemo(() => {
    const sel = engineIdByKind[mode];
    return (
      visibleEngines.find((e) => e.id === sel && e.available) ??
      // 切组/切 kind 后,选择自动落到该组第一个可用引擎
      visibleEngines.find((e) => e.available) ??
      visibleEngines[0] ??
      null
    );
  }, [visibleEngines, engineIdByKind, mode]);

  // 社区精选配方(CivitAI 作品逆向):按当前引擎加载,一键回填提示词/负向/LoRA/参数;
  // R18 配方由后端按 X-NSFW 上下文放行(authHeaders 自动注入),主站天然不可见
  const [recipes, setRecipes] = useState<CommunityRecipe[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!engine) {
      setRecipes([]);
      return;
    }
    listRecipes(engine.id)
      .then((rs) => {
        if (!cancelled) setRecipes(rs);
      })
      .catch(() => {
        if (!cancelled) setRecipes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [engine?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 参数状态:按引擎 id 分槽保存,切换引擎不丢输入(会话级)
  const [valuesByEngine, setValuesByEngine] = useState<Record<string, Record<string, unknown>>>({});
  const [promptByEngine, setPromptByEngine] = useState<Record<string, string>>({});
  const [refByEngine, setRefByEngine] = useState<Record<string, UploadedRef | null>>({});
  const [refsByEngine, setRefsByEngine] = useState<Record<string, UploadedRef[]>>({});
  const [audioByEngine, setAudioByEngine] = useState<Record<string, UploadedAudio | null>>({});
  const [videoByEngine, setVideoByEngine] = useState<Record<string, UploadedVideo | null>>({});

  const values = useMemo(
    () => (engine ? { ...engineDefaults(engine), ...(valuesByEngine[engine.id] ?? {}) } : {}),
    [engine, valuesByEngine],
  );
  const positive = engine ? promptByEngine[engine.id] ?? "" : "";
  // 负向提示词自动增高(无上限,resize:vertical 兜底;closed <details> 内 hook 自动跳过)
  useAutoResize(negativeRef, String(values["negative"] ?? ""));
  const refImage = engine ? refByEngine[engine.id] ?? null : null;
  const refImages = engine ? refsByEngine[engine.id] ?? [] : [];
  const refAudio = engine ? audioByEngine[engine.id] ?? null : null;
  const refVideo = engine ? videoByEngine[engine.id] ?? null : null;
  const imageParam = engine ? engineNeedsImage(engine) : null;
  const audioParam = engine ? engineNeedsAudio(engine) : null;
  const videoParam = engine ? engineNeedsVideo(engine) : null;
  // images 类型 max>1 = 多参考图(VACE);单图引擎仍走旧单槽
  const multiImage = engine ? engineMaxImages(engine) > 1 : false;

  // 参数分区(T1 Inspector 化):尺寸(width/height 成对)→ PromptBar chip;
  // 参考输入(images/audio/video)→ 上传组件独立成节;其余按 paramGroups 分组卡
  // (模型与引擎/画幅与时长/采样/LoRA 叠加);negative 与未识别 key → 高级参数折叠区
  const sizeParams = useMemo(
    () =>
      engine
        ? engine.params.filter((p) => p.type === "number" && SIZE_PARAM_KEYS.has(p.key))
        : [],
    [engine],
  );
  const showSizeChip = sizeParams.length === 2;
  const paramGroups = useMemo(
    () => (engine ? groupEngineParams(engine.params, { sizeChip: showSizeChip }) : null),
    [engine, showSizeChip],
  );
  // 高级组:negative 由下方 Textarea 特判渲染(自动增高 + 优化回填联动),其余走 ParamField
  const advancedParams = useMemo(
    () => (paramGroups ? paramGroups.advanced.filter((p) => p.key !== "negative") : []),
    [paramGroups],
  );
  const showAdvanced = (paramGroups?.advanced.length ?? 0) > 0;

  // 参数浮板收起时同步关闭引擎说明卡:锚点(ⓘ 按钮)随之卸载,浮层不能悬空
  useEffect(() => {
    if (!paramsOpen) setEngineInfoOpen(false);
  }, [paramsOpen]);

  // OptimizeButton kind 映射:文生图→image、图生图(含 images 参数)→image_edit、视频→video、音频→audio
  const optimizeKind = !engine
    ? "image"
    : engine.kind === "image"
      ? imageParam
        ? "image_edit"
        : "image"
      : engine.kind;

  const setValue = (key: string, v: unknown) => {
    if (!engine) return;
    setValuesByEngine((prev) => ({ ...prev, [engine.id]: { ...(prev[engine.id] ?? {}), [key]: v } }));
  };

  /** 应用社区配方:提示词/负向/LoRA 一键回填;尺寸走 handleParamChange 保留宽高联动,其余参数直填。 */
  function applyRecipe(r: CommunityRecipe) {
    if (!engine) return;
    setPromptByEngine((prev) => ({ ...prev, [engine.id]: r.prompt_template }));
    setValue("negative", r.negative_template);
    if (r.loras.length > 0) setValue("loras", r.loras);
    for (const [k, v] of Object.entries(r.params)) {
      handleParamChange(k, v);
    }
    toast.success(`已应用配方「${r.label}」,可在此基础上修改提示词`);
    promptInputRef.current?.focus();
  }

  // 宽高联动(T-AR,2026-08-17):width/height 任一输入越出比例安全域(视频 9:16~16:9,
  // 图像 1:2~2:1)时,联动抬另一维度回界内——防极端比例导致生成内容主体被裁/文字溢出;
  // 后端同规则静默归一兜底(lib/aspectPair ↔ workflows/model_profiles.clamp_aspect_ratio)
  const handleParamChange = (key: string, v: unknown) => {
    if (!engine) return;
    const pair = applyAspectPair(key, v, values, engine.params);
    if (!pair) {
      setValue(key, v);
      return;
    }
    setValuesByEngine((prev) => ({
      ...prev,
      [engine.id]: {
        ...(prev[engine.id] ?? {}),
        [pair.key]: pair.value,
        [pair.otherKey]: pair.otherValue,
      },
    }));
  };

  // 草稿预填:引擎列表异步加载,待目标引擎解析后一次性回填 prompt/参考图(仅 image/video 草稿)
  const draftAppliedRef = useRef(false);
  useEffect(() => {
    if (draftAppliedRef.current || !engine || !draft) return;
    if (draft.target !== "image" && draft.target !== "video") return;
    draftAppliedRef.current = true;
    if (draft.prompt) {
      setPromptByEngine((prev) => ({ ...prev, [engine.id]: draft.prompt }));
    }
    if (draft.refImage) {
      setRefByEngine((prev) => ({ ...prev, [engine.id]: draft.refImage ?? null }));
    }
  }, [engine, draft]);

  // 会话历史(不落库,刷新清空)
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const runningIdRef = useRef<string | null>(null);
  const runningPromptIdRef = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /**
   * 裁切链轮询:done 时 post_status=processing(trim/extend 后台裁切中),
   * 当前 paths 是未裁原片;10s 间隔轮询 /api/jobs,post_status 清零后写回终产物。
   * 30min 封顶(extend 多段长链);超时/失败清标记回落原片展示(诚实降级)。
   */
  async function pollFinalResult(entryId: string, promptId: string): Promise<void> {
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 10_000));
      if (Date.now() > deadline) break;
      try {
        const res = await apiFetch("/api/jobs?limit=200", { headers: authHeaders() });
        if (!res.ok) continue;
        const jobs = (await res.json()) as JobItem[];
        const job = jobs.find((j) => j.prompt_id === promptId);
        if (!job) continue;
        if (job.status === "done" && job.post_status !== "processing") {
          setEntries((prev) =>
            prev.map((e) =>
              e.id === entryId
                ? { ...e, paths: job.results?.length ? job.results : e.paths, postProcessing: false }
                : e,
            ),
          );
          invalidateJobs(); // 终产物已回写,作品库刷新
          return;
        }
      } catch {
        /* 网络抖动下轮再试 */
      }
    }
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, postProcessing: false } : e)));
  }

  const gen = useGeneration({
    onDone: (paths) => {
      const id = runningIdRef.current;
      runningIdRef.current = null;
      runningPromptIdRef.current = null;
      if (id) {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "done", paths } : e)));
      }
      invalidateJobs(); // 产物已落库,作品库缓存失效
    },
    onError: (msg, detail) => {
      const id = runningIdRef.current;
      runningIdRef.current = null;
      runningPromptIdRef.current = null;
      if (id) {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "error", error: msg, errorDetail: detail ?? null } : e)));
      }
    },
    // 裁切链进行中(done 先于终产物):标记条目转「精确裁切中」并起轮询
    onPostProcessing: () => {
      const id = runningIdRef.current;
      const promptId = runningPromptIdRef.current;
      if (!id || !promptId) return;
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, postProcessing: true } : e)));
      void pollFinalResult(id, promptId);
    },
  });

  const canSubmit =
    !!engine &&
    engine.available &&
    positive.trim().length > 0 &&
    !gen.isRunning &&
    !submitting &&
    (!imageParam || (multiImage ? refImages.length > 0 : !!refImage)) &&
    (!audioParam || !!refAudio) &&
    (!videoParam || !!refVideo);

  /** 取数值参数(仅有限 number 有效,其余视为未设置)。 */
  const numVal = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  /** 提交一次生成:引擎/提示词显式传入,参数/参考图取该引擎分槽快照(onGenerate 与失败重试共用)。 */
  async function submitGeneration(target: EngineInfo, promptText: string) {
    setSubmitError(null);
    setSubmitting(true);
    const targetValues = { ...engineDefaults(target), ...(valuesByEngine[target.id] ?? {}) };
    try {
      const res = await submitEngineGeneration({
        engine: target,
        positive: promptText,
        values: targetValues,
        refImage: refByEngine[target.id] ?? null,
        refImages: refsByEngine[target.id] ?? [],
        refAudio: audioByEngine[target.id] ?? null,
        refVideo: videoByEngine[target.id] ?? null,
      });
      const entry: HistoryEntry = {
        id: newEntryId(),
        engineId: target.id,
        engineLabel: target.label,
        kind: target.kind,
        prompt: promptText,
        status: "running",
        paths: [],
        // 裁切链终产物轮询的寻址键(post_status=processing 时启用)
        promptId: res.prompt_id,
        // 时长策略提示(网格精确裁切/分段续写时后端返回;结果区 muted 一行)
        notice: res.duration_notice ?? null,
        width: numVal(targetValues["width"]),
        height: numVal(targetValues["height"]),
        createdAt: Date.now(),
      };
      setEntries((prev) => [entry, ...prev]);
      setSelectedId(entry.id);
      runningIdRef.current = entry.id;
      runningPromptIdRef.current = res.prompt_id ?? null;
      // start 永远 resolve:出错经 onError 回调更新条目状态
      await gen.start(res, { label: target.label });
    } catch (e) {
      // 提交阶段失败(参数校验/网络/上传缺失):不入历史,直接显示错误(已知模式包装为友好文案)
      const raw = e instanceof Error ? e.message : "生成请求失败";
      setSubmitError(friendlyError(raw).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onGenerate() {
    if (!engine || !canSubmit) return;
    await submitGeneration(engine, positive.trim());
  }

  /** 失败重试:切回该条目的引擎/提示词(参数取该引擎分槽快照),重新提交。 */
  function onRetry(entry: HistoryEntry) {
    if (gen.isRunning || submitting) return;
    const target = (engines ?? []).find((e) => e.id === entry.engineId) ?? null;
    if (!target || !target.available) {
      setSubmitError("该引擎当前不可用,无法重试");
      return;
    }
    if (!lockedKind && target.kind !== mode) setMode(target.kind);
    setEngineIdByKind((prev) => ({ ...prev, [target.kind]: target.id }));
    setPromptByEngine((prev) => ({ ...prev, [target.id]: entry.prompt }));
    void submitGeneration(target, entry.prompt);
  }

  function onCancel() {
    const id = runningIdRef.current;
    runningIdRef.current = null;
    gen.reset(); // 关闭 SSE;后端作业仍继续,完成后可在作品库查看
    if (id) {
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "cancelled" } : e)));
    }
  }

  /**
   * 空态快速开始卡(T3):选中对应引擎并聚焦提示词框。
   * 目标引擎在另一分组(文生/图生)时先切组,否则选择经 visibleEngines 解析会
   * 落回当前组第一个可用引擎(点了 LongCat 却选中别人的歧义)。
   */
  function onQuickStart(engineId: string) {
    const target = kindEngines.find((e) => e.id === engineId);
    if (target) {
      const targetGroup = engineNeedsImage(target) === null ? "gen" : "edit";
      if (showGroupTabs && group !== targetGroup) {
        setGroupByKind((prev) => ({ ...prev, [mode]: targetGroup }));
      }
      setEngineIdByKind((prev) => ({ ...prev, [mode]: engineId }));
    }
    promptInputRef.current?.focus();
  }

  // 舞台容器 ←/→ 方向键:在会话条目间切换选中(输入控件内的按键不拦截)
  function onResultsKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (entries.length === 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    const currentIdx = entries.findIndex((x) => x.id === (selectedId ?? entries[0].id));
    const idx = currentIdx < 0 ? 0 : currentIdx;
    const next =
      e.key === "ArrowLeft" ? Math.max(0, idx - 1) : Math.min(entries.length - 1, idx + 1);
    setSelectedId(entries[next].id);
  }

  const uploadKind =
    engine?.id === "img2img" || engine?.id === "nsfw-img2img"
      ? "img2img"
      : engine?.id === "h3-i2v"
        ? "h3_i2v"
        : engine?.id === "ltx-nsfw-lipsync"
          ? "ltx_lipsync"
          : engine?.id === "wan-animate"
            ? "wan_animate"
            : engine?.id === "wan-vace"
              ? "wan_vace"
              : "ltx_i2v";

  return (
    <div className="generate-view">
      {/* 2026-08-18 页头整体移除:灵动岛已指示当前板块,工作台首屏全给舞台
          (kind 语义由导航高亮承载;hideHeader prop 已随之退役) */}

      <div className="generate-body">
        {/* 舞台列(2026-08-17 停靠布局):结果面板 + 提示词条同列纵排,与参数列并排成行,
            互不遮挡——替代「全出血舞台 + 浮板叠加」 */}
        <div className="generate-stage-col">
        <section
          className="generate-results"
          aria-label="生成结果"
          tabIndex={0}
          onKeyDown={onResultsKeyDown}
        >
          <ResultPanel
            entries={entries}
            selectedId={selectedId}
            onSelect={setSelectedId}
            liveProgress={gen.progress}
            qualityWarning={gen.qualityWarning}
            onApplyPrompt={(text) => {
              if (!engine) return;
              setPromptByEngine((prev) => ({ ...prev, [engine.id]: text }));
            }}
            onCancel={onCancel}
            onRetry={onRetry}
            kind={mode}
            quickStartEngines={kindEngines}
            onQuickStart={onQuickStart}
          />
        </section>

        <PromptBar
          value={positive}
          onChange={(v) => {
            if (!engine) return;
            setPromptByEngine((prev) => ({ ...prev, [engine.id]: v }));
          }}
          disabled={gen.isRunning}
          inputRef={promptInputRef}
          engine={engine}
          engines={visibleEngines}
          onEngineChange={(id) => setEngineIdByKind((prev) => ({ ...prev, [mode]: id }))}
          sizeParams={showSizeChip ? sizeParams : []}
          values={values}
          onValueChange={setValue}
          optimizeKind={optimizeKind}
          onOptimized={(text, negative) => {
            if (!engine) return;
            setPromptByEngine((prev) => ({ ...prev, [engine.id]: text }));
            if (negative && engineSupportsNegative(engine)) {
              setValue("negative", negative);
              // 可见化:展开高级参数抽屉(若已挂载)并提示,避免用户不知道负向已自动填入
              if (advDetailsRef.current) advDetailsRef.current.open = true;
              toast.success("已自动填入负向提示词,可在「高级参数」中调整");
            }
          }}
          canSubmit={canSubmit}
          isRunning={gen.isRunning}
          submitting={submitting}
          submitError={submitError}
          onClearError={() => setSubmitError(null)}
          onGenerate={() => void onGenerate()}
          onCancel={onCancel}
        />
        </div>

        {paramsOpen && (
          <aside className="generate-params" aria-label="参数台">
            {/* 头部固定在滚动区外(Inspector 语言):内容超高滚动时标题不再被裁剪,
                引擎名副标题取代原「生成参数」大标题(与分组标题不再重复) */}
            <div className="generate-params-head">
              <div className="generate-params-heading">
                <span className="generate-params-title">参数台</span>
                {engine && (
                  <span className="generate-params-sub" title={engine.label}>
                    {engine.label}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="generate-params-close"
                onClick={() => setParamsOpen(false)}
                aria-expanded={true}
                aria-label="收起参数面板"
                title="收起参数面板"
              >
                <Icon name="panel-right" size={14} />
              </button>
            </div>
            <div className="generate-params-body">
            {engines === null && !enginesError ? (
              <>
                <Skeleton height={32} />
                <Skeleton height={72} />
                <Skeleton height={32} />
                <Skeleton height={32} />
              </>
            ) : enginesError ? (
              /* P1-2 收编:引擎列表异步加载错误走共享 ErrorBar(原自写 generate-error 文本) */
              <ErrorBar message={enginesError} onClose={() => setEnginesError(null)} />
            ) : kindEngines.length === 0 ? (
              <p className="generate-error">当前上下文没有可用的{KIND_LABEL[mode]}引擎</p>
            ) : (
              <>
                <div className="params-section">
                  {showGroupTabs && (
                    /* 文生/图生段控 = 模式(非引擎):独立小节标题「模式」,与下方引擎下拉区分,
                       消除「引擎」标签连续出现两次的歧义(2026-08-16 审计;图像/视频页同一组件,同步生效) */
                    <>
                      <h3 className="params-section-title">模式</h3>
                      <div
                        className="at-seg generate-group-seg"
                        role="tablist"
                        aria-label={mode === "image" ? "文生图或图生图" : mode === "video" ? "文生视频或图生视频" : "生成或编辑"}
                      >
                        {(["gen", "edit"] as const).map((g) => (
                          <button
                            key={g}
                            type="button"
                            role="tab"
                            aria-selected={group === g}
                            className={`at-seg-btn${group === g ? " is-active" : ""}`}
                            onClick={() => setGroupByKind((prev) => ({ ...prev, [mode]: g }))}
                          >
                            {GROUP_LABEL[mode][g]}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {/* 引擎行:下拉 + ⓘ 说明卡入口(T2)。描述/出处不再平铺首屏,
                      收进 EngineInfoCard(点击展开,面板更贴合 Inspector 密度) */}
                  <div className="engine-select-row">
                    <Field label="引擎">
                      <Select
                        value={engine?.id ?? ""}
                        onChange={(e) => setEngineIdByKind((prev) => ({ ...prev, [mode]: e.target.value }))}
                        aria-label="选择引擎"
                      >
                        {visibleEngines.map((e) => (
                          <option
                            key={e.id}
                            value={e.id}
                            disabled={!e.available}
                            title={e.available ? undefined : e.unavailable_reason}
                          >
                            {e.label}
                            {e.available ? "" : ` — 不可用:${e.unavailable_reason ?? "未知原因"}`}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {engine && (
                      <button
                        type="button"
                        ref={engineInfoBtnRef}
                        className={`engine-info-btn${engineInfoOpen ? " is-open" : ""}`}
                        onClick={() => setEngineInfoOpen((v) => !v)}
                        aria-expanded={engineInfoOpen}
                        aria-label={`引擎说明:${engine.label}`}
                        title="引擎说明"
                      >
                        <Icon name="info" size={14} />
                      </button>
                    )}
                  </div>

                  {engine && (
                    <div className="engine-status">
                      <Badge tone={engine.available ? "ok" : "warn"}>
                        {engine.available ? "可用" : "不可用"}
                      </Badge>
                      {engine.nsfw && <Badge tone="warn">R18</Badge>}
                      {!engine.available && engine.unavailable_reason && (
                        <span className="engine-status-reason">{engine.unavailable_reason}</span>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm engine-refresh"
                        onClick={() => void onRefreshEngines()}
                        disabled={refreshingEngines}
                        title="强制后端重新探测全部引擎可用性"
                      >
                        <Icon name={refreshingEngines ? "loading" : "refresh"} size={13} />
                        {refreshingEngines ? "检测中…" : "重新检测"}
                      </button>
                    </div>
                  )}

                  {engine && recipes.length > 0 && (
                    <div className="recipes-section">
                      <h3 className="params-section-title">社区精选配方</h3>
                      <p className="recipes-hint">
                        来自社区作品的成熟参数组合(CivitAI 逆向),点击一键回填提示词与 LoRA,可再修改。
                      </p>
                      <div className="recipes-list">
                        {recipes.map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            className="recipe-chip"
                            onClick={() => applyRecipe(r)}
                            disabled={gen.isRunning}
                            title={r.source}
                          >
                            {r.nsfw && (
                              <span className="recipe-nsfw-badge" aria-label="R18 配方">
                                R18
                              </span>
                            )}
                            <span className="recipe-chip-label">{r.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {engine && (imageParam || audioParam || videoParam) && (
                  <div className="params-section">
                    <h3 className="params-section-title">参考输入</h3>
                    {imageParam && multiImage && (
                      <RefImagesUpload
                        param={imageParam}
                        values={refImages}
                        uploadKind={uploadKind}
                        disabled={gen.isRunning}
                        onChange={(v) => setRefsByEngine((prev) => ({ ...prev, [engine.id]: v }))}
                      />
                    )}
                    {imageParam && !multiImage && (
                      <RefImageUpload
                        param={imageParam}
                        value={refImage}
                        uploadKind={uploadKind}
                        disabled={gen.isRunning}
                        onChange={(v) => {
                          setRefByEngine((prev) => ({ ...prev, [engine.id]: v }));
                          // 参考图换机后,已上传音频/视频若钉在旧 worker 会跨机取不到 → 强制重传
                          if (refAudio && v?.worker !== refAudio.worker) {
                            setAudioByEngine((prev) => ({ ...prev, [engine.id]: null }));
                          }
                          if (refVideo && v?.worker !== refVideo.worker) {
                            setVideoByEngine((prev) => ({ ...prev, [engine.id]: null }));
                          }
                        }}
                      />
                    )}
                    {audioParam && (
                      <RefAudioUpload
                        param={audioParam}
                        value={refAudio}
                        uploadKind={uploadKind}
                        pinWorker={refImage?.worker ?? null}
                        disabled={gen.isRunning}
                        onChange={(v) => setAudioByEngine((prev) => ({ ...prev, [engine.id]: v }))}
                      />
                    )}
                    {videoParam && (
                      <RefVideoUpload
                        param={videoParam}
                        value={refVideo}
                        uploadKind={uploadKind}
                        pinWorker={refImage?.worker ?? null}
                        disabled={gen.isRunning}
                        onChange={(v) => setVideoByEngine((prev) => ({ ...prev, [engine.id]: v }))}
                      />
                    )}
                  </div>
                )}

                {/* T1 Inspector 分组卡:模型与引擎 / 画幅与时长 / 采样 / LoRA 叠加,
                    空组不渲染;组间 hairline 由 .params-section + .params-section 承担 */}
                {paramGroups &&
                  PARAM_PANEL_GROUPS.map(
                    (g) =>
                      paramGroups[g.id].length > 0 && (
                        <div className="params-section" key={g.id}>
                          <h3 className="params-section-title">{g.label}</h3>
                          {paramGroups[g.id].map((p) => (
                            <ParamField
                              key={p.key}
                              param={p}
                              value={values[p.key]}
                              disabled={gen.isRunning}
                              onChange={handleParamChange}
                            />
                          ))}
                        </div>
                      ),
                  )}

                {engine && showAdvanced && (
                  <details className="adv-params" ref={advDetailsRef}>
                    <summary>
                      高级参数
                      <span className="adv-chevron">
                        <Icon name="chevron-down" size={13} />
                      </span>
                    </summary>
                    <div className="adv-params-body">
                      {engineSupportsNegative(engine) && (
                        <Field label="负向提示词">
                          <Textarea
                            ref={negativeRef}
                            rows={2}
                            value={String(values["negative"] ?? "")}
                            placeholder="描述不想要的内容,可留空"
                            disabled={gen.isRunning}
                            onChange={(e) => setValue("negative", e.target.value)}
                          />
                        </Field>
                      )}
                      {advancedParams.map((p) => (
                        <ParamField
                          key={p.key}
                          param={p}
                          value={values[p.key]}
                          disabled={gen.isRunning}
                          onChange={handleParamChange}
                        />
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
            </div>
          </aside>
        )}

        {/* 引擎说明卡(T2):Popover portal 浮层,实底发夹线语言(stage.css .engine-info-pop) */}
        {engine && (
          <Popover
            open={engineInfoOpen}
            anchorRef={engineInfoBtnRef}
            onClose={() => setEngineInfoOpen(false)}
            width={300}
            className="engine-info-pop"
            role="dialog"
            ariaLabel={`引擎说明:${engine.label}`}
          >
            <EngineInfoCard engine={engine} />
          </Popover>
        )}

        {!paramsOpen && (
          /* 参数 FAB(UI-A 动效原语):Ripple radius="full" 圆形水波纹;
             定位/z-index 挂在 Ripple 宿主层(.generate-params-fab,见 stage.css 注释),
             视觉圆形在内层 .generate-params-fab-btn;reduced-motion 自动退化 */
          <Ripple radius="full" className="generate-params-fab">
            <button
              type="button"
              className="generate-params-fab-btn"
              onClick={() => setParamsOpen(true)}
              aria-expanded={false}
              aria-label="展开参数面板"
              title="展开参数面板"
            >
              <Icon name="sliders" size={18} />
            </button>
          </Ripple>
        )}
      </div>
    </div>
  );
}

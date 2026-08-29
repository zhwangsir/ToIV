"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Field, Select, Textarea } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Popover } from "@/components/ui/Popover";
import { Ripple } from "@/components/ui/Ripple";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { usePoll } from "@/hooks/usePoll";
import { useAutoResize } from "@/hooks/useAutoResize";
import { cancelJob, invalidateJobs, apiFetch, authHeaders, imageUrl, listRecipes, listStylePresets, resolveEntityRefs, type CommunityRecipe, type EntityItem } from "@/lib/api";
import type { JobItem, StylePreset } from "@/lib/types";
import { consumeEngineDraft, type EngineDraft } from "@/lib/engine";
import { resolveEntityIds, useEntities } from "@/lib/entities";
import { presetParamPatch } from "@/lib/presetApply";
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
import { EntityPicker, entityCover } from "@/components/entities/EntityPicker";
import { KeyframeChainEditor } from "./KeyframeChainEditor";
import { AiVideoEditView } from "@/components/video-edit/AiVideoEditView";
import { MotionBrushEditor } from "@/components/motion-brush/MotionBrushEditor";
import { MultiShotEditor } from "./MultiShotEditor";
import { ParamField } from "./ParamField";
import { applyAspectPair } from "@/lib/aspectPair";
import { PARAM_PANEL_GROUPS, groupEngineParams } from "./paramGroups";
import { PromptBar } from "./PromptBar";
import { RefAudioUpload, type UploadedAudio } from "./RefAudioUpload";
import { RefImageUpload, type UploadedRef } from "./RefImageUpload";
import { RefImagesUpload } from "./RefImagesUpload";
import { RefVideoUpload, type UploadedVideo } from "./RefVideoUpload";
import { ResultPanel, type HistoryEntry } from "./ResultPanel";
import {
  clampH3ValuesOnExtendToggle,
  h3HistoryPresentation,
  h3PayloadWentI2v,
  h3TrackerParentPromptId,
  isOrdinaryH3Video,
  overlayOrdinaryH3DurationParams,
} from "@/lib/h3VideoUx";
import {
  img2imgPartnerId,
  txt2imgHistoryPresentation,
  txt2imgPayloadWentImg2img,
} from "@/lib/txt2imgCoverUx";

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

/** Motion Brush 局部动效支持的引擎(VACE 链路,:8197 input_masks);其余引擎不开放入口。 */
const MOTION_BRUSH_ENGINES: ReadonlySet<string> = new Set(["wan-vace", "wan-transition"]);

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
  // hydration 安全:首渲(SSR 与客户端水合)恒为展开,挂载后按实际视口校正,
  // 避免 useState 初始化读 matchMedia 导致服务端/客户端首渲不一致。
  const [paramsOpen, setParamsOpen] = useState(true);
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia(`(max-width: ${BREAKPOINTS.lg - 1}px)`).matches
    ) {
      setParamsOpen(false);
    }
  }, []);
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
    () => (engines ?? []).filter((e) => e.kind === mode && !e.hidden),
    [engines, mode],
  );

  // 板块内「生成 | 编辑」分组(数据驱动:params 含 images 或 video 类型 = 编辑组,否则生成组;
  // video 规则为 vace-edit 视频到视频编辑而加,此前无仅 video 参数的引擎)。
  // 两组都有引擎时才显示段控(如音频板块当前仅 ace-music 生成组,段控自动不显示)。
  const genGroup = useMemo(
    () => kindEngines.filter((e) => engineNeedsImage(e) === null && engineNeedsVideo(e) === null),
    [kindEngines],
  );
  const editGroup = useMemo(
    () => kindEngines.filter((e) => engineNeedsImage(e) !== null || engineNeedsVideo(e) !== null),
    [kindEngines],
  );
  const showGroupTabs = genGroup.length > 0 && editGroup.length > 0;
  const [groupByKind, setGroupByKind] = useState<Partial<Record<EngineKind, "gen" | "edit">>>({});
  const group = groupByKind[mode] ?? "gen";
  const visibleEngines = useMemo(() => {
    const rows = showGroupTabs ? (group === "gen" ? genGroup : editGroup) : kindEngines;
    // 2026-08-29:LTX/Wan 进阶沉底,H3 等普通引擎排前
    return [...rows].sort((a, b) => Number(Boolean(a.advanced)) - Number(Boolean(b.advanced)));
  }, [showGroupTabs, group, genGroup, editGroup, kindEngines]);

  const [engineIdByKind, setEngineIdByKind] = useState<Partial<Record<EngineKind, string>>>({});
  const engine = useMemo(() => {
    const sel = engineIdByKind[mode];
    return (
      visibleEngines.find((e) => e.id === sel && e.available) ??
      // R18:优先 nsfw 的 H3 默认(h3-nsfw-t2v,带 R18 LoRA 预设);否则 SFW H3;再否则非进阶
      visibleEngines.find((e) => e.available && e.ordinary_default && e.nsfw) ??
      visibleEngines.find((e) => e.available && e.ordinary_default) ??
      visibleEngines.find((e) => e.available && !e.advanced) ??
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
  // Motion Brush 局部动效 mask(按引擎分槽保存文件名;VACE 链路引擎可用,
  // 由 MotionBrushEditor 生成后回填;参考图变更时失效清除)
  const [motionMaskByEngine, setMotionMaskByEngine] = useState<Record<string, string>>({});
  const [motionBrushOpen, setMotionBrushOpen] = useState(false);

  // 三层联动:风格预设清单(回显推荐参数 + skill 预选用;swr 长缓存,失败静默降级)
  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  useEffect(() => {
    let cancelled = false;
    listStylePresets()
      .then((ps) => {
        if (!cancelled) setStylePresets(ps);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
  // 关键帧链式转场:选中 keyframe-chain 引擎时,舞台列渲染 KeyframeChainEditor 专用编辑器
  // (替代 PromptBar;槽位/逐段参数/提交进度全部自承载),参数台的标准分组同步让位
  const isChain = engine?.id === "keyframe-chain";
  // H3 多镜头:选中 h3-multishot 引擎时,舞台列渲染 MultiShotEditor 专用编辑器
  // (镜头卡/逐镜头时长/总时长护栏/提交自承载),参数台标准分组同步让位
  const isMultiShot = engine?.id === "h3-multishot";
  // VACE 视频编辑:选中 vace-edit 引擎时,舞台列渲染 AiVideoEditView 专用编辑器
  // (源视频/编辑模式/指令/关键帧锚点/区域 mask/并排对比自承载),参数台标准分组同步让位
  const isVaceEdit = engine?.id === "vace-edit";
  // 专用编辑器引擎(链/多镜头/视频编辑):标准 PromptBar 与参数分组让位
  const customEditor = isChain || isMultiShot || isVaceEdit;
  // Motion Brush 局部动效:仅 VACE 链路(:8197,VACEEncode.input_masks)支持;
  // H3 节点无 mask 输入、SCoPE 服务契约无 mask 字段,均不开放(后端同规则)
  const motionBrushSupported = engine ? MOTION_BRUSH_ENGINES.has(engine.id) : false;
  const motionMask = engine ? motionMaskByEngine[engine.id] ?? "" : "";

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
  const displayParams = useMemo(
    () => (engine ? overlayOrdinaryH3DurationParams(engine, values) : []),
    [engine, values],
  );
  const paramGroups = useMemo(
    () => (engine ? groupEngineParams(displayParams, { sizeChip: showSizeChip }) : null),
    [displayParams, showSizeChip, engine],
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

  // 三层联动:当前预设 id(优化注入用)+ 预设推荐 skill(智能预选用)
  const currentStylePreset =
    typeof values.style_preset === "string" && values.style_preset
      ? values.style_preset
      : undefined;
  const currentRecommendedSkill = currentStylePreset
    ? stylePresets.find((p) => p.id === currentStylePreset)?.recommended_skill || undefined
    : undefined;

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
    if (key === "segment_extend" && isOrdinaryH3Video(engine.id)) {
      const patch = clampH3ValuesOnExtendToggle(values, Boolean(v));
      setValuesByEngine((prev) => ({
        ...prev,
        [engine.id]: { ...(prev[engine.id] ?? {}), ...patch },
      }));
      return;
    }
    // 三层联动:选中风格预设时即时回显推荐参数(所见即所得,后可继续微调);
    // 切回「不使用」不回滚参数(避免误清用户已调好的值)
    if (key === "style_preset" && typeof v === "string" && v) {
      const preset = stylePresets.find((p) => p.id === v);
      if (preset) {
        const patch = presetParamPatch(preset, valuesByEngine[engine.id] ?? {});
        setValuesByEngine((prev) => ({
          ...prev,
          [engine.id]: { ...(prev[engine.id] ?? {}), ...patch },
        }));
        return;
      }
    }
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
    // 关键帧链/多镜头/视频编辑引擎由专用编辑器自承载提交(标准链路永不触发)
    engine.id !== "keyframe-chain" &&
    engine.id !== "h3-multishot" &&
    engine.id !== "vace-edit" &&
    // wan-animate-2 提示词可留空(后端自动反推参考图外观 caption,官方提示词要求)
    (engine.id === "wan-animate-2" || positive.trim().length > 0) &&
    !gen.isRunning &&
    !submitting &&
    (!imageParam || (multiImage ? refImages.length > 0 : !!refImage)) &&
    // 首尾帧转场必须恰好 2 张(第 1 张首帧,第 2 张尾帧),缺一张不可提交
    (engine.id !== "wan-transition" || refImages.length === 2) &&
    (!audioParam || !!refAudio) &&
    (!videoParam || !!refVideo);

  /** 取数值参数(仅有限 number 有效,其余视为未设置)。 */
  const numVal = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  // 主体库(@主体引用):提交时把 prompt 里的 @实体名 解析为 entity_ids(提及首现序),
  // 后端 h3_refs 按此序在绝对开头注入 @图片N 引用行;清单与 PromptBar 选择器共享缓存
  const subjectEntities = useEntities();

  // 「引用主体」多选(P1 全局主体库):选中后主体图经 resolve-refs 钉到同机 worker
  // 注入参考图链,prompt_hint 注入提示词;entityRefFiles 记 entity_id→注入文件名,
  // 移除 chip 时同步摘除对应参考图
  const [entityPickerOpen, setEntityPickerOpen] = useState(false);
  const [pickedEntities, setPickedEntities] = useState<EntityItem[]>([]);
  const [entityRefFiles, setEntityRefFiles] = useState<Record<string, string[]>>({});
  const [entityResolving, setEntityResolving] = useState(false);

  /** 引用主体确认:提示词注入 prompt_hint;有图引擎把主体图注入参考图链(钉同机 worker)。
   *  txt2img 无 images 槽:有封面且未上传图时解析封面后切到对应 img2img(对齐 H3 t2v→i2v)。 */
  async function applyPickedEntities(selected: EntityItem[]) {
    if (!engine || selected.length === 0) return;
    const merged = [...pickedEntities];
    for (const e of selected) {
      if (!merged.some((m) => m.id === e.id)) merged.push(e);
    }
    setPickedEntities(merged);

    // ① prompt_hint(空回退 description)注入提示词,同名片段去重
    const hints = selected
      .map((e) => (e.prompt_hint || e.description || "").trim())
      .filter((h) => h.length > 0);
    if (hints.length > 0) {
      setPromptByEngine((prev) => {
        const cur = prev[engine.id] ?? "";
        const add = hints.filter((h) => !cur.includes(h));
        if (add.length === 0) return prev;
        const sep = cur.trim().length > 0 ? ", " : "";
        return { ...prev, [engine.id]: `${cur}${sep}${add.join(", ")}` };
      });
    }

    // ② 主体图注入参考图链。txt2img 无槽:有封面且未上传图 → 解析成功后再切 img2img。
    const withImage = selected.filter((e) => entityCover(e));
    const hasUploaded = multiImage ? refImages.length > 0 : !!refImage;
    const partnerId = img2imgPartnerId(engine.id);
    const partner =
      partnerId && !hasUploaded && withImage.length > 0
        ? ((engines ?? []).find((e) => e.id === partnerId && e.available) ?? null)
        : null;
    const injectEngine = partner ?? engine;
    const injectImageParam = engineNeedsImage(injectEngine);
    const injectMulti = engineMaxImages(injectEngine) > 1;
    if (!injectImageParam || withImage.length === 0) {
      if (withImage.length === 0) toast.info(`已引用 ${merged.length} 个主体(无参考图,仅注入提示词)`);
      return;
    }
    setEntityResolving(true);
    try {
      const pin = injectMulti
        ? (refsByEngine[injectEngine.id] ?? [])[0]?.worker
        : refByEngine[injectEngine.id]?.worker;
      const r = await resolveEntityRefs({
        entity_ids: withImage.map((e) => e.id),
        kind: partner ? "img2img" : uploadKind,
        ...(pin ? { worker: pin } : {}),
      });
      if (partner && r.refs.length > 0) {
        // 封面解析成功才切引擎,失败/无图仍停在 txt2img(普通文生不破)
        setGroupByKind((prev) => ({ ...prev, [mode]: "edit" }));
        setEngineIdByKind((prev) => ({ ...prev, [mode]: partner.id }));
        setValuesByEngine((prev) => (prev[partner.id] ? prev : { ...prev, [partner.id]: prev[engine.id] ?? {} }));
        setPromptByEngine((prev) => {
          const dest = prev[partner.id] ?? "";
          const src = prev[engine.id] ?? "";
          return dest.trim() ? prev : { ...prev, [partner.id]: src };
        });
      }
      const max = engineMaxImages(injectEngine);
      const filesByEntity: Record<string, string[]> = {};
      const newRefs: UploadedRef[] = r.refs.map((h) => {
        filesByEntity[h.entity_id] = [...(filesByEntity[h.entity_id] ?? []), h.filename];
        const src = withImage.find((e) => e.id === h.entity_id);
        return {
          filename: h.filename,
          worker: h.worker,
          previewUrl: src ? imageUrl(entityCover(src)) : "",
          name: h.name,
        };
      });
      if (injectMulti) {
        setRefsByEngine((prev) => {
          const cur = prev[injectEngine.id] ?? [];
          const seen = new Set(cur.map((v) => v.filename));
          const add = newRefs.filter((v) => !seen.has(v.filename));
          return { ...prev, [injectEngine.id]: [...cur, ...add].slice(0, max) };
        });
      } else {
        setRefByEngine((prev) =>
          prev[injectEngine.id] ? prev : { ...prev, [injectEngine.id]: newRefs[0] ?? null },
        );
      }
      setEntityRefFiles((prev) => {
        const next = { ...prev };
        for (const [eid, files] of Object.entries(filesByEntity)) {
          next[eid] = [...(next[eid] ?? []), ...files];
        }
        return next;
      });
      const skippedNote = r.skipped.length > 0 ? `,${r.skipped.length} 个跳过` : "";
      toast.success(`已把 ${r.refs.length} 张主体图加入参考图${skippedNote}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "主体参考图解析失败");
    } finally {
      setEntityResolving(false);
    }
  }

  /** 移除已引用主体:同步摘除其注入的参考图(提示词已注入文本不回收,可手改)。 */
  function removePickedEntity(eid: string) {
    setPickedEntities((prev) => prev.filter((e) => e.id !== eid));
    const files = entityRefFiles[eid] ?? [];
    if (files.length > 0 && engine) {
      setRefsByEngine((prev) => ({
        ...prev,
        [engine.id]: (prev[engine.id] ?? []).filter((v) => !files.includes(v.filename)),
      }));
      setRefByEngine((prev) => {
        const cur = prev[engine.id];
        return cur && files.includes(cur.filename) ? { ...prev, [engine.id]: null } : prev;
      });
    }
    setEntityRefFiles((prev) => {
      const next = { ...prev };
      delete next[eid];
      return next;
    });
  }

  /** 提交一次生成:引擎/提示词显式传入,参数/参考图取该引擎分槽快照(onGenerate 与失败重试共用)。 */
  async function submitGeneration(target: EngineInfo, promptText: string) {
    setSubmitError(null);
    setSubmitting(true);
    const targetValues = { ...engineDefaults(target), ...(valuesByEngine[target.id] ?? {}) };
    try {
      const pickedIds = pickedEntities.map((e) => e.id);
      const mentionIds = resolveEntityIds(promptText, subjectEntities);
      const entityIds =
        pickedIds.length > 0
          ? [...pickedIds, ...mentionIds.filter((id) => !pickedIds.includes(id))]
          : mentionIds;
      let submitRef = refByEngine[target.id] ?? null;
      let submitEngine = target;
      let submitValues = targetValues;
      const isH3T2V = target.id === "h3-t2v" || target.id === "h3-nsfw-t2v";
      if (isH3T2V && !submitRef) {
        const cover = pickedEntities.find((e) => entityCover(e));
        if (cover) {
          try {
            const r = await resolveEntityRefs({ entity_ids: [cover.id], kind: "h3_i2v" });
            if (r.refs[0]) {
              submitRef = { filename: r.refs[0].filename, worker: r.refs[0].worker };
            }
          } catch {
            /* 解析失败不阻塞:后端 t2v+entity_ids 仍会尝试转 i2v */
          }
        }
      }
      const imgPartner = img2imgPartnerId(target.id);
      if (imgPartner && !submitRef) {
        const cover = pickedEntities.find((e) => entityCover(e));
        if (cover) {
          try {
            const r = await resolveEntityRefs({ entity_ids: [cover.id], kind: "img2img" });
            if (r.refs[0]) {
              submitRef = { filename: r.refs[0].filename, worker: r.refs[0].worker };
              const partner = (engines ?? []).find((e) => e.id === imgPartner);
              submitEngine = partner ?? { ...target, id: imgPartner };
              submitValues = {
                ...engineDefaults(submitEngine),
                ...(valuesByEngine[target.id] ?? {}),
                ...(valuesByEngine[submitEngine.id] ?? {}),
              };
            }
          } catch {
            /* 解析失败不阻塞:保持 txt2img */
          }
        }
      }
      const res = await submitEngineGeneration({
        engine: submitEngine,
        positive: promptText,
        values: submitValues,
        refImage: submitRef,
        refImages: refsByEngine[target.id] ?? [],
        refAudio: audioByEngine[target.id] ?? null,
        refVideo: videoByEngine[target.id] ?? null,
        motionMask: motionMaskByEngine[target.id] || undefined,
        entityIds,
      });
      const wentI2v = h3PayloadWentI2v({
        engineId: target.id,
        backendKind: res.kind,
        hasRefImage: Boolean(submitRef),
      });
      const wentImg2img = txt2imgPayloadWentImg2img({
        engineId: target.id,
        submittedEngineId: submitEngine.id,
        hasRefImage: Boolean(submitRef),
      });
      const shown = wentImg2img
        ? txt2imgHistoryPresentation(target, { wentImg2img: true })
        : h3HistoryPresentation(target, { wentI2v });
      const entry: HistoryEntry = {
        id: newEntryId(),
        engineId: shown.engineId,
        engineLabel: shown.engineLabel,
        kind: target.kind,
        prompt: promptText,
        status: "running",
        paths: [],
        // 裁切链终产物轮询的寻址键(post_status=processing 时启用)
        promptId: res.prompt_id,
        // 时长策略提示 + 排队位次 + 超分挂链提示(QUEUE/RES-2026-08-18)
        notice:
          [
            res.duration_notice ?? null,
            typeof res.queued_behind === "number" && res.queued_behind > 0
              ? `排队中:前方还有 ${res.queued_behind} 个作业,依次自动执行`
              : null,
            res.upscale_notice ?? null,
            res.loras && res.loras.length > 0
              ? `AI 已选配 LoRA: ${res.loras.map((l) => l.name.replace(/\.safetensors$/i, "")).join("、")}`
              : res.lora_mode === "off"
                ? "未叠加 LoRA"
                : null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
        // RES-2026-08-18:融合超分档快照(postProcessing 文案区分「超分中/精确裁切中」)
        upscaleTarget: res.upscale_notice
          ? String(targetValues["resolution_target"] ?? "")
          : undefined,
        width: numVal(targetValues["width"]),
        height: numVal(targetValues["height"]),
        createdAt: Date.now(),
      };
      setEntries((prev) => [entry, ...prev]);
      setSelectedId(entry.id);
      runningIdRef.current = entry.id;
      runningPromptIdRef.current = res.prompt_id ? h3TrackerParentPromptId(res.prompt_id, res.kind) : null;
      // 分段续写/网格裁切:后端 duration_notice 必须 toast,不得只写 muted 结果行
      if (res.duration_notice) {
        toast.info(res.duration_notice);
      }
      // 排队提示(QUEUE-2026-08-18):入队成功即刻告知「这是排队,不是故障」
      if (typeof res.queued_behind === "number" && res.queued_behind > 0) {
        toast.info(
          `已加入 ${target.label} 队列:前方还有 ${res.queued_behind} 个作业,` +
            "完成后自动开始生成(排队等待,非故障)",
        );
      }
      // 超分挂链提示(RES-2026-08-18):原生生成完成后自动二次超分
      if (res.upscale_notice) {
        toast.info(res.upscale_notice);
      }
      if (res.loras && res.loras.length > 0) {
        toast.info(
          `已选配 ${res.loras.length} 个 LoRA: ` +
            res.loras.map((l) => l.name.replace(/\.safetensors$/i, "")).join("、"),
        );
      }
      // start 永远 resolve:出错经 onError 回调更新条目状态
      await gen.start(res, { label: shown.engineLabel });
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
    const promptId = runningPromptIdRef.current;
    runningIdRef.current = null;
    runningPromptIdRef.current = null;
    void (async () => {
      if (promptId) {
        try {
          await cancelJob(promptId);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "中止失败");
        }
      }
      gen.reset();
      if (id) {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "cancelled" } : e)));
      }
    })();
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
        : engine?.id === "avatar-talk"
          ? "avatar"
          : engine?.id === "ltx-nsfw-lipsync"
            ? "ltx_lipsync"
            : engine?.id === "wan-animate"
              ? "wan_animate"
              : engine?.id === "wan-animate-2"
                ? "wan_animate2"
                : engine?.id === "wan-vace"
                  ? "wan_vace"
                  : engine?.id === "wan-transition" || engine?.id === "vace-edit"
                    ? "wan_vace" // 与 VACE 同实例(:8197),复用同一上传 kind
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
            quickStartEngines={[...kindEngines].sort((a, b) => Number(Boolean(a.advanced)) - Number(Boolean(b.advanced)))}
            onQuickStart={onQuickStart}
          />
        </section>

        {isChain ? (
          /* 关键帧链引擎:舞台列渲染专用编辑器(槽位/逐段参数/总时长/提交进度自承载),
             PromptBar 让位(链有逐段提示词,单条输入框不适用) */
          <KeyframeChainEditor />
        ) : isMultiShot ? (
          /* H3 多镜头引擎:舞台列渲染专用编辑器(镜头卡/逐镜头时长/总时长护栏自承载),
             PromptBar 让位(多镜头有逐镜头提示词,单条输入框不适用) */
          <MultiShotEditor loras={values.loras} />
        ) : isVaceEdit ? (
          /* VACE 视频编辑引擎:舞台列渲染专用编辑器(源视频/模式/指令/关键帧锚点/并排对比
             自承载),PromptBar 让位(编辑指令随模式切换示例,通用提示词条不适用) */
          <AiVideoEditView />
        ) : (
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
          stylePreset={currentStylePreset}
          recommendedSkill={currentRecommendedSkill}
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
        )}
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
                            {e.advanced ? "（进阶）" : ""}
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

                {!customEditor && engine && (imageParam || audioParam || videoParam) && (
                  <div className="params-section">
                    <h3 className="params-section-title">参考输入</h3>
                    {imageParam && multiImage && (
                      <RefImagesUpload
                        param={imageParam}
                        values={refImages}
                        uploadKind={uploadKind}
                        disabled={gen.isRunning}
                        onChange={(v) => {
                          setRefsByEngine((prev) => ({ ...prev, [engine.id]: v }));
                          // 参考图变更 → 已生成的 Motion Brush mask 失效(尺寸/内容错位),清除待重标
                          setMotionMaskByEngine((prev) => ({ ...prev, [engine.id]: "" }));
                        }}
                      />
                    )}
                    {/* Motion Brush 局部动效(VACE 链路):涂抹标记运动区域 → mask 接
                        VACEEncode.input_masks;源图 = 第 1 张参考图(与 mask 同 worker 互钉) */}
                    {motionBrushSupported && refImages.length > 0 && (
                      <div className="motion-brush-row">
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Icon name="brush" size={14} />}
                          disabled={gen.isRunning}
                          onClick={() => setMotionBrushOpen(true)}
                        >
                          Motion Brush
                        </Button>
                        {motionMask && (
                          <span className="motion-brush-chip" title={motionMask}>
                            <Icon name="check" size={11} />
                            <span className="motion-brush-chip-name">已标记动效区域</span>
                            <button
                              type="button"
                              className="motion-brush-chip-remove"
                              aria-label="移除动效标记"
                              disabled={gen.isRunning}
                              onClick={() =>
                                setMotionMaskByEngine((prev) => ({ ...prev, [engine.id]: "" }))
                              }
                            >
                              <Icon name="close" size={10} />
                            </button>
                          </span>
                        )}
                        <p className="motion-brush-hint">
                          涂抹指定画面中要动的区域与方向,其余保持静止(可选)。
                        </p>
                      </div>
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

                {/* 主体引用(P1 全局主体库):多选主体 → 主体图钉同机 worker 注入参考图链,
                    prompt_hint 注入提示词;chip 移除同步摘除其注入的参考图 */}
                {!customEditor && engine && (
                  <div className="params-section">
                    <h3 className="params-section-title">主体引用</h3>
                    <div className="entity-ref-row">
                      {pickedEntities.map((e) => (
                        <span key={e.id} className="entity-ref-chip" title={e.prompt_hint || e.description || e.name}>
                          {entityCover(e) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={imageUrl(entityCover(e))} alt={e.name} className="entity-ref-chip-img" />
                          ) : (
                            <Icon name={e.kind === "character" ? "user" : e.kind === "scene" ? "image" : "box"} size={12} />
                          )}
                          <span className="entity-ref-chip-name">{e.name}</span>
                          <button
                            type="button"
                            className="entity-ref-chip-remove"
                            aria-label={`移除主体 ${e.name}`}
                            disabled={gen.isRunning}
                            onClick={() => removePickedEntity(e.id)}
                          >
                            <Icon name="close" size={10} />
                          </button>
                        </span>
                      ))}
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={entityResolving}
                        icon={<Icon name="users" size={14} />}
                        disabled={gen.isRunning}
                        onClick={() => setEntityPickerOpen(true)}
                      >
                        引用主体
                      </Button>
                    </div>
                    <p className="entity-ref-hint">
                      选中后主体图自动加入参考图(钉定同机 worker),主体的提示词描述注入正向提示词。
                    </p>
                  </div>
                )}

                {/* T1 Inspector 分组卡:模型与引擎 / 画幅与时长 / 采样 / LoRA 叠加,
                    空组不渲染;组间 hairline 由 .params-section + .params-section 承担 */}
                {!customEditor &&
                  paramGroups &&
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

                {!customEditor && engine && showAdvanced && (
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

        {/* 主体库多选器(P1):确认后主体图钉同机 worker 注入参考图链 + prompt_hint 注入提示词 */}
        <EntityPicker
          open={entityPickerOpen}
          onClose={() => setEntityPickerOpen(false)}
          selectedIds={pickedEntities.map((e) => e.id)}
          onConfirm={(selected) => void applyPickedEntities(selected)}
        />

        {/* Motion Brush 局部动效编辑器(VACE 链路):源图 = 第 1 张参考图,
            mask 尺寸跟随引擎当前宽高;生成后回填 motionMask 随提交携带 */}
        {motionBrushSupported && refImages.length > 0 && (
          <MotionBrushEditor
            open={motionBrushOpen}
            onClose={() => setMotionBrushOpen(false)}
            sourceImageUrl={refImages[0].previewUrl}
            sourceRef={{ filename: refImages[0].filename, worker: refImages[0].worker }}
            maskWidth={numVal(values["width"]) ?? 832}
            maskHeight={numVal(values["height"]) ?? 480}
            onApply={(maskName) => {
              if (!engine) return;
              setMotionMaskByEngine((prev) => ({ ...prev, [engine.id]: maskName }));
            }}
          />
        )}
      </div>
      <style jsx>{`
        .entity-ref-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: var(--space-2);
        }
        .entity-ref-chip {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 6px;
          border: 1px solid var(--border-subtle);
          border-radius: 999px;
          background: var(--bg-surface-3);
          color: var(--text-secondary);
          font-size: 11px;
          max-width: 160px;
        }
        .entity-ref-chip-img {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
        }
        .entity-ref-chip-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .entity-ref-chip-remove {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          border: none;
          border-radius: 50%;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          padding: 0;
          flex-shrink: 0;
        }
        .entity-ref-chip-remove:hover:not(:disabled) {
          color: var(--text-primary);
        }
        .entity-ref-hint {
          margin: 6px 0 0;
          font-size: 11px;
          color: var(--text-muted);
        }
        .motion-brush-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: var(--space-2);
          margin-top: var(--space-2);
        }
        .motion-brush-chip {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 6px;
          border: 1px solid var(--border-subtle);
          border-radius: 999px;
          background: var(--bg-surface-3);
          color: var(--text-secondary);
          font-size: 11px;
        }
        .motion-brush-chip-name {
          white-space: nowrap;
        }
        .motion-brush-chip-remove {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          border: none;
          border-radius: 50%;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          padding: 0;
          flex-shrink: 0;
        }
        .motion-brush-chip-remove:hover:not(:disabled) {
          color: var(--text-primary);
        }
        .motion-brush-hint {
          flex-basis: 100%;
          margin: 0;
          font-size: 11px;
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
}

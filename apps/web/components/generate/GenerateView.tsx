"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { Field, Select, Textarea } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { usePoll } from "@/hooks/usePoll";
import { invalidateJobs } from "@/lib/api";
import { consumeEngineDraft, type EngineDraft } from "@/lib/engine";
import {
  engineDefaults,
  engineNeedsAudio,
  engineNeedsImage,
  engineSupportsNegative,
  fetchEngines,
  submitEngineGeneration,
  type EngineInfo,
  type EngineKind,
} from "@/lib/engines";
import { useGeneration } from "@/lib/useGeneration";
import { BREAKPOINTS } from "@/lib/useBreakpoint";
import { friendlyError } from "@/lib/friendlyError";

import { ParamField } from "./ParamField";
import { PromptBar } from "./PromptBar";
import { RefAudioUpload, type UploadedAudio } from "./RefAudioUpload";
import { RefImageUpload, type UploadedRef } from "./RefImageUpload";
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
   * NSFW 专区(/nsfw)内嵌时置 true:只展示 nsfw=true 引擎。
   * R18 上下文后端返回全量引擎(含非 nsfw),专区不该混入 SFW 引擎。
   */
  onlyNsfw?: boolean;
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

/** 高级参数抽屉收纳的参数 key(步数/CFG/种子;负向提示词单独判定一并收进)。 */
const ADVANCED_PARAM_KEYS: ReadonlySet<string> = new Set(["steps", "cfg", "seed"]);

/** 尺寸参数 key(两项都存在时吸附到提示词条的尺寸 chip,浮板内不再重复渲染)。 */
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
 * - 参数玻璃浮板:position:absolute 浮于舞台右侧(不占布局列,舞台始终全宽),
 *   收起态为右下角悬浮球;步数/CFG/种子/负向收进「高级参数」折叠区(默认折叠)
 * 提交链路:按引擎 id 路由到既有 API(lib/engines.submitEngineGeneration),
 * SSE 进度复用 useGeneration/trackJob;NSFW 引擎由后端按 R18 上下文过滤,前端不判断。
 */
export function GenerateView({ initialDraft, lockedKind, onlyNsfw = false }: GenerateViewProps) {
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

  // 引擎注册表:进入即拉取 + 30s 轮询刷新可用性(worker 上下线会反映到状态点)
  usePoll(
    async () => {
      try {
        setEngines(await fetchEngines());
        setEnginesError(null);
      } catch (e) {
        setEnginesError(e instanceof Error ? e.message : "加载引擎列表失败");
      }
    },
    { intervalMs: 30_000, enabled: true, backoff: true },
  );

  const kindEngines = useMemo(
    () => (engines ?? []).filter((e) => e.kind === mode && (!onlyNsfw || e.nsfw)),
    [engines, mode, onlyNsfw],
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

  // 参数状态:按引擎 id 分槽保存,切换引擎不丢输入(会话级)
  const [valuesByEngine, setValuesByEngine] = useState<Record<string, Record<string, unknown>>>({});
  const [promptByEngine, setPromptByEngine] = useState<Record<string, string>>({});
  const [refByEngine, setRefByEngine] = useState<Record<string, UploadedRef | null>>({});
  const [audioByEngine, setAudioByEngine] = useState<Record<string, UploadedAudio | null>>({});

  const values = useMemo(
    () => (engine ? { ...engineDefaults(engine), ...(valuesByEngine[engine.id] ?? {}) } : {}),
    [engine, valuesByEngine],
  );
  const positive = engine ? promptByEngine[engine.id] ?? "" : "";
  const refImage = engine ? refByEngine[engine.id] ?? null : null;
  const refAudio = engine ? audioByEngine[engine.id] ?? null : null;
  const imageParam = engine ? engineNeedsImage(engine) : null;
  const audioParam = engine ? engineNeedsAudio(engine) : null;

  // 参数分区:尺寸(width/height 成对)→ PromptBar chip;高级(steps/cfg/seed)→ 浮板折叠区;其余 → 浮板主区
  const sizeParams = useMemo(
    () =>
      engine
        ? engine.params.filter((p) => p.type === "number" && SIZE_PARAM_KEYS.has(p.key))
        : [],
    [engine],
  );
  const showSizeChip = sizeParams.length === 2;
  const mainParams = useMemo(
    () =>
      engine
        ? engine.params.filter(
            (p) =>
              p.type !== "images" &&
              p.type !== "audio" &&
              p.key !== "negative" &&
              !ADVANCED_PARAM_KEYS.has(p.key) &&
              !(showSizeChip && SIZE_PARAM_KEYS.has(p.key)),
          )
        : [],
    [engine, showSizeChip],
  );
  const advancedParams = useMemo(
    () => (engine ? engine.params.filter((p) => ADVANCED_PARAM_KEYS.has(p.key)) : []),
    [engine],
  );
  const showAdvanced = advancedParams.length > 0 || (engine ? engineSupportsNegative(engine) : false);

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
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const gen = useGeneration({
    onDone: (paths) => {
      const id = runningIdRef.current;
      runningIdRef.current = null;
      if (id) {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "done", paths } : e)));
      }
      invalidateJobs(); // 产物已落库,作品库缓存失效
    },
    onError: (msg, detail) => {
      const id = runningIdRef.current;
      runningIdRef.current = null;
      if (id) {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "error", error: msg, errorDetail: detail ?? null } : e)));
      }
    },
  });

  const canSubmit =
    !!engine &&
    engine.available &&
    positive.trim().length > 0 &&
    !gen.isRunning &&
    !submitting &&
    (!imageParam || !!refImage) &&
    (!audioParam || !!refAudio);

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
        refAudio: audioByEngine[target.id] ?? null,
      });
      const entry: HistoryEntry = {
        id: newEntryId(),
        engineId: target.id,
        engineLabel: target.label,
        kind: target.kind,
        prompt: promptText,
        status: "running",
        paths: [],
        width: numVal(targetValues["width"]),
        height: numVal(targetValues["height"]),
        createdAt: Date.now(),
      };
      setEntries((prev) => [entry, ...prev]);
      setSelectedId(entry.id);
      runningIdRef.current = entry.id;
      // start 永远 resolve:出错经 onError 回调更新条目状态
      await gen.start(res);
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
          : "ltx_i2v";

  return (
    <div className={`generate-view${paramsOpen ? " is-params-open" : ""}`}>
      <header className="page-header generate-header">
        <div className="page-header-main">
          <h1 className="page-header-title">
            {lockedKind ? KIND_LABEL[lockedKind] : "AI 生成工作台"}
          </h1>
          <p className="page-header-desc">会话内历史不落库,刷新即清空</p>
        </div>
        {!lockedKind && (
          <div className="page-header-actions generate-header-actions">
            <Tabs
              ariaLabel="生成模式"
              items={[
                { key: "image", label: "图像", icon: <Icon name="image" size={14} /> },
                { key: "video", label: "视频", icon: <Icon name="video" size={14} /> },
              ]}
              current={mode}
              onChange={(k) => setMode(k as EngineKind)}
            />
          </div>
        )}
      </header>

      <div className="generate-body">
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
          />
        </section>

        {paramsOpen && (
          <aside className="generate-params" aria-label="生成参数">
            <div className="generate-params-head">
              <span className="generate-params-title">生成参数</span>
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
            {engines === null && !enginesError ? (
              <>
                <Skeleton height={32} />
                <Skeleton height={72} />
                <Skeleton height={32} />
                <Skeleton height={32} />
              </>
            ) : enginesError ? (
              <p className="generate-error">{enginesError}</p>
            ) : kindEngines.length === 0 ? (
              <p className="generate-error">当前上下文没有可用的{KIND_LABEL[mode]}引擎</p>
            ) : (
              <>
                <div className="params-section">
                  <h3 className="params-section-title">引擎</h3>
                  {showGroupTabs && (
                    <Tabs
                      ariaLabel={mode === "image" ? "文生图或图生图" : mode === "video" ? "文生视频或图生视频" : "生成或编辑"}
                      fill
                      items={[
                        { key: "gen", label: GROUP_LABEL[mode].gen },
                        { key: "edit", label: GROUP_LABEL[mode].edit },
                      ]}
                      current={group}
                      onChange={(k) => setGroupByKind((prev) => ({ ...prev, [mode]: k as "gen" | "edit" }))}
                    />
                  )}

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
                    <div className="engine-status">
                      <Badge tone={engine.available ? "ok" : "warn"}>
                        {engine.available ? "可用" : "不可用"}
                      </Badge>
                      {engine.nsfw && <Badge tone="warn">R18</Badge>}
                      {!engine.available && engine.unavailable_reason && (
                        <span className="engine-status-reason">{engine.unavailable_reason}</span>
                      )}
                    </div>
                  )}
                  {engine?.description && <p className="engine-desc">{engine.description}</p>}
                </div>

                {engine && (imageParam || audioParam) && (
                  <div className="params-section">
                    <h3 className="params-section-title">参考输入</h3>
                    {imageParam && (
                      <RefImageUpload
                        param={imageParam}
                        value={refImage}
                        uploadKind={uploadKind}
                        disabled={gen.isRunning}
                        onChange={(v) => {
                          setRefByEngine((prev) => ({ ...prev, [engine.id]: v }));
                          // 参考图换机后,已上传音频若钉在旧 worker 会跨机取不到 → 强制重传
                          if (refAudio && v?.worker !== refAudio.worker) {
                            setAudioByEngine((prev) => ({ ...prev, [engine.id]: null }));
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
                  </div>
                )}

                {mainParams.length > 0 && (
                  <div className="params-section">
                    <h3 className="params-section-title">生成参数</h3>
                    {mainParams.map((p) => (
                      <ParamField
                        key={p.key}
                        param={p}
                        value={values[p.key]}
                        disabled={gen.isRunning}
                        onChange={setValue}
                      />
                    ))}
                  </div>
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
                          onChange={setValue}
                        />
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </aside>
        )}

        {!paramsOpen && (
          <button
            type="button"
            className="generate-params-fab"
            onClick={() => setParamsOpen(true)}
            aria-expanded={false}
            aria-label="展开参数面板"
            title="展开参数面板"
          >
            <Icon name="sliders" size={18} />
          </button>
        )}

        <PromptBar
          value={positive}
          onChange={(v) => {
            if (!engine) return;
            setPromptByEngine((prev) => ({ ...prev, [engine.id]: v }));
          }}
          disabled={gen.isRunning}
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
          onGenerate={() => void onGenerate()}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

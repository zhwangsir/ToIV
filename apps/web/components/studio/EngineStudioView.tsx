"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Field, Textarea } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { usePoll } from "@/hooks/usePoll";
import { cancelJob, invalidateJobs } from "@/lib/api";
import { firstPinWorker } from "@/lib/apps";
import {
  engineDefaults,
  engineUploadKind,
  fetchEngines,
  submitEngineGeneration,
  type EngineInfo,
} from "@/lib/engines";
import {
  defaultStudioEngine,
  extractStudioMedia,
  resolveStudioModes,
  type StudioKind,
} from "@/lib/engineStudio";
import { friendlyError } from "@/lib/friendlyError";
import { isH3EngineId, type H3AccelLevel } from "@/lib/h3Accel";
import { R18_CHANGED_EVENT } from "@/lib/r18";
import { useGeneration } from "@/lib/useGeneration";
import { ParamField } from "@/components/generate/ParamField";
import { H3AccelSelect } from "@/components/generate/H3AccelSelect";
import { ResultPanel, type HistoryEntry } from "@/components/generate/ResultPanel";
import "@/app/styles/apps.css";

function newEntryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 取数值参数(仅有限 number 有效,其余视为未设置)。 */
function numVal(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 引擎工作台(2026-09-12 导航收口):图片/视频视图 = 纯引擎工作台
 * (模式 × 引擎 × 统一参数面板),应用全部归应用市场;KindCreateView 随之退役挂载。
 *
 * 布局:顶部模式段控(at-seg)→ 引擎卡条(横滚,离线置灰)→ 参数面板
 * (ParamField 按注册表 params 动态渲染,媒体上传内建)→ 运行按钮 → 结果区
 * (复用 generate/ResultPanel + useGeneration/trackJob,与 GenerateView 同一提交链
 *  lib/engines.submitEngineGeneration,不另写提交逻辑)。
 * 模式→引擎映射与目录解析在 lib/engineStudio(纯函数,单测直测);
 * R18 引擎由后端按上下文混入/剔除目录,前端不判断。
 */
export function EngineStudioView({ kind }: { kind: StudioKind }) {
  const toast = useToast();
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [enginesError, setEnginesError] = useState<string | null>(null);

  const loadEngines = useCallback(async () => {
    try {
      setEngines(await fetchEngines());
      setEnginesError(null);
    } catch (e) {
      setEnginesError(e instanceof Error ? e.message : "加载引擎列表失败");
    }
  }, []);

  // 引擎注册表:进入即拉取 + 30s 轮询(worker 上下线反映到卡片状态点;与 GenerateView 同策略)
  usePoll(loadEngines, { intervalMs: 30_000, enabled: true, backoff: true });

  // R18 全局模式切换:后端按 X-NSFW 上下文混入/剔除 R18 引擎,监听广播立即重拉
  useEffect(() => {
    const handler = () => void loadEngines();
    window.addEventListener(R18_CHANGED_EVENT, handler);
    return () => window.removeEventListener(R18_CHANGED_EVENT, handler);
  }, [loadEngines]);

  const modes = useMemo(() => resolveStudioModes(engines ?? [], kind), [engines, kind]);
  const [modeId, setModeId] = useState<string | null>(null);
  const mode = modes.find((m) => m.id === modeId) ?? modes[0] ?? null;

  // 引擎选择按模式分槽保存,切换模式不丢选择
  const [engineByMode, setEngineByMode] = useState<Record<string, string>>({});
  const engine = useMemo(() => {
    if (!mode) return null;
    const sel = engineByMode[mode.id];
    return mode.engines.find((e) => e.id === sel) ?? defaultStudioEngine(mode);
  }, [mode, engineByMode]);

  // 参数/提示词按引擎分槽保存,切换引擎不丢输入(会话级)
  const [valuesByEngine, setValuesByEngine] = useState<Record<string, Record<string, unknown>>>({});
  const [promptByEngine, setPromptByEngine] = useState<Record<string, string>>({});
  /** H3 智能加速档按引擎分槽(2026-09-12):仅 h3-* 引擎渲染,默认关闭 */
  const [accelByEngine, setAccelByEngine] = useState<Record<string, H3AccelLevel>>({});

  const values = useMemo(
    () => (engine ? { ...engineDefaults(engine), ...(valuesByEngine[engine.id] ?? {}) } : {}),
    [engine, valuesByEngine],
  );
  const positive = engine ? promptByEngine[engine.id] ?? "" : "";
  const media = useMemo(() => (engine ? extractStudioMedia(engine, values) : null), [engine, values]);
  const refImages = media?.refImages ?? [];
  const refAudio = media?.refAudio ?? null;
  const refVideo = media?.refVideo ?? null;
  const imageParam = useMemo(
    () => engine?.params.find((p) => p.type === "images") ?? null,
    [engine],
  );
  const audioParam = useMemo(
    () => engine?.params.find((p) => p.type === "audio") ?? null,
    [engine],
  );
  const videoParam = useMemo(
    () => engine?.params.find((p) => p.type === "video") ?? null,
    [engine],
  );
  // 首尾帧模式(h3-fl2v):恰好 2 张(第 1 张首帧,第 2 张尾帧)
  const isFl2v = engine?.id === "h3-fl2v" || engine?.id === "h3-nsfw-fl2v";

  const setValue = (key: string, v: unknown) => {
    if (!engine) return;
    setValuesByEngine((prev) => ({ ...prev, [engine.id]: { ...(prev[engine.id] ?? {}), [key]: v } }));
  };

  // 会话历史(与 GenerateView 同一 HistoryEntry/ResultPanel 语言;不落 localStorage)
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const runningIdRef = useRef<string | null>(null);
  const runningPromptIdRef = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

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
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, status: "error", error: msg, errorDetail: detail ?? null } : e)),
        );
      }
    },
  });

  const canSubmit =
    !!engine &&
    engine.available &&
    positive.trim().length > 0 &&
    !gen.isRunning &&
    !submitting &&
    (!imageParam || (isFl2v ? refImages.length === 2 : refImages.length > 0)) &&
    (!audioParam || !!refAudio) &&
    (!videoParam || !!refVideo);

  /** 提交禁用原因(首个缺失项),运行按钮上方内联透出 + 按钮 title。 */
  const submitBlockReason = useMemo<string | null>(() => {
    if (gen.isRunning || submitting) return null;
    if (!engine) return enginesError ? "引擎列表加载失败,请点击错误条重试" : "引擎加载中…";
    if (!engine.available) return `引擎离线:${engine.unavailable_reason ?? "暂不可用"},恢复后即可提交`;
    if (positive.trim().length === 0) return "请先填写提示词";
    if (imageParam && isFl2v && refImages.length !== 2) {
      return "首尾帧需恰好 2 张参考图(第 1 张首帧,第 2 张尾帧)";
    }
    if (imageParam && refImages.length === 0) return `请先上传${imageParam.label || "参考图"}`;
    if (audioParam && !refAudio) return `请先上传${audioParam.label || "参考音频"}`;
    if (videoParam && !refVideo) return `请先上传${videoParam.label || "驱动视频"}`;
    return null;
  }, [
    gen.isRunning,
    submitting,
    engine,
    enginesError,
    positive,
    imageParam,
    isFl2v,
    refImages,
    audioParam,
    refAudio,
    videoParam,
    refVideo,
  ]);

  /** 提交一次生成:与 GenerateView 同一 submitEngineGeneration 链路;错误内联横幅,不静默。 */
  async function submitGeneration(target: EngineInfo, promptText: string) {
    setSubmitError(null);
    setSubmitting(true);
    const targetValues = { ...engineDefaults(target), ...(valuesByEngine[target.id] ?? {}) };
    const targetMedia = extractStudioMedia(target, targetValues);
    try {
      const res = await submitEngineGeneration({
        engine: target,
        positive: promptText,
        values: targetValues,
        refImage: targetMedia.refImages[0] ?? null,
        refImages: targetMedia.refImages,
        refAudio: targetMedia.refAudio,
        refVideo: targetMedia.refVideo,
        acceleration: isH3EngineId(target.id) ? (accelByEngine[target.id] ?? "off") : undefined,
      });
      const entry: HistoryEntry = {
        id: newEntryId(),
        engineId: target.id,
        engineLabel: target.label,
        kind: target.kind,
        prompt: promptText,
        status: "running",
        paths: [],
        promptId: res.prompt_id,
        notice:
          [
            res.duration_notice ?? null,
            typeof res.queued_behind === "number" && res.queued_behind > 0
              ? `排队中:前方还有 ${res.queued_behind} 个作业,依次自动执行`
              : null,
            res.upscale_notice ?? null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
        width: numVal(targetValues["width"]),
        height: numVal(targetValues["height"]),
        createdAt: Date.now(),
      };
      setEntries((prev) => [entry, ...prev]);
      setSelectedId(entry.id);
      runningIdRef.current = entry.id;
      runningPromptIdRef.current = res.prompt_id ?? null;
      if (res.duration_notice) toast.info(res.duration_notice);
      if (typeof res.queued_behind === "number" && res.queued_behind > 0) {
        toast.info(`已加入 ${target.label} 队列:前方还有 ${res.queued_behind} 个作业(排队等待,非故障)`);
      }
      if (res.upscale_notice) toast.info(res.upscale_notice);
      // start 永远 resolve:出错经 onError 回调更新条目状态
      await gen.start(res, { label: target.label });
    } catch (e) {
      // 提交阶段失败(参数校验/引擎离线 503/网络):不入历史,内联错误横幅(已知模式包装友好文案)
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

  const loading = engines === null && !enginesError;

  return (
    <div className="apps-studio rh-dark">
      {/* 模式段控:文生/图生/编辑等(映射见 lib/engineStudio;无引擎的模式自动隐藏) */}
      <div className="apps-studio-head">
        {modes.length > 1 && (
          <div className="at-seg" role="tablist" aria-label="生成模式">
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={mode?.id === m.id}
                className={`at-seg-btn${mode?.id === m.id ? " is-active" : ""}`}
                onClick={() => setModeId(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {enginesError && (
        <div className="apps-studio-error">
          <ErrorBar message={`引擎列表加载失败:${enginesError}`} onClose={() => setEnginesError(null)} />
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="refresh" size={13} />}
            onClick={() => void loadEngines()}
            title="重新拉取引擎列表"
          >
            重试
          </Button>
        </div>
      )}

      <div className="apps-studio-body">
        <section className="apps-studio-panel" aria-label="引擎与参数">
          {loading ? (
            <>
              <Skeleton height={40} />
              <Skeleton height={72} />
              <Skeleton height={32} />
              <Skeleton height={32} />
            </>
          ) : modes.length === 0 ? (
            <Empty
              size="section"
              icon={kind === "video" ? "video" : "image"}
              title={enginesError ? "引擎列表加载失败,请重试" : "当前上下文没有可用引擎"}
              desc={enginesError ? undefined : "引擎恢复上线后会自动出现在这里"}
            />
          ) : (
            <>
              {/* 引擎卡条:label + 一句话描述 + 在线状态点 + R18 徽标;离线置灰仍可选中看参数 */}
              {mode && mode.engines.length > 0 && (
                <div className="apps-studio-engines" role="listbox" aria-label="选择引擎">
                  {mode.engines.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      role="option"
                      aria-selected={engine?.id === e.id}
                      className={
                        `apps-studio-engine-card${engine?.id === e.id ? " is-active" : ""}` +
                        `${e.available ? "" : " is-offline"}`
                      }
                      onClick={() => setEngineByMode((prev) => ({ ...prev, [mode.id]: e.id }))}
                      title={e.available ? e.description : `引擎离线:${e.unavailable_reason ?? "暂不可用"}`}
                    >
                      <span className="apps-studio-engine-top">
                        <span
                          className={`apps-studio-engine-dot${e.available ? " is-on" : ""}`}
                          aria-hidden="true"
                        />
                        <span className="apps-studio-engine-label">{e.label}</span>
                        {e.nsfw && <Badge tone="warn">R18</Badge>}
                      </span>
                      {e.description && <span className="apps-studio-engine-desc">{e.description}</span>}
                      {!e.available && <span className="apps-studio-engine-off">引擎离线</span>}
                    </button>
                  ))}
                </div>
              )}

              {engine && (
                <>
                  <Field label="提示词">
                    <Textarea
                      rows={3}
                      value={positive}
                      placeholder={kind === "video" ? "描述想要的视频内容" : "描述想要的画面内容"}
                      disabled={gen.isRunning}
                      onChange={(e) =>
                        setPromptByEngine((prev) => ({ ...prev, [engine.id]: e.target.value }))
                      }
                    />
                  </Field>

                  <div className="apps-studio-params">
                    {engine.params.map((p) => (
                      <ParamField
                        key={p.key}
                        param={p}
                        value={values[p.key]}
                        disabled={gen.isRunning}
                        uploadKind={engineUploadKind(engine.id)}
                        pinWorker={firstPinWorker(values)}
                        onChange={setValue}
                      />
                    ))}
                  </div>

                  {isH3EngineId(engine.id) && (
                    <H3AccelSelect
                      value={accelByEngine[engine.id] ?? "off"}
                      onChange={(level) =>
                        setAccelByEngine((prev) => ({ ...prev, [engine.id]: level }))
                      }
                      disabled={gen.isRunning}
                    />
                  )}

                  <div className="apps-studio-runbar rh-runbar">
                    {submitBlockReason && (
                      <p className="apps-studio-block" role="status">
                        {submitBlockReason}
                      </p>
                    )}
                    <button
                      type="button"
                      className="rh-run-btn"
                      disabled={!canSubmit}
                      title={submitBlockReason ?? undefined}
                      onClick={() => void onGenerate()}
                    >
                      {gen.isRunning || submitting ? "生成中…" : "立即生成"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </section>

        <section className="apps-studio-results" aria-label="生成结果">
          {submitError && (
            <div className="apps-studio-submit-error">
              <ErrorBar message={submitError} onClose={() => setSubmitError(null)} />
            </div>
          )}
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
      </div>
    </div>
  );
}

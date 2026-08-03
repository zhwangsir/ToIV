"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field, Select, Textarea } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { usePoll } from "@/hooks/usePoll";
import { invalidateJobs } from "@/lib/api";
import { consumeEngineDraft, type EngineDraft } from "@/lib/engine";
import {
  engineDefaults,
  engineNeedsImage,
  engineSupportsNegative,
  fetchEngines,
  submitEngineGeneration,
  type EngineInfo,
  type EngineKind,
} from "@/lib/engines";
import { useGeneration } from "@/lib/useGeneration";

import { ParamField } from "./ParamField";
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
   * 外部注入的初始草稿(W3 旧视图退役:create/video 的草稿流并入此处)。
   * 未提供(prop 为 undefined)时自动消费 localStorage 引擎草稿(lib/engine),
   * 与旧 CreateView/VideoView 行为一致;显式传 null 表示禁用草稿。
   */
  initialDraft?: GenerateDraft | null;
}

/**
 * 统一生成工作台(W1):图像/视频统一入口。
 *
 * 信息架构:接入新引擎 = 后端注册表(services/engine_registry)加条目,前端不再开新视图。
 * - 顶部模式段控:图像 | 视频(引擎列表按 kind 过滤)
 * - 左侧参数栏(320px):引擎选择器(带可用性状态/原因)+ prompt + 负向(引擎支持时)
 *   + 参考图上传(schema images 类型)+ 动态参数区(schema 驱动渲染)+ 生成按钮
 * - 右侧结果区(ResultPanel):当前任务大卡 + 会话历史网格 + A/B 对比
 * 提交链路:按引擎 id 路由到既有 API(lib/engines.submitEngineGeneration),
 * SSE 进度复用 useGeneration/trackJob;NSFW 引擎由后端按 R18 上下文过滤,前端不判断。
 */
export function GenerateView({ initialDraft }: GenerateViewProps) {
  // 草稿:显式 prop 优先;否则消费 localStorage 引擎草稿(target=drama/manju 由短剧/漫剧视图消费,此处忽略)
  const draft = useMemo<GenerateDraft | null>(
    () => (initialDraft !== undefined ? initialDraft : consumeEngineDraft()),
    [initialDraft],
  );
  const [mode, setMode] = useState<EngineKind>(draft?.target === "video" ? "video" : "image");
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

  const kindEngines = useMemo(() => (engines ?? []).filter((e) => e.kind === mode), [engines, mode]);
  const [engineIdByKind, setEngineIdByKind] = useState<Partial<Record<EngineKind, string>>>({});
  const engine = useMemo(() => {
    const sel = engineIdByKind[mode];
    return (
      kindEngines.find((e) => e.id === sel && e.available) ??
      kindEngines.find((e) => e.available) ??
      kindEngines[0] ??
      null
    );
  }, [kindEngines, engineIdByKind, mode]);

  // 参数状态:按引擎 id 分槽保存,切换引擎不丢输入(会话级)
  const [valuesByEngine, setValuesByEngine] = useState<Record<string, Record<string, unknown>>>({});
  const [promptByEngine, setPromptByEngine] = useState<Record<string, string>>({});
  const [refByEngine, setRefByEngine] = useState<Record<string, UploadedRef | null>>({});

  const values = useMemo(
    () => (engine ? { ...engineDefaults(engine), ...(valuesByEngine[engine.id] ?? {}) } : {}),
    [engine, valuesByEngine],
  );
  const positive = engine ? promptByEngine[engine.id] ?? "" : "";
  const refImage = engine ? refByEngine[engine.id] ?? null : null;
  const imageParam = engine ? engineNeedsImage(engine) : null;

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
    onError: (msg) => {
      const id = runningIdRef.current;
      runningIdRef.current = null;
      if (id) {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "error", error: msg } : e)));
      }
    },
  });

  const canSubmit =
    !!engine &&
    engine.available &&
    positive.trim().length > 0 &&
    !gen.isRunning &&
    !submitting &&
    (!imageParam || !!refImage);

  async function onGenerate() {
    if (!engine || !canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await submitEngineGeneration({
        engine,
        positive: positive.trim(),
        values,
        refImage,
      });
      const entry: HistoryEntry = {
        id: newEntryId(),
        engineId: engine.id,
        engineLabel: engine.label,
        kind: engine.kind,
        prompt: positive.trim(),
        status: "running",
        paths: [],
        createdAt: Date.now(),
      };
      setEntries((prev) => [entry, ...prev]);
      setSelectedId(entry.id);
      runningIdRef.current = entry.id;
      // start 永远 resolve:出错经 onError 回调更新条目状态
      await gen.start(res);
    } catch (e) {
      // 提交阶段失败(参数校验/网络/上传缺失):不入历史,直接显示错误
      setSubmitError(e instanceof Error ? e.message : "生成请求失败");
    } finally {
      setSubmitting(false);
    }
  }

  function onCancel() {
    const id = runningIdRef.current;
    runningIdRef.current = null;
    gen.reset(); // 关闭 SSE;后端作业仍继续,完成后可在作品库查看
    if (id) {
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "cancelled" } : e)));
    }
  }

  const uploadKind = engine?.id === "img2img" ? "img2img" : "ltx_i2v";

  return (
    <div className="generate-view">
      <div className="generate-header">
        <Tabs
          ariaLabel="生成模式"
          items={[
            { key: "image", label: "图像", icon: <Icon name="image" size={14} /> },
            { key: "video", label: "视频", icon: <Icon name="video" size={14} /> },
          ]}
          current={mode}
          onChange={(k) => setMode(k as EngineKind)}
        />
        <span className="generate-header-note">会话内历史不落库,刷新即清空</span>
      </div>

      <div className="generate-body">
        <aside className="generate-params" aria-label="生成参数">
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
            <p className="generate-error">当前上下文没有可用的{mode === "image" ? "图像" : "视频"}引擎</p>
          ) : (
            <>
              <Field label="引擎">
                <Select
                  value={engine?.id ?? ""}
                  onChange={(e) => setEngineIdByKind((prev) => ({ ...prev, [mode]: e.target.value }))}
                  aria-label="选择引擎"
                >
                  {kindEngines.map((e) => (
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

              <Field label="提示词">
                <Textarea
                  rows={4}
                  value={positive}
                  placeholder="描述想要生成的内容…"
                  disabled={gen.isRunning}
                  onChange={(e) => {
                    if (!engine) return;
                    setPromptByEngine((prev) => ({ ...prev, [engine.id]: e.target.value }));
                  }}
                />
              </Field>

              {engine && engineSupportsNegative(engine) && (
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

              {engine && imageParam && (
                <RefImageUpload
                  param={imageParam}
                  value={refImage}
                  uploadKind={uploadKind}
                  disabled={gen.isRunning}
                  onChange={(v) => setRefByEngine((prev) => ({ ...prev, [engine.id]: v }))}
                />
              )}

              {engine &&
                engine.params
                  .filter((p) => p.type !== "images" && p.key !== "negative")
                  .map((p) => (
                    <ParamField
                      key={p.key}
                      param={p}
                      value={values[p.key]}
                      disabled={gen.isRunning}
                      onChange={setValue}
                    />
                  ))}

              {submitError && <p className="generate-error">{submitError}</p>}

              <div className="generate-actions">
                <Button
                  variant="primary"
                  className={gen.isRunning ? "generate-run" : undefined}
                  loading={submitting}
                  disabled={!canSubmit}
                  icon={gen.isRunning ? <Icon name="loading" size={14} /> : <Icon name="sparkles" size={14} />}
                  onClick={() => void onGenerate()}
                >
                  {gen.isRunning ? "生成中…" : "生成"}
                </Button>
                {gen.isRunning && (
                  <Button variant="ghost" onClick={onCancel}>
                    取消
                  </Button>
                )}
              </div>
            </>
          )}
        </aside>

        <section className="generate-results" aria-label="生成结果">
          <ResultPanel
            entries={entries}
            selectedId={selectedId}
            onSelect={setSelectedId}
            liveProgress={gen.progress}
            onCancel={onCancel}
          />
        </section>
      </div>

      <style jsx>{`
        .generate-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          height: 100%;
          padding: var(--space-5);
          overflow: hidden;
        }
        .generate-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          flex-shrink: 0;
        }
        .generate-header-note {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .generate-body {
          display: flex;
          gap: var(--space-4);
          flex: 1;
          min-height: 0;
        }
        .generate-params {
          width: 320px;
          flex-shrink: 0;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding-right: var(--space-1);
        }
        .generate-results {
          flex: 1;
          min-width: 0;
          overflow-y: auto;
        }
        .engine-status {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .engine-status-reason {
          font-size: var(--text-aux);
          color: var(--warn);
        }
        .engine-desc {
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.6;
        }
        .generate-error {
          font-size: var(--text-aux);
          color: var(--err);
        }
        .generate-actions {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding-top: var(--space-1);
          position: sticky;
          bottom: 0;
          background: var(--bg-canvas);
        }
        .generate-actions :global(.btn-primary) {
          flex: 1;
        }
        .generate-actions :global(.btn-primary.generate-run) {
          background: var(--run);
          border-color: var(--run);
          color: var(--text-on-accent);
        }
        @media (max-width: 860px) {
          .generate-view {
            overflow-y: auto;
          }
          .generate-body {
            flex-direction: column;
          }
          .generate-params {
            width: 100%;
            overflow-y: visible;
          }
          .generate-results {
            overflow-y: visible;
          }
        }
      `}</style>
    </div>
  );
}

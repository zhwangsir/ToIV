"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AppWorkflowGraph } from "@/components/apps/AppWorkflowGraph";
import { ParamField } from "@/components/generate/ParamField";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Field, Input } from "@/components/ui/Input";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { useToast } from "@/components/ui/Toast";
import {
  appAuthorInitial,
  appAuthorOf,
  appUploadKind,
  buildRunValues,
  firstPinWorker,
  getApp,
  groupAppParams,
  placeholderAspect,
  requiredParamLabel,
  runApp,
  type AppItem,
  type AppParam,
} from "@/lib/apps";
import { imageUrl, listJobs } from "@/lib/api";
import { mediaKindOf } from "@/lib/mediaKind";
import { trackJob, TrackJobAbortError } from "@/lib/trackJob";
import type { GenerateResponse, JobItem } from "@/lib/types";
/* 样式与 AppMarketView 同文件:app/styles/apps.css(apps- 前缀作用域) */
import "@/app/styles/apps.css";

/**
 * 应用详情/运行页(2026-09-06 RunningHub 化重构):暗底(.rh-dark 作用域)+ 左右两栏——
 * 左列 380px 参数列(按 groupAppParams 三档折叠分区:荧光绿分区标题+chevron;
 * 数值参数用 −/+ stepper;上传字段缩略图由 Ref*Upload 自带) + 底部通栏荧光绿「立即运行」大按钮;
 * 右列预览(cover_url 大图,空则 category 渐变占位 + 简介)+「我的生成」
 * (本次运行结果置顶 + listJobs 按 app_id 过滤的历史产物网格,复用结果区渲染)。
 * 「简洁/工作流」段控保留在顶条:工作流 = AppWorkflowGraph 全图画布(浮动运行条不变)。
 *
 * 提交链不变:POST /api/apps/{id}/run → trackJob(SSE + 轮询兜底)→ 产物按 output_kind 渲染。
 * ParamField 复用说明:ParamField 只依赖 props(param/value/onChange/disabled),
 * 不耦合任何引擎上下文;AppParam 是 EngineParam 的结构子集,直接复用。
 */

interface AppRunnerViewProps {
  appId: string;
  /** 返回应用市场(AppMarketView 视图内切换,非路由跳转) */
  onBack: () => void;
  /** 返回按钮文案;默认「返回市场」(创作页传入「返回应用」) */
  backLabel?: string;
}

/** 参数初值:schema default 优先;images/audio/video 兜底 [];switch 兜底 false,其余兜底空串。 */
function initialValues(app: AppItem): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const p of app.params_schema) {
    if (p.type === "images" || p.type === "audio" || p.type === "video") v[p.key] = [];
    else v[p.key] = p.default ?? (p.type === "switch" ? false : "");
  }
  return v;
}

export function AppRunnerView({ appId, onBack, backLabel = "返回市场" }: AppRunnerViewProps) {
  const toast = useToast();
  const [app, setApp] = useState<AppItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  /** 双模式(2026-09-02):简洁 = 表单;工作流 = 全图展现 + 节点内联调参 */
  const [mode, setMode] = useState<"simple" | "workflow">("simple");

  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [results, setResults] = useState<string[]>([]);
  /** 卸载/重跑时中止在途 trackJob(后端作业仍继续,产物落作品库) */
  const abortRef = useRef<AbortController | null>(null);
  /** 「我的生成」:该 app 的历史产物(2026-09-06 RH 化;按 app_id 过滤,旧后端无 app_id 时自然为空) */
  const [history, setHistory] = useState<JobItem[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const a = await getApp(appId);
      setApp(a);
      setValues(initialValues(a));
    } catch (e) {
      setApp(null);
      setLoadError(e instanceof Error ? e.message : "加载应用失败");
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** 「我的生成」历史:复用作品库 SWR(listJobs),按 app_id 过滤(done 且有产物,取近 12 条)。
   *  运行成功后 results 已在右列置顶,不再即时重拉(SWR TTL 到期自然补)。 */
  useEffect(() => {
    if (!app) return;
    let alive = true;
    listJobs()
      .then((jobs) => {
        if (!alive) return;
        setHistory(
          jobs
            .filter((j) => j.app_id === app.id && j.status === "done" && j.results.length > 0)
            .slice(0, 12),
        );
      })
      .catch(() => {
        /* 历史区为非关键路径:失败静默,不挡参数表单 */
      });
    return () => {
      alive = false;
    };
  }, [app]);

  const onParamChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  /** 提交按钮禁用原因(null = 可提交);必填 = schema 无 default 且当前值为空。 */
  const disabledReason = loading
    ? "应用加载中"
    : !app
      ? "应用不可用"
      : submitting
        ? "正在提交"
        : running
          ? "生成中,请稍候"
          : (() => {
              const missing = requiredParamLabel(app.params_schema, values);
              return missing ? `请填写「${missing}」` : null;
            })();

  async function run() {
    if (!app || disabledReason) return;
    setSubmitting(true);
    setRunError(null);
    setResults([]);
    setProgress(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let receipt: Awaited<ReturnType<typeof runApp>>;
    try {
      receipt = await runApp(app.id, buildRunValues(app.params_schema, values));
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "提交失败");
      setSubmitting(false);
      return;
    }
    // 提交完成即复位 submitting:后续跟踪期只由 running 卡控;
    // 任何异常(含非 Error 抛出)都不得把表单永久留在「正在提交」禁用态
    setSubmitting(false);
    setRunning(true);
    try {
      // trackJob 复用统一作业跟踪(SSE 进度 + 断线重连 + lookupJob 轮询兜底);
      // client_id/worker 契约未保证,空串时 SSE 连不上会自动降级轮询,产物不丢
      const genRes: GenerateResponse = {
        prompt_id: receipt.prompt_id,
        client_id: receipt.client_id,
        worker: receipt.worker,
        seed: 0,
        kind: "app_run",
      };
      const paths = await trackJob(genRes, {
        label: app.name,
        signal: ctrl.signal,
        onProgress: (p) => setProgress(p.pct),
      });
      setResults(paths);
      toast.success(paths.length > 0 ? "生成完成" : "生成完成,产物可在作品库查看");
    } catch (e) {
      // 用户离开页面/重跑触发的 AbortError 静默吞掉(非失败)
      if (!(e instanceof TrackJobAbortError)) {
        setRunError(e instanceof Error ? e.message : "运行失败");
      }
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  if (loading) {
    return (
      <div className="single-view apps-runner rh-dark">
        <LoadingBlock variant="line" count={3} />
      </div>
    );
  }

  if (loadError || !app) {
    return (
      <div className="single-view apps-runner rh-dark">
        <div className="apps-load-error">
          <ErrorBar message={loadError ?? "应用不存在"} onClose={() => setLoadError(null)} />
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="refresh" size={13} />}
              onClick={() => void load()}
            >
              重试
            </Button>
            <Button variant="ghost" size="sm" onClick={onBack}>
              {backLabel}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="single-view apps-runner rh-dark">
      {/* 工作台细顶条(2026-09-02 W3 页头移除):返回 + 应用名 + 描述(截断) + 右側段控/用量;
          sticky 保留——长工作流下段控不能滚出视口;2026-09-06 RH 化:用量改 ▶ 荧光徽标 */}
      <header className="apps-runner-head">
        <button type="button" className="apps-runner-back" onClick={onBack}>
          <Icon name="chevron-left" size={13} /> {backLabel}
        </button>
        <span className="apps-runner-appicon" aria-hidden="true">
          <Icon name={(app.icon || "package") as IconName} size={14} />
        </span>
        <span className="apps-runner-title">{app.name}</span>
        <span className="apps-runner-author" title={`作者:${appAuthorOf(app)}`}>
          <span className="rh-card-avatar" aria-hidden="true">
            {appAuthorInitial(app)}
          </span>
          {appAuthorOf(app)}
        </span>
        {app.description && (
          <span className="apps-runner-desc" title={app.description}>
            {app.description}
          </span>
        )}
        <span className="apps-runner-head-actions">
          <span className="apps-usage rh-usage-badge" title="累计运行次数">
            <Icon name="play" size={10} />
            {app.usage_count} 次使用
          </span>
          {/* 简洁/工作流 双模式段控(2026-09-02):工作流把全图展现给用户,最可控 */}
          <div className="at-seg rh-seg" role="tablist" aria-label="显示模式">
            {(
              [
                ["simple", "简洁"],
                ["workflow", "工作流"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={`at-seg-btn${mode === m ? " is-active" : ""}`}
                onClick={() => setMode(m)}
              >
                {label}
              </button>
            ))}
          </div>
        </span>
      </header>

      <ErrorBar message={runError} onClose={() => setRunError(null)} />

      {mode === "workflow" ? (
        <AppWorkflowGraph
          app={app}
          values={values}
          onParamChange={onParamChange}
          disabled={submitting || running}
          uploadKind={appUploadKind(app.id)}
          pinWorker={firstPinWorker(values)}
          runSlot={
            <>
              <Button
                variant="primary"
                icon={<Icon name="zap" size={14} />}
                loading={submitting || running}
                disabled={disabledReason != null}
                onClick={() => void run()}
              >
                运行应用
              </Button>
              {disabledReason && <span className="apps-disabled-reason">{disabledReason}</span>}
            </>
          }
        />
      ) : (
        /* RH 两栏(2026-09-06):左 380px 参数列(折叠分区 + 通栏「立即运行」)/ 右预览+我的生成;
           ≤1023px 纵向堆叠(参数列在上) */
        <div className="rh-runner-body">
          <aside className="rh-params">
            <div className="apps-runner-form rh-params-scroll">
              {groupAppParams(app.params_schema).map((g) => (
                <RhParamSection key={g.key} title={g.label}>
                  {g.params.map((p) =>
                    p.type === "number" ? (
                      /* 数值参数走 RH stepper(−/+),其余类型复用 ParamField */
                      <RhNumberField
                        key={p.key}
                        param={p}
                        value={values[p.key]}
                        onChange={onParamChange}
                        disabled={submitting || running}
                      />
                    ) : (
                      <ParamField
                        key={p.key}
                        param={p}
                        value={values[p.key]}
                        onChange={onParamChange}
                        disabled={submitting || running}
                        uploadKind={appUploadKind(app.id)}
                        pinWorker={firstPinWorker(values)}
                      />
                    ),
                  )}
                </RhParamSection>
              ))}
            </div>
            {/* 底部通栏运行条:荧光绿大按钮 + 禁用原因 + 运行状态 */}
            <div className="apps-runner-submit rh-runbar">
              <button
                type="button"
                className="rh-run-btn"
                disabled={disabledReason != null}
                aria-busy={submitting || running}
                onClick={() => void run()}
              >
                <Icon name={submitting || running ? "loading" : "zap"} size={16} />
                {running ? "生成中…" : "立即运行"}
              </button>
              {disabledReason && !running && (
                <span className="apps-disabled-reason">{disabledReason}</span>
              )}
              {running && (
                <p className="apps-run-status" role="status">
                  {progress != null ? `生成中 ${progress}%` : "已提交,排队/生成中…"}
                </p>
              )}
            </div>
          </aside>

          <div className="rh-preview">
            {/* 预览大卡:cover_url 大图,空则 category 渐变占位(与市场卡同语言) */}
            <div
              className="rh-preview-cover"
              data-category={app.category}
              style={app.cover_url ? undefined : { aspectRatio: placeholderAspect(app.id) }}
            >
              {app.cover_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="rh-card-img" src={imageUrl(app.cover_url)} alt={app.name} />
              ) : (
                <span className="rh-card-placeholder-icon" aria-hidden="true">
                  <Icon name={(app.icon || "package") as IconName} size={40} strokeWidth={1.2} />
                </span>
              )}
            </div>

            {/* 我的生成:本次结果置顶 + 历史产物网格(按 app_id 过滤) */}
            <section className="rh-history" aria-label="我的生成">
              <h2 className="rh-history-title">我的生成</h2>
              {results.length === 0 && history.length === 0 ? (
                <Empty size="inline" title="还没有生成记录——填好参数点「立即运行」" />
              ) : (
                <div className="apps-results rh-history-grid">
                  {results.map((p) => (
                    <ResultTile key={`run:${p}`} path={p} app={app} />
                  ))}
                  {history.flatMap((j) =>
                    j.results.map((p) => <ResultTile key={`${j.id}:${p}`} path={p} app={app} />),
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 结果格(本次运行 + 历史「我的生成」共用):按 output_kind 分流渲染(图/视频/音频),
 * 下载走 hover 浮层(音频流内)。与原 apps-results 区块同款结构。
 */
function ResultTile({ path: p, app }: { path: string; app: AppItem }) {
  const url = imageUrl(p);
  const kind = mediaKindOf(p, app.output_kind);
  const download = (
    <div className="apps-result-actions">
      <a className="btn btn-sm" href={url} download>
        <Icon name="download" size={14} />
        下载
      </a>
    </div>
  );
  return (
    <div className="apps-result-card">
      {kind === "audio" ? (
        <>
          <audio className="apps-result-media" src={url} controls />
          {download}
        </>
      ) : (
        <div
          className={`apps-result-frame${kind === "video" ? " apps-result-frame--video" : " apps-result-frame--image"}`}
        >
          {kind === "video" ? (
            <video className="apps-result-media" src={url} controls playsInline preload="metadata" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="apps-result-media" src={url} alt={`${app.name} 产物`} loading="lazy" />
          )}
          {download}
        </div>
      )}
    </div>
  );
}

/** 参数折叠分区(2026-09-06 RH 化):荧光绿分区标题 + chevron,默认展开。 */
function RhParamSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`rh-section${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="rh-section-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rh-section-title">{title}</span>
        <span className="rh-section-chevron" aria-hidden="true">
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
      {open && <div className="rh-section-body">{children}</div>}
    </section>
  );
}

/**
 * 数值 stepper(2026-09-06 RH 化):−/+ 按 step 步进并钳位 min/max;
 * 输入框保留原始字符串中间态(与 ParamField 同约定),失焦钳位归一,空值回落 default。
 */
function RhNumberField({
  param,
  value,
  onChange,
  disabled,
}: {
  param: AppParam;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}) {
  const step = typeof param.step === "number" && param.step > 0 ? param.step : 1;
  const fallback = typeof param.default === "number" ? param.default : 0;
  const clamp = (n: number): number => {
    let v = n;
    if (typeof param.min === "number") v = Math.max(param.min, v);
    if (typeof param.max === "number") v = Math.min(param.max, v);
    const base = typeof param.min === "number" ? param.min : 0;
    // toFixed(6) 消除浮点噪声(0.1 步长等)
    return Number((base + Math.round((v - base) / step) * step).toFixed(6));
  };
  const current = (): number => {
    const n = Number(String(value ?? "").trim());
    return Number.isFinite(n) ? n : fallback;
  };
  const nudge = (dir: 1 | -1) => onChange(param.key, clamp(current() + dir * step));
  return (
    <Field label={param.label}>
      <div className="rh-stepper">
        <button
          type="button"
          className="rh-stepper-btn"
          aria-label={`${param.label} 减`}
          disabled={disabled}
          onClick={() => nudge(-1)}
        >
          <Icon name="minus" size={13} />
        </button>
        <Input
          type="number"
          min={param.min}
          max={param.max}
          step={step}
          value={String(value ?? "")}
          disabled={disabled}
          onBlur={() => {
            const raw = String(value ?? "").trim();
            if (!raw) {
              if (typeof param.default === "number") onChange(param.key, param.default);
              return;
            }
            const n = Number(raw);
            onChange(param.key, Number.isFinite(n) ? clamp(n) : fallback);
          }}
          onChange={(e) => onChange(param.key, e.target.value)}
        />
        <button
          type="button"
          className="rh-stepper-btn"
          aria-label={`${param.label} 加`}
          disabled={disabled}
          onClick={() => nudge(1)}
        >
          <Icon name="plus" size={13} />
        </button>
      </div>
    </Field>
  );
}

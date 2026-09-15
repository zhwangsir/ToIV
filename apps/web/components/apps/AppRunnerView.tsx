"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ParamField } from "@/components/generate/ParamField";
import { H3AccelSelect } from "@/components/generate/H3AccelSelect";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Field, Input } from "@/components/ui/Input";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { AgeGateModal } from "@/components/ui/AgeGateModal";
import { useToast } from "@/components/ui/Toast";
import { listVariantsByFingerprint } from "@/lib/apps";
import {
  appAuthorInitial,
  appAuthorOf,
  appSupportsH3Accel,
  appUploadKind,
  buildRunValues,
  extractRhWebappId,
  rhWebappDetailUrl,
  firstPinWorker,
  getApp,
  getAppGuide,
  groupAppParams,
  openAppWorkflowInComfy,
  placeholderAspect,
  requiredParamLabel,
  runApp,
  summarizeWorkflowNodes,
  schemaInitialValues,
  type AppGuide,
  type AppItem,
  type AppParam,
} from "@/lib/apps";
import { getMe, imageUrl, listJobs } from "@/lib/api";
import type { H3AccelLevel } from "@/lib/h3Accel";
import { confirmAge, isAgeConfirmed, useR18Mode } from "@/lib/r18";
import { mediaKindOf } from "@/lib/mediaKind";
import { trackJob, TrackJobAbortError } from "@/lib/trackJob";
import type { GenerateResponse, JobItem } from "@/lib/types";
/* 样式与 AppMarketView 同文件:app/styles/apps.css(apps- 前缀作用域) */
import "@/app/styles/apps.css";

/**
 * 应用详情/运行页(2026-09-07 RH 详情落地 / open-app UX):
 * 默认「详情」落地 = 左大封面 + 右标题/元信息 + 主 CTA「打开应用」「打开工作流」
 * + 下方「节点信息」(primitive/custom)+ admin 出处;
 * 「打开应用」→ RH 运行台 only(左参数 + 右「应用详情|我的生成」tabs),无简洁/工作流段控;
 * 「打开工作流」/运行台「在画布中编辑」→ open-in-Comfy(/?view=canvas)。
 * 内嵌 AppWorkflowGraph 段控已移除;画布编辑走 Comfy 路径。
 *
 * 设计锁:单色极简 + RH 市场版型 + 主题令牌(勿硬编码 RH 荧光绿)。
 */

interface AppRunnerViewProps {
  appId: string;
  /** 返回应用市场(AppMarketView 视图内切换,非路由跳转) */
  onBack: () => void;
  /** 返回按钮文案;默认「返回市场」(创作页传入「返回应用」) */
  backLabel?: string;
}

/** 参数初值:走 schemaInitialValues(媒体也吃 default,远程 demo URL 可预览)。 */
function initialValues(app: AppItem): Record<string, unknown> {
  return schemaInitialValues(app.params_schema);
}

type RunnerPhase = "detail" | "run";

export function AppRunnerView({ appId, onBack, backLabel = "返回市场" }: AppRunnerViewProps) {
  // 功能归组预设切换(2026-09-15):同指纹变体在运行台内切换,表单/工作流随之切换
  const [activeId, setActiveId] = useState(appId);
  const toast = useToast();
  const [app, setApp] = useState<AppItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [contentMode, setContentMode] = useState<"sfw" | "nsfw">("sfw");
  /** H3 智能加速档(2026-09-12):仅 H3 家族应用显示选择器,默认关闭 */
  const [accel, setAccel] = useState<H3AccelLevel>("off");
  const [r18, setR18Mode] = useR18Mode();
  const [ageGateOpen, setAgeGateOpen] = useState(false);
  /** 详情落地 → 打开应用后进入运行台 */
  const [phase, setPhase] = useState<RunnerPhase>("detail");
  /** 预览封面加载失败降级占位(与市场卡 onError 同范式) */
  const [previewFailed, setPreviewFailed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [comfyOpening, setComfyOpening] = useState(false);
  /** 使用指南(2026-09-12 P1 说明卡):has_guide 才拉;失败静默降级不显示 */
  const [guide, setGuide] = useState<AppGuide | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [results, setResults] = useState<string[]>([]);
  /** 卸载/重跑时中止在途 trackJob(后端作业仍继续,产物落作品库) */
  const abortRef = useRef<AbortController | null>(null);
  /** 「我的生成」:该 app 的历史产物(2026-09-06 RH 化;按 app_id 过滤,旧后端无 app_id 时自然为空) */
  const [history, setHistory] = useState<JobItem[]>([]);
  /** 右栏 RH 双 Tab:应用详情(封面/元信息) | 我的生成(历史网格);默认详情,跑通后切历史 */
  const [panelTab, setPanelTab] = useState<"detail" | "history">("detail");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const a = await getApp(activeId);
      setApp(a);
      setValues(initialValues(a));
    } catch (e) {
      setApp(null);
      setLoadError(e instanceof Error ? e.message : "加载应用失败");
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  // 同指纹变体(2026-09-15 功能归组):运行台以「预设」形态切换,同一功能入口
  const [variants, setVariants] = useState<AppItem[]>([]);
  useEffect(() => {
    setVariants([]);
    const fp = app?.fingerprint;
    if (!fp || (app?.variant_count ?? 0) < 2) return;
    let alive = true;
    listVariantsByFingerprint(fp)
      .then((rows) => {
        if (alive) setVariants(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [app?.fingerprint, app?.variant_count]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPreviewFailed(false);
    setPhase("detail");
    setComfyOpening(false);
    setPanelTab("detail");
    setAccel("off");
  }, [appId, app?.cover_url]);

  useEffect(() => {
    setGuide(null);
    if (!app?.id || !app.has_guide) return;
    let alive = true;
    void getAppGuide(app.id).then((g) => {
      if (alive) setGuide(g);
    });
    return () => {
      alive = false;
    };
  }, [app?.id, app?.has_guide]);

  useEffect(() => {
    let alive = true;
    getMe()
      .then((me) => {
        if (alive) setIsAdmin(me.user?.role === "admin");
      })
      .catch(() => {
        if (alive) setIsAdmin(false);
      });
    return () => {
      alive = false;
    };
  }, []);

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

  const nodeSummary = useMemo(
    () => summarizeWorkflowNodes(app?.workflow_json ?? null),
    [app?.workflow_json],
  );

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

  function requestNsfwMode() {
    if (r18) {
      setContentMode("nsfw");
      return;
    }
    if (isAgeConfirmed()) {
      setR18Mode(true);
      setContentMode("nsfw");
      return;
    }
    setAgeGateOpen(true);
  }

  async function run() {
    if (!app || disabledReason) return;
    // 双保险:disabledReason 之外,提交前再核一次必填缺口(防 values 在渲染后被清空的竞态)
    const missingNow = requiredParamLabel(app.params_schema, values);
    if (missingNow) {
      toast.error(`请先填写「${missingNow}」再运行`);
      return;
    }
    setSubmitting(true);
    setRunError(null);
    setResults([]);
    setProgress(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let receipt: Awaited<ReturnType<typeof runApp>>;
    try {
      receipt = await runApp(activeId, buildRunValues(app.params_schema, values), {
        content_mode:
          app.content_modes?.includes("sfw") && app.content_modes?.includes("nsfw")
            ? contentMode
            : app.is_nsfw
              ? "nsfw"
              : "sfw",
        // 智能加速:非 H3 应用恒 off(选择器不渲染),这里兜底不传
        acceleration: appSupportsH3Accel(app) ? accel : "off",
      });
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
      if (paths.length > 0) setPanelTab("history");
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

  function handleBack() {
    if (phase === "run") {
      setPhase("detail");
      return;
    }
    onBack();
  }

  async function handleOpenWorkflow() {
    if (!app || comfyOpening) return;
    setComfyOpening(true);
    setRunError(null);
    try {
      const res = await openAppWorkflowInComfy(app);
      // 通常已 location.assign 离开本页;若导航未发生则落 ErrorBar + toast
      if (!res.ok) {
        const msg = res.error || "打开工作流失败";
        setRunError(msg);
        toast.error(msg);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "打开工作流失败";
      setRunError(msg);
      toast.error(msg);
    } finally {
      setComfyOpening(false);
    }
  }

  const workflowMissing =
    !app?.workflow_json || Object.keys(app.workflow_json ?? {}).length === 0;

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

  const backText = phase === "run" ? "返回详情" : backLabel;
  const rhWebappId = app.rh_webapp_id || extractRhWebappId(app.description);
  const adminSourceLinks = isAdmin
    ? app.source_links.length > 0
      ? app.source_links
      : rhWebappId
        ? [{ label: "RunningHub", url: app.rh_webapp_url || rhWebappDetailUrl(rhWebappId) }]
        : []
    : [];

  return (
    <div className="single-view apps-runner rh-dark">
      {/* 工作台细顶条:返回 + 应用名 + 描述(截断) + 右側段控/用量 */}
      <header className="apps-runner-head">
        <button type="button" className="apps-runner-back" onClick={handleBack}>
          <Icon name="chevron-left" size={13} /> {backText}
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
          {phase === "run" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={comfyOpening || workflowMissing}
              title={
                workflowMissing
                  ? "该应用暂无工作流数据，无法在画布中编辑"
                  : "在原生 Comfy 画布中编辑此应用工作流"
              }
              icon={<Icon name={comfyOpening ? "loading" : "workflow"} size={13} />}
              onClick={() => void handleOpenWorkflow()}
            >
              {comfyOpening ? "正在打开…" : "在画布中编辑"}
            </Button>
          )}
        </span>
      </header>

      <ErrorBar message={runError} onClose={() => setRunError(null)} />

      {phase === "run" && variants.length > 1 && (
        <div className="apps-preset-row" role="group" aria-label="同功能预设切换">
          <span className="apps-preset-label">预设</span>
          {variants.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`apps-preset-chip${v.id === activeId ? " is-on" : ""}`}
              aria-pressed={v.id === activeId}
              onClick={() => setActiveId(v.id)}
              title={`切换到「${v.name}」的参数与素材组合`}
            >
              {v.name.length > 18 ? `${v.name.slice(0, 18)}…` : v.name}
              {v.smoke_status === "pass" ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}

      {phase === "detail" ? (
        <div className="rh-detail">
          <RhPanelTabs tab={panelTab} onChange={setPanelTab} />

          {panelTab === "detail" ? (
            <>
          <div className="rh-detail-hero">
            <div
              className="rh-detail-cover"
              data-category={app.category}
              style={
                app.cover_url && !previewFailed ? undefined : { aspectRatio: placeholderAspect(app.id) }
              }
            >
              {app.cover_url && !previewFailed ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="rh-card-img"
                  src={imageUrl(app.cover_url)}
                  alt={app.name}
                  onError={() => setPreviewFailed(true)}
                />
              ) : (
                <span className="rh-card-placeholder-icon" aria-hidden="true">
                  <Icon name={(app.icon || "package") as IconName} size={48} strokeWidth={1.2} />
                </span>
              )}
            </div>

            <div className="rh-detail-meta">
              <h1 className="rh-detail-title">{app.name}</h1>
              <div className="rh-detail-byline">
                <span className="rh-card-avatar" aria-hidden="true">
                  {appAuthorInitial(app)}
                </span>
                <span>{appAuthorOf(app)}</span>
                <span className="rh-detail-dot" aria-hidden="true">
                  ·
                </span>
                <span className="rh-detail-usage">
                  <Icon name="play" size={11} />
                  {app.usage_count} 次使用
                </span>
                {app.content_modes?.includes("sfw") && app.content_modes?.includes("nsfw") && (
                  <>
                    <span className="rh-detail-pill">SFW</span>
                    <span className="rh-detail-pill">NSFW</span>
                  </>
                )}
                {!(app.content_modes?.includes("sfw") && app.content_modes?.includes("nsfw")) &&
                  (app.content_modes?.includes("nsfw") || (!app.content_modes?.length && app.is_nsfw)) && (
                    <span className="rh-detail-pill">NSFW</span>
                  )}
                {app.is_builtin && <span className="rh-detail-pill">内置</span>}
              </div>
              {app.description && <p className="rh-detail-desc">{app.description}</p>}

              <div className="rh-detail-ctas">
                <button
                  type="button"
                  className="rh-detail-cta rh-detail-cta--primary"
                  onClick={() => {
                    setPhase("run");
                    setPanelTab("detail");
                  }}
                >
                  <Icon name="zap" size={15} />
                  打开应用
                </button>
                <button
                  type="button"
                  className="rh-detail-cta rh-detail-cta--secondary"
                  disabled={comfyOpening || workflowMissing}
                  title={
                    workflowMissing
                      ? "该应用暂无工作流数据，无法打开"
                      : "在原生 Comfy 画布中打开此应用工作流"
                  }
                  aria-busy={comfyOpening}
                  onClick={() => void handleOpenWorkflow()}
                >
                  <Icon name={comfyOpening ? "loading" : "workflow"} size={15} />
                  {comfyOpening ? "正在打开…" : "打开工作流"}
                </button>
              </div>
            </div>
          </div>

          {guide && <AppGuideCard guide={guide} />}

          <section className="rh-detail-nodes" aria-label="节点信息">
            <h2 className="rh-detail-section-title">节点信息</h2>
            {nodeSummary.totalNodes === 0 ? (
              <Empty size="inline" title="暂无工作流节点数据" />
            ) : (
              <>
                <div className="rh-detail-node-stats">
                  <span>
                    共 <strong>{nodeSummary.totalNodes}</strong> 节点 / {nodeSummary.totalTypes} 类
                  </span>
                  <span>
                    原生 <strong>{nodeSummary.primitiveCount}</strong>
                  </span>
                  <span>
                    自定义 <strong>{nodeSummary.customCount}</strong>
                  </span>
                </div>
                <div className="rh-detail-node-cols">
                  <NodeTypeList
                    title={`原生节点 (${nodeSummary.primitiveTypes.length})`}
                    items={nodeSummary.primitiveTypes}
                    empty="无原生节点"
                  />
                  <NodeTypeList
                    title={`自定义节点 (${nodeSummary.customTypes.length})`}
                    items={nodeSummary.customTypes}
                    empty="无自定义节点"
                  />
                </div>
              </>
            )}
          </section>

          {isAdmin && (
            <section className="rh-detail-provenance" aria-label="应用出处">
              <h2 className="rh-detail-section-title">出处（仅管理员）</h2>
              <dl className="rh-detail-prov-grid">
                <div>
                  <dt>应用 ID</dt>
                  <dd>{app.id}</dd>
                </div>
                <div>
                  <dt>作者</dt>
                  <dd>{appAuthorOf(app)}</dd>
                </div>
                <div>
                  <dt>RH webappId</dt>
                  <dd>
                    {rhWebappId ? (
                      <a
                        className="rh-prov-link"
                        href={app.rh_webapp_url || rhWebappDetailUrl(rhWebappId)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {rhWebappId}
                        <Icon name="link" size={12} />
                      </a>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>分类 / 产物</dt>
                  <dd>
                    {app.category} · {app.output_kind}
                  </dd>
                </div>
                <div>
                  <dt>可见性</dt>
                  <dd>
                    {app.is_builtin ? "内置" : app.is_public ? "公开" : "私有"}
                    {app.is_mine ? " · 我的" : ""}
                  </dd>
                </div>
              </dl>
              {adminSourceLinks.length > 0 && (
                <ul className="rh-prov-links" aria-label="出处外链">
                  {adminSourceLinks.map((l) => (
                    <li key={l.url}>
                      <a
                        className="rh-prov-link"
                        href={l.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {l.label}
                        <Icon name="link" size={12} />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
            </>
          ) : (
            <section className="rh-history" aria-label="我的生成">
              {results.length === 0 && history.length === 0 ? (
                <Empty size="inline" title="还没有生成记录——点「打开应用」填参运行" />
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
          )}
        </div>
      ) : (
        /* RH 两栏:左参数列 / 右预览+我的生成(无简洁/工作流段控) */
        <>
              {app.content_modes?.includes("sfw") && app.content_modes?.includes("nsfw") && (
                <div className="rh-content-mode" role="group" aria-label="内容模式">
                  <button
                    type="button"
                    className={`rh-content-mode-btn${contentMode === "sfw" ? " is-active" : ""}`}
                    onClick={() => setContentMode("sfw")}
                    disabled={submitting || running}
                  >
                    SFW
                  </button>
                  <button
                    type="button"
                    className={`rh-content-mode-btn${contentMode === "nsfw" ? " is-active" : ""}`}
                    onClick={() => requestNsfwMode()}
                    disabled={submitting || running}
                  >
                    NSFW
                  </button>
                </div>
              )}
        <div className="rh-runner-body">
          <aside className="rh-params">
            <div className="apps-runner-form rh-params-scroll">
              {groupAppParams(app.params_schema).map((g) => (
                <RhParamSection key={g.key} title={g.label}>
                  {g.params.map((p) =>
                    p.type === "number" ? (
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
              {appSupportsH3Accel(app) && (
                <H3AccelSelect
                  value={accel}
                  onChange={setAccel}
                  disabled={submitting || running}
                />
              )}
            </div>
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
            <RhPanelTabs tab={panelTab} onChange={setPanelTab} />

            {panelTab === "detail" ? (
              <>
              <div
                className="rh-preview-cover"
                data-category={app.category}
                style={app.cover_url && !previewFailed ? undefined : { aspectRatio: placeholderAspect(app.id) }}
              >
                {app.cover_url && !previewFailed ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="rh-card-img"
                    src={imageUrl(app.cover_url)}
                    alt={app.name}
                    onError={() => setPreviewFailed(true)}
                  />
                ) : (
                  <span className="rh-card-placeholder-icon" aria-hidden="true">
                    <Icon name={(app.icon || "package") as IconName} size={40} strokeWidth={1.2} />
                  </span>
                )}
              </div>
              {guide && <AppGuideCard guide={guide} />}
              </>
            ) : (
              <section className="rh-history" aria-label="我的生成">
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
            )}
          </div>
        </div>
        </>
      )}
      <AgeGateModal
        open={ageGateOpen}
        onConfirm={() => {
          confirmAge();
          setR18Mode(true);
          setContentMode("nsfw");
          setAgeGateOpen(false);
        }}
        onCancel={() => setAgeGateOpen(false)}
      />
    </div>
  );
}

/** RH 右栏双 Tab:应用详情 | 我的生成(主题 accent 填充激活态,官网截图同构)。 */
function RhPanelTabs({
  tab,
  onChange,
}: {
  tab: "detail" | "history";
  onChange: (t: "detail" | "history") => void;
}) {
  return (
    <div className="rh-panel-tabs" role="tablist" aria-label="应用面板">
      {(
        [
          ["detail", "应用详情"],
          ["history", "我的生成"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={`rh-panel-tab${tab === id ? " is-active" : ""}`}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * 使用指南说明卡(2026-09-12 P1):detail 落地页(节点信息之前)与运行台
 * 「应用详情」tab(封面之下)复用。空字段小节整节不渲染;样式在 apps.css(apps-guide- 前缀)。
 */
function AppGuideCard({ guide }: { guide: AppGuide }) {
  return (
    <section className="apps-guide-card" aria-label="使用指南">
      <h2 className="rh-detail-section-title">使用指南</h2>
      {guide.purpose && (
        <div className="apps-guide-section">
          <h3 className="apps-guide-subtitle">用途</h3>
          <p className="apps-guide-text">{guide.purpose}</p>
        </div>
      )}
      {guide.when_to_use && (
        <div className="apps-guide-section">
          <h3 className="apps-guide-subtitle">适用场景</h3>
          <p className="apps-guide-text">{guide.when_to_use}</p>
        </div>
      )}
      {guide.steps.length > 0 && (
        <div className="apps-guide-section">
          <h3 className="apps-guide-subtitle">使用步骤</h3>
          <ol className="apps-guide-steps">
            {guide.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
      {(guide.inputs.length > 0 || guide.outputs.length > 0) && (
        <div className="apps-guide-io">
          {guide.inputs.length > 0 && (
            <div className="apps-guide-section">
              <h3 className="apps-guide-subtitle">输入</h3>
              <ul className="apps-guide-list">
                {guide.inputs.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {guide.outputs.length > 0 && (
            <div className="apps-guide-section">
              <h3 className="apps-guide-subtitle">产出</h3>
              <ul className="apps-guide-list">
                {guide.outputs.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {guide.tips.length > 0 && (
        <div className="apps-guide-section">
          <h3 className="apps-guide-subtitle">提示</h3>
          <ul className="apps-guide-list">
            {guide.tips.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function NodeTypeList({
  title,
  items,
  empty,
}: {
  title: string;
  items: { type: string; count: number }[];
  empty: string;
}) {
  return (
    <div className="rh-detail-node-col">
      <h3 className="rh-detail-node-col-title">{title}</h3>
      {items.length === 0 ? (
        <p className="rh-detail-node-empty">{empty}</p>
      ) : (
        <ul className="rh-detail-node-list">
          {items.map((it) => (
            <li key={it.type}>
              <code>{it.type}</code>
              <span className="rh-detail-node-count">×{it.count}</span>
            </li>
          ))}
        </ul>
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

/** 参数折叠分区:主题 accent 分区标题 + chevron,默认展开。 */
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
 * 数值 stepper:−/+ 按 step 步进并钳位 min/max;
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

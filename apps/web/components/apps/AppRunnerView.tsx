"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ParamField } from "@/components/generate/ParamField";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { PageHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import {
  buildRunValues,
  getApp,
  requiredParamLabel,
  runApp,
  type AppItem,
} from "@/lib/apps";
import { imageUrl } from "@/lib/api";
import { mediaKindOf } from "@/lib/mediaKind";
import { trackJob, TrackJobAbortError } from "@/lib/trackJob";
import type { GenerateResponse } from "@/lib/types";
/* 样式与 AppMarketView 同文件:app/styles/apps.css(apps- 前缀作用域) */
import "@/app/styles/apps.css";

/**
 * 应用运行页(M3):头部(图标/名称/描述/用量/返回市场)+ params_schema 参数表单
 * + 提交(禁用原因提示)→ POST /api/apps/{id}/run → trackJob(SSE + 轮询兜底)
 * → 结果区按 output_kind 渲染产物(图/视频/音频)+ 下载按钮。
 *
 * ParamField 复用说明:ParamField 只依赖 props(param/value/onChange/disabled),
 * 不耦合任何引擎上下文(engines 仅 type-only import);AppParam 是 EngineParam 的
 * 结构子集(同款 schema,类型并集更窄),直接复用,无需仿写 AppParamField。
 */

interface AppRunnerViewProps {
  appId: string;
  /** 返回应用市场(AppMarketView 视图内切换,非路由跳转) */
  onBack: () => void;
}

/** 参数初值:schema default 优先;switch 兜底 false,其余兜底空串(必填缺口由 requiredParamLabel 卡控)。 */
function initialValues(app: AppItem): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const p of app.params_schema) {
    v[p.key] = p.default ?? (p.type === "switch" ? false : "");
  }
  return v;
}

export function AppRunnerView({ appId, onBack }: AppRunnerViewProps) {
  const toast = useToast();
  const [app, setApp] = useState<AppItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});

  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [results, setResults] = useState<string[]>([]);
  /** 卸载/重跑时中止在途 trackJob(后端作业仍继续,产物落作品库) */
  const abortRef = useRef<AbortController | null>(null);

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
    try {
      const receipt = await runApp(app.id, buildRunValues(app.params_schema, values));
      setRunning(true);
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
      setSubmitting(false);
      setRunning(false);
      setProgress(null);
    }
  }

  if (loading) {
    return (
      <div className="single-view apps-runner">
        <LoadingBlock variant="line" count={3} />
      </div>
    );
  }

  if (loadError || !app) {
    return (
      <div className="single-view apps-runner">
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
              返回市场
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="single-view apps-runner">
      <PageHeader
        icon={(app.icon || "package") as IconName}
        title={app.name}
        desc={app.description}
        onBack={onBack}
        backLabel="返回市场"
        actions={
          <span className="apps-usage" title="累计使用次数">
            {app.usage_count} 次使用
          </span>
        }
      />

      <ErrorBar message={runError} onClose={() => setRunError(null)} />

      <div className="apps-runner-form">
        {app.params_schema.map((p) => (
          <ParamField
            key={p.key}
            param={p}
            value={values[p.key]}
            onChange={onParamChange}
            disabled={submitting || running}
          />
        ))}
        <div className="apps-runner-submit">
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
        </div>
      </div>

      {running && (
        <p className="apps-run-status" role="status">
          <Icon name="loading" size={14} />
          {progress != null ? `生成中 ${progress}%` : "已提交,排队/生成中…"}
        </p>
      )}

      {results.length > 0 && (
        <div className="apps-results" aria-label="生成结果">
          {results.map((p) => {
            const url = imageUrl(p);
            const kind = mediaKindOf(p, app.output_kind);
            return (
              <div key={p} className="apps-result-card">
                {kind === "video" ? (
                  <video
                    className="apps-result-media"
                    src={url}
                    controls
                    playsInline
                    preload="metadata"
                  />
                ) : kind === "audio" ? (
                  <audio className="apps-result-media" src={url} controls />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="apps-result-media" src={url} alt={`${app.name} 产物`} loading="lazy" />
                )}
                <div className="apps-result-actions">
                  <a className="btn btn-sm" href={url} download>
                    <Icon name="download" size={14} />
                    下载
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

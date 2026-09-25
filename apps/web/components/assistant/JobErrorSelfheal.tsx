"use client";

/**
 * U1(2026-09-26):作业卡失败自愈条——大白话原因 + 一键重试 + 换一张同类卡。
 * 样式只走 assistant-view.css token,不引新 hex。
 */
import { useCallback, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { listApps, type AppItem } from "@/lib/apps";
import {
  jobKindToAppCategory,
  pickSimilarPassApps,
  plainJobErrorReason,
  jobCardCanRerun,
} from "@/lib/jobSelfheal";
import type { AgentJobCard } from "./AssistantView";

export interface JobErrorSelfhealProps {
  job: AgentJobCard;
  busy?: boolean;
  /** 一键重试(父组件:优先 rerunJob,否则打开原应用 / 重发对话)。 */
  onRetry: (job: AgentJobCard) => void | Promise<void>;
  /** 打开同类应用。 */
  onOpenApp: (appId: string) => void;
}

export function JobErrorSelfheal({
  job,
  busy = false,
  onRetry,
  onOpenApp,
}: JobErrorSelfhealProps): ReactNode {
  const reason = plainJobErrorReason(job.error, job.holdReason);
  const [retrying, setRetrying] = useState(false);
  const [similar, setSimilar] = useState<AppItem[] | null>(null);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarError, setSimilarError] = useState<string | null>(null);

  const handleRetry = useCallback(async () => {
    if (busy || retrying) return;
    setRetrying(true);
    try {
      await onRetry(job);
    } finally {
      setRetrying(false);
    }
  }, [busy, retrying, onRetry, job]);

  const handleSwap = useCallback(async () => {
    if (similarLoading) return;
    if (similar && similar.length) {
      // 已展开则收起
      setSimilar(null);
      setSimilarError(null);
      return;
    }
    setSimilarLoading(true);
    setSimilarError(null);
    try {
      const category = jobKindToAppCategory(job.kind);
      const apps = await listApps(
        category !== "all" ? { category } : undefined,
      );
      const picks = pickSimilarPassApps({
        excludeAppId: job.appId,
        category,
        apps,
        limit: 3,
      });
      // 若按 category 无命中,放宽到全库 PASS
      const final =
        picks.length > 0
          ? picks
          : pickSimilarPassApps({
              excludeAppId: job.appId,
              apps: await listApps(),
              limit: 3,
            });
      setSimilar(final);
      if (!final.length) setSimilarError("暂无同类可用卡,请稍后再试");
    } catch (e) {
      setSimilarError(e instanceof Error ? e.message : "加载同类卡失败");
      setSimilar([]);
    } finally {
      setSimilarLoading(false);
    }
  }, [similar, similarLoading, job.kind, job.appId]);

  const canEngineRerun = jobCardCanRerun(job);
  const retryTitle = canEngineRerun
    ? "用相同参数重新提交"
    : job.appId
      ? "打开原应用再次提交"
      : "重发上一条对话让助手再跑";

  return (
    <div className="av-job-error" role="status">
      <div className="av-job-error-reason">{reason}</div>
      <div className="av-job-error-actions">
        <button
          type="button"
          className="av-job-error-btn"
          onClick={() => void handleRetry()}
          disabled={busy || retrying}
          title={retryTitle}
        >
          <Icon name="refresh" size={12} strokeWidth={1.8} />
          <span>{retrying ? "重试中…" : "一键重试"}</span>
        </button>
        <button
          type="button"
          className="av-job-error-btn"
          onClick={() => void handleSwap()}
          disabled={similarLoading}
          title="推荐其他实测可用的同类应用"
        >
          <Icon name="layout-grid" size={12} strokeWidth={1.8} />
          <span>
            {similarLoading
              ? "查找中…"
              : similar && similar.length
                ? "收起同类卡"
                : "换一张同类卡"}
          </span>
        </button>
      </div>
      {similarError ? (
        <div className="av-job-error-hint">{similarError}</div>
      ) : null}
      {similar && similar.length ? (
        <ul className="av-job-similar">
          {similar.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="av-job-similar-item"
                onClick={() => onOpenApp(a.id)}
                title={a.description || a.name}
              >
                <span className="av-job-similar-name">{a.name}</span>
                <span className="av-job-similar-badge">实测可用</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

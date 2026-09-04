"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  captionDataset,
  imageUrl,
  listModels,
  listTrainJobs,
  registerLora,
  startTraining,
  trackTrainJob,
  uploadDataset,
} from "@/lib/api";
import type { TrainJob, TrainProgress, TrainStartParams } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { ServiceWakeOverlay } from "@/components/orch/ServiceWakeOverlay";
import { isWakeError, parseWakeError } from "@/lib/orch";

type JobStatus = TrainJob["status"];

const STATUS_META: Record<JobStatus, { label: string; tone: BadgeTone }> = {
  queued: { label: "排队中", tone: "neutral" },
  captioning: { label: "打标中", tone: "run" },
  training: { label: "训练中", tone: "run" },
  sampling: { label: "采样中", tone: "run" },
  done: { label: "已完成", tone: "ok" },
  error: { label: "失败", tone: "err" },
};

const ACTIVE_STATUSES: JobStatus[] = ["queued", "captioning", "training", "sampling"];

const DEFAULT_FORM: FormState = {
  name: "",
  base_ckpt: "",
  trigger_words: "",
  lr: 1e-4,
  steps: 1000,
  network_dim: 16,
  network_alpha: 8,
  resolution: 512,
  batch_size: 1,
  cuda_device: 0,
};

interface FormState {
  name: string;
  base_ckpt: string;
  trigger_words: string;
  lr: number;
  steps: number;
  network_dim: number;
  network_alpha: number;
  resolution: number;
  batch_size: number;
  cuda_device: number;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000;
    const hr = 60 * min;
    const day = 24 * hr;
    if (diff < min) return "刚刚";
    if (diff < hr) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hr)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    return d.toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

function pct(p: TrainProgress | null): number {
  if (!p || !p.total) return 0;
  return Math.max(0, Math.min(100, Math.round((p.step / p.total) * 100)));
}

export function TrainView() {
  const [jobs, setJobs] = useState<TrainJob[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [datasetFiles, setDatasetFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 冷层唤醒遮罩:503「冷层服务 {name} 唤醒失败」时显示;onClose 后复用同 error 状态
  const [wakeService, setWakeService] = useState<string | null>(null);
  const wakeAbortRef = useRef<AbortController | null>(null);

  const [registeringId, setRegisteringId] = useState<string | null>(null);
  const [registeredJobs, setRegisteredJobs] = useState<Set<string>>(new Set());
  const [registerMsg, setRegisterMsg] = useState<Record<string, string>>({});

  const trackingRef = useRef<Set<string>>(new Set());
  // 当前由本组件发起的活跃 SSE 连接(api 层 trackTrainJob 通过 register 回调暴露)。
  // api 层仅在 promise 终态(done/error)时主动 es.close();组件卸载时若 promise 仍 pending,
  // 需在此主动 close 以避免连接泄漏。
  const sseRef = useRef<Map<string, EventSource>>(new Map());
  // 每个在途跟踪的中止控制器:卸载时统一 abort,让 trackTrainJob 立即 settle
  // (只 close EventSource 不会让 Promise 落定,.finally 清理永不执行,跟踪闭包悬挂)
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  const [, setForceRender] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listTrainJobs()
      .then(setJobs)
      .catch((e) => setError(e instanceof Error ? e.message : "加载训练任务失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
    listModels()
      .then((res) => {
        const ckpts = res.checkpoints ?? [];
        setCheckpoints(ckpts);
        // 训练不暴露模型选择 UI,统一使用平台默认底模
        const def = res.modes?.image?.default ?? null;
        const defaultCkpt = def && ckpts.includes(def) ? def : ckpts[0] ?? "";
        if (defaultCkpt) {
          setForm((f) => (f.base_ckpt ? f : { ...f, base_ckpt: defaultCkpt }));
        }
      })
      .catch(() => setCheckpoints([]));
  }, [load]);

  const patchJob = useCallback((jobId: string, patch: Partial<TrainJob>) => {
    setJobs((prev) =>
      (prev ?? []).map((j) => (j.id === jobId ? { ...j, ...patch } : j)),
    );
  }, []);

  const trackJob = useCallback(
    (jobId: string) => {
      if (trackingRef.current.has(jobId)) return;
      trackingRef.current.add(jobId);

      const ac = new AbortController();
      abortRef.current.set(jobId, ac);

      trackTrainJob(jobId, {
        signal: ac.signal,
        onProgress: (p: TrainProgress) => {
          patchJob(jobId, { progress: p, status: "training" });
        },
        register: (es) => {
          // api 层在创建时回调 es,在终态时回调 null;据此维护本组件 sseRef
          if (es) {
            sseRef.current.set(jobId, es);
          } else {
            sseRef.current.delete(jobId);
          }
        },
      })
        .then(() => {
          patchJob(jobId, { status: "done" });
        })
        .catch((err) => {
          // 卸载触发的显式中止:静默——组件已卸载,不能按失败标 error
          if (err instanceof Error && err.name === "AbortError") return;
          patchJob(jobId, {
            status: "error",
            error: err instanceof Error ? err.message : "训练失败",
          });
        })
        .finally(() => {
          trackingRef.current.delete(jobId);
          sseRef.current.delete(jobId);
          abortRef.current.delete(jobId);
          setForceRender((n) => n + 1);
        });
    },
    [patchJob],
  );

  // 对列表中处于活跃态的任务启动 SSE 追踪
  useEffect(() => {
    if (!jobs) return;
    for (const j of jobs) {
      if (ACTIVE_STATUSES.includes(j.status) && !trackingRef.current.has(j.id)) {
        trackJob(j.id);
      }
    }
  }, [jobs, trackJob]);

  // 卸载时清空追踪集合,abort 所有在途跟踪(trackTrainJob 立即 settle 并自行关流),
  // 并兜底关闭所有活跃 SSE 连接。
  useEffect(() => {
    return () => {
      trackingRef.current.clear();
      abortRef.current.forEach((ac) => ac.abort());
      abortRef.current.clear();
      sseRef.current.forEach((es) => es.close());
      sseRef.current.clear();
    };
  }, []);

  const sortedJobs = useMemo(() => {
    if (!jobs) return [];
    const rank: Record<JobStatus, number> = {
      training: 0,
      sampling: 1,
      captioning: 2,
      queued: 3,
      error: 4,
      done: 5,
    };
    return [...jobs].sort((a, b) => {
      const ra = rank[a.status] ?? 9;
      const rb = rank[b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
  }, [jobs]);

  const updateForm = (key: keyof FormState, value: string | number) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list) return;
    setDatasetFiles(Array.from(list));
  };

  const handleSubmit = async () => {
    setSubmitError(null);
    setSubmitMsg(null);

    if (!form.name.trim()) {
      setSubmitError("请填写训练任务名称");
      return;
    }
    if (!form.base_ckpt) {
      setSubmitError("请选择底模");
      return;
    }
    if (!form.trigger_words.trim()) {
      setSubmitError("请填写触发词");
      return;
    }
    if (datasetFiles.length === 0) {
      setSubmitError("请上传训练数据集（图片）");
      return;
    }

    setSubmitting(true);
    wakeAbortRef.current?.abort();
    wakeAbortRef.current = new AbortController();
    const ac = wakeAbortRef.current;
    try {
      setSubmitMsg("正在上传数据集…");
      const up = await uploadDataset(datasetFiles);
      const jobId = up.job_id;

      setSubmitMsg("正在为数据集打标（Florence2）…");
      await captionDataset(jobId, form.cuda_device);

      setSubmitMsg("正在启动训练…");
      const params: TrainStartParams = {
        job_id: jobId,
        name: form.name.trim(),
        base_ckpt: form.base_ckpt,
        trigger_words: form.trigger_words.trim(),
        lr: form.lr,
        steps: form.steps,
        network_dim: form.network_dim,
        network_alpha: form.network_alpha,
        resolution: form.resolution,
        batch_size: form.batch_size,
        cuda_device: form.cuda_device,
      };
      await startTraining(params);

      // 后端已创建 job,直接重新拉取列表;SSE 追踪由下方 effect 接管。
      // 不再用乐观插入——避免后端实际未创建 job 时,作业永久停留且无 SSE 追踪。
      await load();

      // 关闭表单 + 重置
      setShowForm(false);
      setForm(DEFAULT_FORM);
      setDatasetFiles([]);
      setSubmitMsg(null);
    } catch (e) {
      const svc = parseWakeError(e);
      if (svc && !ac.signal.aborted) {
        setWakeService(svc);
      } else {
        setSubmitError(e instanceof Error ? e.message : "提交失败");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async (job: TrainJob) => {
    setRegisteringId(job.id);
    setRegisterMsg((prev) => ({ ...prev, [job.id]: "" }));
    try {
      const res = await registerLora(job.id);
      setRegisteredJobs((prev) => new Set(prev).add(job.id));
      setRegisterMsg((prev) => ({
        ...prev,
        [job.id]: `已注册：${res.lora_name}`,
      }));
    } catch (e) {
      setRegisterMsg((prev) => ({
        ...prev,
        [job.id]: e instanceof Error ? e.message : "注册失败",
      }));
    } finally {
      setRegisteringId(null);
    }
  };

  const cancelForm = () => {
    if (submitting) return;
    setShowForm(false);
    setForm(DEFAULT_FORM);
    setDatasetFiles([]);
    setSubmitError(null);
    setSubmitMsg(null);
  };

  const isEmpty = !loading && !error && sortedJobs.length === 0;

  return (
    <div className="single-view train-view">
      {/* 页头移除(2026-09-02 W3):操作收进窄工具行(右对齐) */}
      <div className="tv-mode-row">
        <button
          type="button"
          className="at-btn at-btn--ghost"
          onClick={() => void load()}
          disabled={loading}
        >
          <Icon name="refresh" size={14} />
          刷新
        </button>
        <button
          type="button"
          className="at-btn at-btn--primary"
          onClick={() => setShowForm((v) => !v)}
          disabled={submitting}
        >
          <Icon name="upload" size={14} />
          新建训练
        </button>
      </div>

      {showForm && (
        <section className="at-card tv-form-card">
          <div className="tv-form-head">
            <h2 className="tv-form-title">新建训练任务</h2>
            <button
              type="button"
              className="at-btn at-btn--ghost tv-form-close"
              onClick={cancelForm}
              disabled={submitting}
              aria-label="关闭表单"
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          <div className="tv-form-grid">
            <label className="tv-field tv-field-wide">
              <span className="tv-label">任务名称</span>
              <input
                className="input"
                placeholder="如：角色A_v1"
                value={form.name}
                onChange={(e) => updateForm("name", e.target.value)}
                disabled={submitting}
              />
            </label>

            <label className="tv-field tv-field-wide">
              <span className="tv-label">底模</span>
              {/* 模型锁定:训练不暴露底模选择 UI,统一使用平台默认底模(只读展示) */}
              <div className="tv-ckpt-readonly">
                {form.base_ckpt ? (
                  <Badge tone="accent" dot={false} title="平台默认底模">
                    {form.base_ckpt}
                  </Badge>
                ) : (
                  <span className="tv-ckpt-loading">加载底模…</span>
                )}
              </div>
            </label>

            <label className="tv-field tv-field-wide">
              <div className="tv-label-row">
                <span className="tv-label">触发词</span>
                <OptimizeButton
                  prompt={form.trigger_words}
                  kind="train"
                  onOptimized={(t) => updateForm("trigger_words", t)}
                  disabled={submitting}
                  label="优化触发词"
                />
              </div>
              <input
                className="input"
                placeholder="如：zhenyu_girl"
                value={form.trigger_words}
                onChange={(e) => updateForm("trigger_words", e.target.value)}
                disabled={submitting}
              />
            </label>

            <label className="tv-field">
              <span className="tv-label">学习率 LR</span>
              <input
                className="input"
                type="number"
                step="0.00001"
                min="0"
                value={form.lr}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  // 学习率必须 > 0;NaN / 负数 / 0 兜底为上一次有效值,避免无效提交
                  updateForm("lr", Number.isFinite(v) && v > 0 ? v : form.lr);
                }}
                disabled={submitting}
              />
            </label>

            <label className="tv-field">
              <span className="tv-label">步数 Steps</span>
              <input
                className="input"
                type="number"
                min="1"
                value={form.steps}
                onChange={(e) => updateForm("steps", parseInt(e.target.value, 10) || 0)}
                disabled={submitting}
              />
            </label>

            <label className="tv-field">
              <span className="tv-label">网络维度 Dim</span>
              <input
                className="input"
                type="number"
                min="1"
                value={form.network_dim}
                onChange={(e) => updateForm("network_dim", parseInt(e.target.value, 10) || 0)}
                disabled={submitting}
              />
            </label>

            <label className="tv-field">
              <span className="tv-label">网络 Alpha</span>
              <input
                className="input"
                type="number"
                min="0"
                value={form.network_alpha}
                onChange={(e) => updateForm("network_alpha", parseInt(e.target.value, 10) || 0)}
                disabled={submitting}
              />
            </label>

            <label className="tv-field">
              <span className="tv-label">分辨率</span>
              <input
                className="input"
                type="number"
                min="64"
                step="64"
                value={form.resolution}
                onChange={(e) => updateForm("resolution", parseInt(e.target.value, 10) || 0)}
                disabled={submitting}
              />
            </label>

            <label className="tv-field">
              <span className="tv-label">批次大小</span>
              <input
                className="input"
                type="number"
                min="1"
                value={form.batch_size}
                onChange={(e) => updateForm("batch_size", parseInt(e.target.value, 10) || 1)}
                disabled={submitting}
              />
            </label>

            <label className="tv-field">
              <span className="tv-label">GPU 设备</span>
              <input
                className="input"
                type="number"
                min="0"
                value={form.cuda_device}
                onChange={(e) => updateForm("cuda_device", parseInt(e.target.value, 10) || 0)}
                disabled={submitting}
              />
            </label>

            <div className="tv-field tv-field-wide">
              <span className="tv-label">数据集图片</span>
              <div className="tv-upload-row">
                <label className="at-btn at-btn--ghost tv-upload-btn">
                  <Icon name="upload" size={14} />
                  选择图片
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={onPickFiles}
                    disabled={submitting}
                    style={{ display: "none" }}
                  />
                </label>
                <span className="tv-upload-hint">
                  {datasetFiles.length > 0
                    ? `已选 ${datasetFiles.length} 张`
                    : "至少选择 1 张训练图片"}
                </span>
              </div>
            </div>
          </div>

          {submitError && (
            <ErrorBar
              className="tv-form-msg-slot"
              message={submitError}
              onClose={() => setSubmitError(null)}
            />
          )}
          {submitMsg && (
            <div className="tv-form-msg tv-form-msg-info">
              <Icon name="loading" size={14} />
              {submitMsg}
            </div>
          )}

          <div className="tv-form-actions">
            <button
              type="button"
              className="at-btn at-btn--ghost"
              onClick={cancelForm}
              disabled={submitting}
            >
              取消
            </button>
            <button
              type="button"
              className="at-btn at-btn--primary"
              onClick={() => void handleSubmit()}
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Icon name="loading" size={14} />
                  提交中…
                </>
              ) : (
                "开始训练"
              )}
            </button>
          </div>
        </section>
      )}

      <div className="tv-body">
        {error && !loading && (
          <div className="tv-error-row">
            <ErrorBar message={error} onClose={() => setError(null)} />
            <button type="button" className="at-btn at-btn--ghost" onClick={() => void load()}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        )}

        {loading && !jobs && (
          <LoadingBlock variant="line" count={4} className="tv-loading" />
        )}

        {isEmpty && (
          <Empty
            icon="train"
            title="还没有训练任务"
            desc="点击「新建训练」上传数据集开始第一次 LoRA 训练"
          />
        )}

        {!error && !loading && sortedJobs.length > 0 && (
          <div className="tv-list">
            {sortedJobs.map((job) => (
              <TrainCard
                key={job.id}
                job={job}
                isRegistered={registeredJobs.has(job.id)}
                isRegistering={registeringId === job.id}
                registerMsg={registerMsg[job.id]}
                onRegister={() => void handleRegister(job)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 冷层唤醒遮罩:503「冷层服务 {name} 唤醒失败」时显示;取消时中断在途请求 */}
      {wakeService && (
        <ServiceWakeOverlay
          serviceName={wakeService}
          visible={!!wakeService}
          onCancel={() => {
            wakeAbortRef.current?.abort();
            setWakeService(null);
          }}
          onClose={() => setWakeService(null)}
        />
      )}

      <style jsx>{`
        .train-view {
          /* 2026-08-24 密度优化:壳层 .single-view 已供顶/底节奏,本视图只留微呼吸 */
          padding-top: var(--space-2);
          padding-bottom: var(--space-2);
        }

        /* ── 工具行(2026-09-02 W3 页头移除:刷新/新建训练右对齐窄行) ── */
        .tv-mode-row {
          display: flex;
          justify-content: flex-end;
          gap: var(--space-2);
          padding: 0 0 var(--space-3);
        }

        /* ── Form ── */
        .tv-form-card {
          margin-bottom: var(--space-4);
          padding: var(--space-4);
          background: var(--bg-surface-1);
          border-color: var(--border-strong);
          box-shadow: var(--shadow-md);
        }
        .tv-form-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          margin-bottom: var(--space-3);
        }
        .tv-form-title {
          margin: 0;
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          letter-spacing: -0.01em;
        }
        .tv-form-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: var(--space-4);
        }
        .tv-field {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          min-width: 0;
        }
        .tv-field-wide {
          grid-column: span 2;
        }
        @media (max-width: 767px) {
          .tv-field-wide {
            grid-column: span 1;
          }
          .tv-form-card {
            padding: var(--space-4);
          }
        }
        .tv-label {
          font-size: var(--text-label);
          color: var(--text-secondary);
          font-weight: var(--font-medium);
          letter-spacing: 0.01em;
        }
        .tv-label-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-2);
        }
        .tv-ckpt-loading {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .tv-upload-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          flex-wrap: wrap;
        }
        .tv-upload-btn {
          cursor: pointer;
          flex-shrink: 0;
        }
        .tv-upload-hint {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .tv-form-msg {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          margin-top: var(--space-4);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-badge);
          font-size: var(--text-aux);
          line-height: 1.5;
        }
        /* ErrorBar 位(原 tv-form-msg-error 槽位):只补外边距,视觉走 ui-error-bar */
        .tv-form-msg-slot {
          margin-top: var(--space-4);
        }
        .tv-form-msg-info {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .tv-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: var(--space-2);
          margin-top: var(--space-4);
          padding-top: var(--space-3);
          border-top: 1px solid var(--border-subtle);
        }

        /* ── Body ── */
        .tv-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }
        /* 加载失败:ErrorBar + 重试按钮横排 */
        .tv-error-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
        }
        .tv-error-row :global(.ui-error-bar) {
          flex: 1;
          min-width: 0;
        }
        .tv-loading {
          padding: var(--space-4) 0;
        }

        /* 空态重设计:图标改为浅底圆盘,拉开与标题的层级 */
        .train-view .empty-state-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 72px;
          height: 72px;
          border-radius: var(--radius-full);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          opacity: 1;
          color: var(--text-muted);
          margin-bottom: var(--space-5);
        }

        /* ── Job List ── */
        .tv-list {
          display: flex;
          flex-direction: column;
          gap: var(--section-gap);
        }

        /* 移动端触控目标 ≥44px(页头操作区在 PageHeader 组件内,须 :global 命中) */
        @media (max-width: 767px) {
          .train-view :global(.page-header-actions) .at-btn,
          .tv-form-head .at-btn,
          .tv-form-actions .at-btn,
          .tv-upload-btn {
            min-height: 44px;
          }
        }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 单个训练任务卡片
// ────────────────────────────────────────────────────────────

interface TrainCardProps {
  job: TrainJob;
  isRegistered: boolean;
  isRegistering: boolean;
  registerMsg?: string;
  onRegister: () => void;
}

function TrainCard({
  job,
  isRegistered,
  isRegistering,
  registerMsg,
  onRegister,
}: TrainCardProps) {
  const meta = STATUS_META[job.status];
  const isActive = ACTIVE_STATUSES.includes(job.status);
  const isDone = job.status === "done";
  const isError = job.status === "error";
  const progress = job.progress;
  const progressPct = pct(progress);
  const showRegisterBtn = isDone && job.lora_path && !isRegistered;
  const showRegisteredTag = isDone && isRegistered;

  return (
    <article className="at-card tv-card">
      <div className="tv-card-head">
        <div className="tv-card-title-wrap">
          <h3 className="tv-card-title">{job.name || "未命名任务"}</h3>
          <Badge tone={meta.tone} dotPulse={isActive}>
            {meta.label}
          </Badge>
        </div>
        <span className="tv-card-time">{formatTime(job.created_at)}</span>
      </div>

      <div className="tv-card-meta">
        <div className="tv-meta-item">
          <span className="tv-meta-key">底模</span>
          <span className="tv-meta-val tv-mono">{job.base_ckpt || "—"}</span>
        </div>
        <div className="tv-meta-item">
          <span className="tv-meta-key">触发词</span>
          <span className="tv-meta-val tv-mono">{job.trigger_words || "—"}</span>
        </div>
        <div className="tv-meta-item">
          <span className="tv-meta-key">学习率</span>
          <span className="tv-meta-val tv-mono">{job.lr ?? "—"}</span>
        </div>
        <div className="tv-meta-item">
          <span className="tv-meta-key">步数</span>
          <span className="tv-meta-val tv-mono">
            {progress ? `${progress.step}/${progress.total}` : `${job.steps ?? "—"}`}
          </span>
        </div>
        <div className="tv-meta-item">
          <span className="tv-meta-key">维度</span>
          <span className="tv-meta-val tv-mono">{job.network_dim ?? "—"}</span>
        </div>
        <div className="tv-meta-item">
          <span className="tv-meta-key">GPU</span>
          <span className="tv-meta-val tv-mono">{job.cuda_device ?? "—"}</span>
        </div>
      </div>

      {(isActive || isDone) && progress && (
        <div className="tv-progress-wrap">
          <div className="tv-progress-track">
            <div
              className="tv-progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="tv-progress-info">
            <span className="tv-progress-pct">{progressPct}%</span>
            {progress.loss > 0 && (
              <span className="tv-progress-loss">
                loss · {progress.loss.toFixed(4)}
              </span>
            )}
          </div>
        </div>
      )}

      {progress && progress.recent_losses && progress.recent_losses.length > 1 && (
        <LossSparkline values={progress.recent_losses} />
      )}

      {isError && (
        <div className="tv-card-error">
          <Icon name="error" size={14} />
          <span>{job.error || "训练失败"}</span>
        </div>
      )}

      {isDone && job.sample_urls && job.sample_urls.length > 0 && (
        <div className="tv-samples">
          <div className="tv-samples-label">样本图</div>
          <div className="tv-samples-grid">
            {job.sample_urls.map((url, i) => (
              <a
                key={i}
                className="tv-sample"
                href={imageUrl(url)}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={imageUrl(url)}
                  alt={`样本 ${i + 1}`}
                  loading="lazy"
                  decoding="async"
                />
              </a>
            ))}
          </div>
        </div>
      )}

      {(showRegisterBtn || showRegisteredTag || registerMsg) && (
        <div className="tv-card-foot">
          {showRegisterBtn && (
            <button
              type="button"
              className="at-btn at-btn--primary"
              onClick={onRegister}
              disabled={isRegistering}
            >
              {isRegistering ? (
                <>
                  <Icon name="loading" size={14} />
                  注册中…
                </>
              ) : (
                <>
                  <Icon name="train" size={14} />
                  注册到可用 LoRA
                </>
              )}
            </button>
          )}
          {showRegisteredTag && (
            <Badge tone="ok" dot={false}>
              <Icon name="success" size={12} />
              已注册
            </Badge>
          )}
          {registerMsg && (
            <span className="tv-register-msg">{registerMsg}</span>
          )}
        </div>
      )}

      <style jsx>{`
        .tv-card {
          padding: var(--space-4);
          transition:
            border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard);
        }
        .tv-card:hover {
          border-color: var(--border-strong);
          box-shadow: var(--shadow-md);
          transform: translateY(-2px);
        }
        @media (max-width: 767px) {
          .tv-card {
            padding: var(--space-4);
          }
        }

        .tv-card-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--space-3);
          margin-bottom: var(--space-4);
        }
        .tv-card-title-wrap {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
          min-width: 0;
        }
        .tv-card-title {
          margin: 0;
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          letter-spacing: -0.01em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
          max-width: 100%;
        }
        .tv-card-time {
          font-size: var(--text-aux);
          color: var(--text-muted);
          white-space: nowrap;
          flex-shrink: 0;
        }

        /* ── Meta:由上下细线分隔带改为浅底内嵌面板,拉开与标题/进度的层级 ── */
        .tv-card-meta {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: var(--space-3) var(--space-5);
          padding: var(--space-4);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .tv-meta-item {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          min-width: 0;
        }
        .tv-meta-key {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .tv-meta-val {
          font-size: var(--text-body);
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tv-mono {
          font-family: var(--font-mono);
          font-size: var(--text-aux);
        }

        /* ── Progress ── */
        .tv-progress-wrap {
          margin-top: var(--space-4);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .tv-progress-track {
          height: 8px;
          background: var(--bg-surface-2);
          border-radius: var(--radius-full);
          overflow: hidden;
        }
        .tv-progress-fill {
          height: 100%;
          background: var(--run);
          border-radius: var(--radius-full);
          transition: width var(--duration-base) var(--ease-standard);
        }
        .tv-progress-info {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .tv-progress-loss {
          color: var(--accent);
        }

        /* ── Error ── */
        .tv-card-error {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          margin-top: var(--space-4);
          padding: var(--space-3) var(--space-4);
          background: var(--err-soft);
          color: var(--err);
          border-radius: var(--radius-control);
          font-size: var(--text-aux);
          line-height: 1.5;
        }

        /* ── Samples ── */
        .tv-samples {
          margin-top: var(--space-4);
        }
        .tv-samples-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin-bottom: var(--space-2);
        }
        .tv-samples-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
          gap: var(--space-3);
        }
        .tv-sample {
          display: block;
          aspect-ratio: 1 / 1;
          overflow: hidden;
          border-radius: var(--radius-control);
          border: 1px solid var(--border-subtle);
          background: var(--bg-surface-2);
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .tv-sample:hover {
          border-color: var(--border-strong);
        }
        .tv-sample img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          transition: transform var(--duration-fast) var(--ease-standard);
        }
        .tv-sample:hover img {
          transform: scale(1.04);
        }

        /* ── Footer ── */
        .tv-card-foot {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          margin-top: var(--space-4);
          padding-top: var(--space-4);
          border-top: 1px solid var(--border-subtle);
          flex-wrap: wrap;
        }
        .tv-register-msg {
          font-size: var(--text-aux);
          color: var(--text-secondary);
        }

        /* 移动端触控目标 ≥44px */
        @media (max-width: 767px) {
          .tv-card-foot .at-btn {
            min-height: 44px;
          }
        }
      `}</style>
    </article>
  );
}

// ────────────────────────────────────────────────────────────
// Loss 折线 sparkline（纯 SVG,无依赖）
// ────────────────────────────────────────────────────────────

function LossSparkline({ values }: { values: number[] }) {
  const w = 100;
  const h = 28;
  const rawPts = values.length > 0 ? values : [0];
  // 长训练可能累积万步 loss,展开运算符 Math.min(...pts) 会栈溢出;
  // 同时 SVG 上千 polyline 点也会过载 → 降采样到 ≤1000 点
  const pts =
    rawPts.length > 1000
      ? rawPts.filter(
          (_, i) => i % Math.ceil(rawPts.length / 1000) === 0,
        )
      : rawPts;

  // 用 reduce 计算 min/max,避免 Math.min(...pts) / Math.max(...pts) 栈溢出
  const min = pts.reduce((a, b) => Math.min(a, b), pts[0]);
  const max = pts.reduce((a, b) => Math.max(a, b), pts[0]);
  const range = max - min || 1;

  const coords = pts.map((v, i) => {
    const x = pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const path = coords.join(" ");

  return (
    <div className="tv-spark-wrap">
      <span className="tv-spark-label">loss 曲线</span>
      <svg
        className="tv-spark"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="loss 曲线"
      >
        <polyline
          points={path}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <style jsx>{`
        .tv-spark-wrap {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          margin-top: var(--space-2);
        }
        .tv-spark-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          white-space: nowrap;
        }
        .tv-spark {
          flex: 1;
          height: 28px;
          opacity: 0.9;
        }
      `}</style>
    </div>
  );
}

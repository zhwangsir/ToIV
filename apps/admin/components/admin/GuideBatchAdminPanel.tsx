"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  backfillGuideRelations,
  fetchGuidesBatchStatus,
  generateGuidesBatch,
  listAdminGuides,
  publishAllGuides,
  type AdminGuideItem,
} from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";

/** 批量生成状态轮询周期(后端单飞,status 端点轻量)。 */
const POLL_MS = 3_000;

type StatusFilter = "all" | "draft" | "published";

interface BatchSummary {
  done: number;
  failed: { id: string; error: string }[];
  finished_at: string;
}

/** 相对时间格式化(与 AdminView 同口径)。 */
function formatTime(iso: string | null): string {
  if (!iso) return "—";
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

/**
 * D3 说明书批量操作面板(2026-09-22):全量列表(草稿/发布筛选)+ 批量生成
 * (单飞,3s 轮询)+ 全部发布 + 关联回填。单卡编辑仍在「单卡编辑」子页。
 */
export function GuideBatchAdminPanel({
  apps,
  onEditApp,
}: {
  /** 应用目录(join 应用名用;AppGuidesAdminView 挂载时已加载,直接复用)。 */
  apps: { id: string; name: string }[] | null;
  /** 点击列表行跳回单卡编辑。 */
  onEditApp?: (appId: string) => void;
}) {
  const [guides, setGuides] = useState<AdminGuideItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // 批量生成
  const [genOpen, setGenOpen] = useState(false);
  const [genLimit, setGenLimit] = useState("50");
  const [genOnlyMissing, setGenOnlyMissing] = useState(true);
  const [genError, setGenError] = useState<string | null>(null);
  const [genStarting, setGenStarting] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [summary, setSummary] = useState<BatchSummary | null>(null);

  // 全部发布
  const [pubOpen, setPubOpen] = useState(false);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubError, setPubError] = useState<string | null>(null);

  const [backfillBusy, setBackfillBusy] = useState(false);

  const nameOf = useCallback(
    (appId: string) => apps?.find((a) => a.id === appId)?.name ?? "",
    [apps],
  );

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listAdminGuides()
      .then(setGuides)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "说明书列表加载失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 进入面板先探一次:可能已有批次在跑(单飞),在跑则接管轮询
  useEffect(() => {
    fetchGuidesBatchStatus()
      .then((st) => {
        if (st.summary) setSummary(st.summary);
        if (st.running) setBatchRunning(true);
      })
      .catch(() => undefined);
  }, []);

  // 批量生成进行中:3s 轮询,结束落汇总并刷新列表
  useEffect(() => {
    if (!batchRunning) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await fetchGuidesBatchStatus();
        if (cancelled) return;
        if (st.summary) setSummary(st.summary);
        if (!st.running) {
          setBatchRunning(false);
          load();
        }
      } catch {
        /* 瞬时失败继续下轮 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batchRunning, load]);

  const visible = useMemo(() => {
    const list = guides ?? [];
    if (filter === "all") return list;
    return list.filter((g) => g.status === filter);
  }, [guides, filter]);

  const draftCount = useMemo(
    () => (guides ?? []).filter((g) => g.status === "draft").length,
    [guides],
  );

  const openGenerate = () => {
    setGenError(null);
    setGenLimit("50");
    setGenOnlyMissing(true);
    setGenOpen(true);
  };

  const onGenConfirm = async () => {
    const parsed = parseInt(genLimit, 10);
    const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : 50;
    setGenStarting(true);
    setGenError(null);
    try {
      const r = await generateGuidesBatch({ limit, only_missing: genOnlyMissing });
      if (!r.started) {
        setGenError(r.reason ?? "无待生成目标");
        return;
      }
      setGenOpen(false);
      setSummary(null);
      setBatchRunning(true);
      setOkMsg(`已启动批量生成(计划 ${r.planned} 条)`);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "批量生成触发失败");
    } finally {
      setGenStarting(false);
    }
  };

  const openPublish = () => {
    setPubError(null);
    setPubOpen(true);
  };

  const onPubConfirm = async () => {
    setPubBusy(true);
    setPubError(null);
    try {
      const r = await publishAllGuides();
      setPubOpen(false);
      setOkMsg(`已发布 ${r.published} 条草稿`);
      load();
    } catch (err) {
      setPubError(err instanceof Error ? err.message : "批量发布失败");
    } finally {
      setPubBusy(false);
    }
  };

  const onBackfill = async () => {
    setBackfillBusy(true);
    setOkMsg(null);
    try {
      const r = await backfillGuideRelations();
      setOkMsg(`关联回填完成:回填 ${r.done} · 跳过 ${r.skipped}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "关联回填失败");
    } finally {
      setBackfillBusy(false);
    }
  };

  return (
    <div className="gb-panel">
      <div className="gb-toolbar at-card">
        <span className="gb-counts">
          {loading
            ? "加载中…"
            : `共 ${guides?.length ?? 0} 条 · 草稿 ${draftCount} · 已发布 ${
                (guides?.length ?? 0) - draftCount
              }`}
        </span>
        <span className="gb-actions">
          <button
            type="button"
            className="at-btn at-btn--primary"
            onClick={openGenerate}
            disabled={batchRunning}
            title={batchRunning ? "已有批次在跑(单飞)" : "批量生成说明书"}
          >
            <Icon name={batchRunning ? "loading" : "sparkles"} size={14} />
            批量生成
          </button>
          <button
            type="button"
            className="at-btn at-btn--ghost"
            onClick={openPublish}
            disabled={loading || draftCount === 0 || batchRunning}
            title={draftCount === 0 ? "当前没有草稿" : `发布全部 ${draftCount} 条草稿`}
          >
            <Icon name="check" size={14} />
            全部发布{draftCount > 0 ? `(${draftCount})` : ""}
          </button>
          <button
            type="button"
            className="at-btn at-btn--ghost"
            onClick={() => void onBackfill()}
            disabled={backfillBusy || batchRunning}
            title="按相似度确定性回填已发布卡的关联应用"
          >
            <Icon name={backfillBusy ? "loading" : "link"} size={14} />
            {backfillBusy ? "回填中…" : "关联回填"}
          </button>
          <button
            type="button"
            className="at-btn at-btn--ghost"
            onClick={load}
            disabled={loading}
            title="刷新列表"
          >
            <Icon name="refresh" size={14} />
          </button>
        </span>
      </div>

      {error && <ErrorBar message={error} onClose={() => setError(null)} />}
      {okMsg && <div className="gb-ok">{okMsg}</div>}

      {batchRunning && (
        <div className="gb-progress" role="status">
          <Icon name="loading" size={14} />
          批量生成进行中(单飞),每 {POLL_MS / 1000}s 刷新一次状态…
        </div>
      )}

      {!batchRunning && summary && (
        <div className="gb-summary at-card">
          <div className="gb-summary-head">
            最近一批:完成 {summary.done} · 失败 {summary.failed.length} · 结束于{" "}
            {formatTime(summary.finished_at)}
          </div>
          {summary.failed.length > 0 && (
            <ul className="gb-failed-list">
              {summary.failed.map((f) => (
                <li key={f.id}>
                  <span className="gb-failed-id" title={f.id}>
                    {nameOf(f.id) || f.id}
                  </span>
                  <span className="gb-failed-err" title={f.error}>
                    {f.error}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="gb-filter-row">
        {(
          [
            { key: "all", label: "全部" },
            { key: "draft", label: "草稿" },
            { key: "published", label: "已发布" },
          ] as { key: StatusFilter; label: string }[]
        ).map((c) => (
          <button
            key={c.key}
            type="button"
            className={`gb-chip${filter === c.key ? " is-active" : ""}`}
            onClick={() => setFilter(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="at-card gb-card">
        {loading && <LoadingBlock variant="line" count={4} className="gb-loading" />}
        {!loading && visible.length === 0 && (
          <Empty
            size="section"
            icon="file"
            title="无说明书"
            desc={
              filter === "all"
                ? "还没有说明书,点「批量生成」开跑"
                : "当前筛选条件下没有说明书"
            }
          />
        )}
        {!loading && visible.length > 0 && (
          <div className="gb-table-wrap">
            <table className="gb-table">
              <thead>
                <tr>
                  <th>应用</th>
                  <th className="gb-col-status">状态</th>
                  <th className="gb-col-time">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((g) => (
                  <tr
                    key={g.app_id}
                    className="gb-row"
                    onClick={() => onEditApp?.(g.app_id)}
                    title={onEditApp ? "点击跳到单卡编辑" : undefined}
                  >
                    <td>
                      <span className="gb-app-name">{nameOf(g.app_id) || g.app_id}</span>
                      <span className="gb-app-id">{g.app_id}</span>
                    </td>
                    <td className="gb-col-status">
                      <Badge tone={g.status === "published" ? "ok" : "warn"}>
                        {g.status === "published" ? "已发布" : "草稿"}
                      </Badge>
                    </td>
                    <td className="gb-col-time">
                      <span className="gb-time" title={g.updated_at ?? ""}>
                        {formatTime(g.updated_at)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 批量生成确认:limit + only_missing */}
      <Modal
        open={genOpen}
        onClose={() => setGenOpen(false)}
        title="批量生成说明书"
        preventClose={genStarting}
        width={420}
        footer={
          <>
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={genStarting}
              onClick={() => setGenOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="at-btn at-btn--primary"
              disabled={genStarting}
              onClick={() => void onGenConfirm()}
            >
              <Icon name={genStarting ? "loading" : "sparkles"} size={14} />
              {genStarting ? "启动中…" : "开始生成"}
            </button>
          </>
        }
      >
        <div className="gb-gen-form">
          <label className="gb-field">
            <span className="gb-label">本次上限(1-500)</span>
            <input
              type="number"
              className="input"
              min={1}
              max={500}
              value={genLimit}
              onChange={(e) => setGenLimit(e.target.value)}
              disabled={genStarting}
            />
          </label>
          <Switch
            checked={genOnlyMissing}
            onChange={setGenOnlyMissing}
            disabled={genStarting}
            label="仅补缺(跳过已有说明书的应用)"
            ariaLabel="仅补缺"
          />
          <p className="gb-hint">
            后端单飞执行:同时只能有一个批次;启动后本面板每 {POLL_MS / 1000}s
            轮询进度,可随时离开稍后再看汇总。
          </p>
          {genError && <div className="gb-form-error">{genError}</div>}
        </div>
      </Modal>

      {/* 全部发布确认 */}
      <Modal
        open={pubOpen}
        onClose={() => setPubOpen(false)}
        title="全部发布"
        preventClose={pubBusy}
        width={420}
        footer={
          <>
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={pubBusy}
              onClick={() => setPubOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="at-btn at-btn--primary"
              disabled={pubBusy}
              onClick={() => void onPubConfirm()}
            >
              <Icon name={pubBusy ? "loading" : "check"} size={14} />
              {pubBusy ? "发布中…" : "确认发布"}
            </button>
          </>
        }
      >
        <div className="gb-gen-form">
          <p className="gb-hint">
            将把当前 <strong>{draftCount}</strong> 条草稿说明书全部置为已发布,
            发布后前台立即可见。
          </p>
          {pubError && <div className="gb-form-error">{pubError}</div>}
        </div>
      </Modal>

      <style jsx>{`
        .gb-panel {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .gb-toolbar {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-3);
          flex-wrap: wrap;
        }
        .gb-counts {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
        }
        .gb-actions {
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .gb-ok {
          padding: 8px 12px;
          border-radius: var(--radius-md);
          background: color-mix(in srgb, var(--accent) 12%, transparent);
          color: var(--text-primary);
          font-size: var(--text-body);
        }
        .gb-progress {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: 8px 12px;
          border-radius: var(--radius-md);
          border: 1px dashed var(--border-strong);
          color: var(--text-secondary);
          font-size: var(--text-body);
        }
        .gb-summary {
          padding: var(--space-3);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .gb-summary-head {
          font-size: var(--text-body);
          color: var(--text-secondary);
          font-variant-numeric: tabular-nums;
        }
        .gb-failed-list {
          list-style: none;
          margin: 0;
          padding: 0;
          max-height: 160px;
          overflow: auto;
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          font-size: var(--text-aux);
        }
        .gb-failed-list li {
          display: flex;
          gap: var(--space-2);
          align-items: baseline;
          min-width: 0;
        }
        .gb-failed-id {
          flex-shrink: 0;
          font-weight: var(--font-semibold);
          color: var(--text-primary);
        }
        .gb-failed-err {
          color: var(--err);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .gb-filter-row {
          display: inline-flex;
          gap: var(--space-2);
          align-self: flex-start;
        }
        .gb-chip {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          background: var(--bg-surface-1);
          color: var(--text-secondary);
          font-size: var(--text-aux);
          padding: 2px var(--space-3);
          min-height: 28px;
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .gb-chip:hover {
          border-color: var(--border-strong);
        }
        .gb-chip.is-active {
          background: var(--accent-soft);
          border-color: var(--accent-halo);
          color: var(--accent);
          font-weight: var(--font-medium);
        }

        .gb-card {
          padding: 0;
          overflow: hidden;
        }
        .gb-loading {
          padding: var(--space-4);
        }
        .gb-table-wrap {
          overflow-x: auto;
          max-height: 60vh;
          overflow-y: auto;
        }
        .gb-table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--text-body);
        }
        .gb-table thead th {
          position: sticky;
          top: 0;
          z-index: 1;
          text-align: left;
          padding: var(--space-3) var(--space-5);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted);
          background: var(--bg-surface-2);
          border-bottom: 1px solid var(--border-strong);
          white-space: nowrap;
        }
        .gb-table tbody td {
          padding: var(--space-3) var(--space-5);
          border-bottom: 1px solid var(--border-subtle);
          vertical-align: middle;
          color: var(--text-secondary);
        }
        .gb-table tbody tr {
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .gb-table tbody tr:nth-child(even) {
          background: var(--bg-surface-2);
        }
        .gb-table tbody tr:hover {
          background: var(--accent-soft);
        }
        .gb-row {
          cursor: pointer;
        }
        .gb-app-name {
          display: block;
          color: var(--text-primary);
          font-weight: var(--font-medium);
        }
        .gb-app-id {
          display: block;
          font-size: var(--text-caption);
          color: var(--text-tertiary);
          font-family: var(--font-mono);
        }
        .gb-col-status {
          width: 110px;
        }
        .gb-col-time {
          width: 130px;
        }
        .gb-time {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }

        .gb-gen-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
        }
        .gb-field {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .gb-label {
          font-size: var(--text-aux);
          color: var(--text-secondary);
          font-weight: var(--font-medium);
        }
        .gb-hint {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.55;
        }
        .gb-form-error {
          padding: var(--space-2) var(--space-3);
          background: var(--err-soft);
          border: 1px solid var(--err);
          border-radius: var(--radius-badge);
          color: var(--err);
          font-size: var(--text-aux);
          line-height: 1.45;
        }
      `}</style>
    </div>
  );
}

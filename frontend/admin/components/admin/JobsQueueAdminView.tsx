"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  cancelJob,
  deleteJob,
  fetchAdminJobs,
  fetchAdminTrash,
  permanentDeleteJob,
  rerunJob,
  restoreJob,
} from "@/lib/api";
import type { JobItem, TrashJobItem } from "@/lib/types";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { Switch } from "@/components/ui/Switch";

/** 单页限量(与后端 /api/jobs 上限 200 留余量);「加载更多」按 offset 累加。 */
const PAGE_LIMIT = 100;

/** 终态集合:与后端作业状态机一致(cancel 仅非终态可发,409=已终态)。 */
const TERMINAL = new Set(["done", "error", "canceled"]);

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "全部状态" },
  { value: "queued", label: "排队中" },
  { value: "running", label: "运行中" },
  { value: "held", label: "等待资源" },
  { value: "done", label: "完成" },
  { value: "error", label: "失败" },
  { value: "canceled", label: "已取消" },
];

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  held: "等待资源",
  done: "完成",
  error: "失败",
  canceled: "已取消",
};

const STATUS_TONE: Record<string, BadgeTone> = {
  queued: "warn",
  running: "run",
  held: "warn",
  done: "ok",
  error: "err",
  canceled: "neutral",
};

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

function statusTone(s: string): BadgeTone {
  return STATUS_TONE[s] ?? "neutral";
}

/** 相对时间格式化(与 AdminView 同口径:刚刚 / N 分钟前 / … / 日期)。 */
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

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 属主展示:优先 email,否则 user_id 截 8 位,都空显示占位。 */
function ownerLabel(j: JobItem): string {
  if (j.user_email) return j.user_email;
  if (j.user_id) return truncate(j.user_id, 8);
  return "—";
}

/**
 * Admin P1 作业队列域(2026-09-22):全员作业(all=1)行内操作 + 回收站管理。
 * 审计实数:job.delete 占全部动作 57%——最高频运营场景;行内操作走后端 admin 旁路。
 */
export function JobsQueueAdminView() {
  const [trashView, setTrashView] = useState(false);
  const [status, setStatus] = useState("");
  const [kindInput, setKindInput] = useState("");
  const [kind, setKind] = useState("");
  const [ownerQ, setOwnerQ] = useState("");

  const [rows, setRows] = useState<JobItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [opError, setOpError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<JobItem | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<TrashJobItem | null>(null);

  const load = useCallback(
    async (offset: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const page: JobItem[] = trashView
          ? await fetchAdminTrash(offset, PAGE_LIMIT)
          : await fetchAdminJobs({
              limit: PAGE_LIMIT,
              offset,
              status: status || undefined,
              kind: kind || undefined,
            });
        setRows((prev) => (append && prev ? [...prev, ...page] : page));
        setExhausted(page.length < PAGE_LIMIT);
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载作业失败");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [trashView, status, kind],
  );

  // 筛选/视图切换 → 重置回第一页
  useEffect(() => {
    setRows(null);
    void load(0, false);
  }, [load]);

  /** 属主过滤是纯前端过滤(后端无该参数),只对已加载页生效。 */
  const visible = useMemo(() => {
    const needle = ownerQ.trim().toLowerCase();
    const list = rows ?? [];
    if (!needle) return list;
    return list.filter((j) =>
      (j.user_email || j.user_id || "").toLowerCase().includes(needle),
    );
  }, [rows, ownerQ]);

  const runOp = useCallback(
    async (id: string, op: () => Promise<unknown>, okText: string) => {
      setBusyId(id);
      setOpError(null);
      setOkMsg(null);
      try {
        await op();
        setOkMsg(okText);
        await load(0, false);
      } catch (err) {
        setOpError(err instanceof Error ? err.message : "操作失败");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const onCancel = (j: JobItem) =>
    void runOp(j.id, () => cancelJob(j.id), `已取消 ${j.id.slice(0, 8)}`);
  const onRerun = (j: JobItem) =>
    void runOp(
      j.id,
      () => rerunJob(j.id, { seed_mode: "keep" }),
      `已重跑 ${j.id.slice(0, 8)}(锁 seed)`,
    );
  const onRestore = (j: JobItem) =>
    void runOp(j.id, () => restoreJob(j.id), `已恢复 ${j.id.slice(0, 8)}`);

  const onConfirmDelete = async () => {
    const j = confirmDelete;
    if (!j) return;
    await runOp(j.id, () => deleteJob(j.id), `已删除 ${j.id.slice(0, 8)}(回收站保留 72h)`);
    setConfirmDelete(null);
  };

  const onConfirmPurge = async () => {
    const j = confirmPurge;
    if (!j) return;
    await runOp(j.id, () => permanentDeleteJob(j.id), `已彻底删除 ${j.id.slice(0, 8)}`);
    setConfirmPurge(null);
  };

  const applyKind = (e: React.FormEvent) => {
    e.preventDefault();
    setKind(kindInput.trim());
  };

  return (
    <div className="jq-view">
      <PageHeader
        title="作业队列"
        desc="全员作业与回收站 · 行内取消 / 重跑 / 删除 / 恢复"
        actions={
          <span className="jq-count">
            {loading
              ? "加载中…"
              : trashView
                ? `回收站 ${rows?.length ?? 0} 条`
                : `已加载 ${rows?.length ?? 0} 条`}
          </span>
        }
      />

      <div className="jq-filters at-card">
        <select
          className="input jq-select"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          disabled={trashView}
          aria-label="状态筛选"
          title={trashView ? "回收站视图不按状态筛选" : "按状态筛选"}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <form className="jq-kind-form" onSubmit={applyKind}>
          <input
            type="search"
            className="input jq-kind-input"
            value={kindInput}
            onChange={(e) => setKindInput(e.target.value)}
            placeholder="类型过滤(如 txt2img,留空全部)"
            disabled={trashView}
            aria-label="类型过滤"
          />
          <button
            type="submit"
            className="at-btn at-btn--ghost"
            disabled={trashView}
          >
            <Icon name="search" size={14} />
            查询
          </button>
        </form>

        <input
          type="search"
          className="input jq-owner-input"
          value={ownerQ}
          onChange={(e) => setOwnerQ(e.target.value)}
          placeholder="属主 email 过滤(已加载页内)"
          aria-label="属主过滤"
        />

        <span className="jq-trash-toggle">
          <Switch
            checked={trashView}
            onChange={setTrashView}
            label="回收站"
            ariaLabel="切换回收站视图"
          />
        </span>
      </div>

      {opError && <ErrorBar message={opError} onClose={() => setOpError(null)} />}
      {okMsg && <div className="jq-ok">{okMsg}</div>}

      <div className="at-card jq-card">
        {error && !loading && (
          <div className="jq-error-row">
            <ErrorBar message={error} onClose={() => setError(null)} />
            <button
              type="button"
              className="at-btn at-btn--ghost"
              onClick={() => void load(0, false)}
            >
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        )}

        {!error && loading && (
          <LoadingBlock variant="line" count={4} className="jq-loading" />
        )}

        {!error && !loading && visible.length === 0 && (
          <Empty
            size="section"
            icon="library"
            title={trashView ? "回收站为空" : "无匹配作业"}
            desc={
              trashView
                ? "软删作品会在此保留 72h"
                : ownerQ
                  ? "当前筛选条件下没有作业,试试放宽属主过滤"
                  : "当前筛选条件下没有作业"
            }
          />
        )}

        {!error && !loading && visible.length > 0 && (
          <div className="jq-table-wrap">
            <table className="jq-table">
              <thead>
                <tr>
                  <th className="jq-col-time">{trashView ? "删除时间" : "时间"}</th>
                  <th className="jq-col-owner">属主</th>
                  <th className="jq-col-kind">类型</th>
                  <th className="jq-col-status">状态</th>
                  <th className="jq-col-prompt">提示词</th>
                  <th className="jq-col-id">作业</th>
                  <th className="jq-col-ops">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((j) => {
                  const busy = busyId === j.id;
                  const trash = trashView && "deleted_at" in j;
                  return (
                    <tr key={j.id} className={busy ? "is-busy" : ""}>
                      <td className="jq-col-time">
                        <span
                          className="jq-time"
                          title={
                            trash
                              ? `${(j as TrashJobItem).deleted_at} · 剩余 ${Math.max(
                                  0,
                                  Math.floor(
                                    (j as TrashJobItem).restore_remaining_seconds / 3600,
                                  ),
                                )}h`
                              : j.created_at
                          }
                        >
                          {formatTime(
                            trash ? (j as TrashJobItem).deleted_at : j.created_at,
                          )}
                        </span>
                      </td>
                      <td className="jq-col-owner">
                        <span className="jq-owner" title={j.user_email || j.user_id || ""}>
                          {ownerLabel(j)}
                        </span>
                      </td>
                      <td className="jq-col-kind">
                        <span className="jq-kind">{j.kind}</span>
                      </td>
                      <td className="jq-col-status">
                        <Badge
                          tone={statusTone(j.status)}
                          dotPulse={j.status === "running" || j.status === "queued"}
                        >
                          {statusLabel(j.status)}
                        </Badge>
                      </td>
                      <td className="jq-col-prompt">
                        <span className="jq-prompt" title={j.prompt}>
                          {truncate(j.prompt, 60)}
                        </span>
                        {j.status === "error" && j.error && (
                          <span className="jq-err-text" title={j.error}>
                            {truncate(j.error, 40)}
                          </span>
                        )}
                      </td>
                      <td className="jq-col-id">
                        <span className="jq-id" title={j.id}>
                          {j.id.slice(0, 8)}
                        </span>
                      </td>
                      <td className="jq-col-ops">
                        <div className="jq-ops">
                          {!trash && !TERMINAL.has(j.status) && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              disabled={busy}
                              onClick={() => onCancel(j)}
                              title="取消(仅非终态)"
                            >
                              取消
                            </button>
                          )}
                          {!trash && j.has_params && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              disabled={busy}
                              onClick={() => onRerun(j)}
                              title="按参数快照重跑(锁 seed)"
                            >
                              重跑
                            </button>
                          )}
                          {!trash && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost btn-danger"
                              disabled={busy}
                              onClick={() => setConfirmDelete(j)}
                              title="软删入回收站(72h 可恢复)"
                            >
                              删除
                            </button>
                          )}
                          {trash && (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={busy}
                                onClick={() => onRestore(j)}
                                title="恢复到作品库"
                              >
                                恢复
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost btn-danger"
                                disabled={busy}
                                onClick={() => setConfirmPurge(j as TrashJobItem)}
                                title="物理删除,不可恢复"
                              >
                                彻底删除
                              </button>
                            </>
                          )}
                          {busy && <Icon name="loading" size={14} />}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!error && !loading && !exhausted && (rows?.length ?? 0) > 0 && (
          <div className="jq-more-row">
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={loadingMore}
              onClick={() => void load(rows?.length ?? 0, true)}
            >
              <Icon name={loadingMore ? "loading" : "plus"} size={14} />
              {loadingMore ? "加载中…" : `加载更多(已载 ${rows?.length ?? 0})`}
            </button>
          </div>
        )}
      </div>

      {/* 软删确认(回收站 72h 可恢复,非 danger) */}
      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="删除作业"
        preventClose={busyId !== null}
        width={420}
        footer={
          <>
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={busyId !== null}
              onClick={() => setConfirmDelete(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="at-btn at-btn--primary"
              disabled={busyId !== null}
              onClick={() => void onConfirmDelete()}
            >
              <Icon name={busyId ? "loading" : "delete"} size={14} />
              {busyId ? "删除中…" : "确认删除"}
            </button>
          </>
        }
      >
        <div className="jq-confirm">
          确定删除作业
          「<span className="jq-confirm-id">{confirmDelete?.id.slice(0, 8)}</span>」?
          软删入回收站,72h 内可恢复;属主
          {confirmDelete ? ` ${ownerLabel(confirmDelete)} ` : ""}
          的作品库中将不再显示。
        </div>
      </Modal>

      {/* 物理删除确认(danger,不可恢复) */}
      <Modal
        open={confirmPurge !== null}
        onClose={() => setConfirmPurge(null)}
        title="彻底删除"
        danger
        preventClose={busyId !== null}
        width={420}
        footer={
          <>
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={busyId !== null}
              onClick={() => setConfirmPurge(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn jq-confirm-purge"
              disabled={busyId !== null}
              onClick={() => void onConfirmPurge()}
            >
              <Icon name={busyId ? "loading" : "delete"} size={14} />
              {busyId ? "删除中…" : "彻底删除"}
            </button>
          </>
        }
      >
        <div className="jq-confirm">
          确定彻底删除作业
          「<span className="jq-confirm-id">{confirmPurge?.id.slice(0, 8)}</span>」?
          该操作为物理删除,不可恢复。
        </div>
      </Modal>

      <style jsx>{`
        .jq-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .jq-count {
          align-self: center;
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }

        .jq-filters {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-3);
          flex-wrap: wrap;
        }
        .jq-select {
          min-width: 120px;
        }
        .jq-kind-form {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex: 1 1 260px;
          min-width: 200px;
        }
        .jq-kind-input {
          flex: 1;
          min-width: 0;
        }
        .jq-owner-input {
          flex: 1 1 200px;
          min-width: 160px;
        }
        .jq-trash-toggle {
          margin-left: auto;
          flex-shrink: 0;
        }

        .jq-ok {
          padding: 8px 12px;
          border-radius: var(--radius-md);
          background: color-mix(in srgb, var(--accent) 12%, transparent);
          color: var(--text-primary);
          font-size: var(--text-body);
        }

        .jq-card {
          padding: 0;
          overflow: hidden;
        }
        .jq-loading {
          padding: var(--space-4);
        }
        .jq-error-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-4) var(--space-5);
        }
        .jq-error-row :global(.ui-error-bar) {
          flex: 1;
          min-width: 0;
        }

        .jq-table-wrap {
          overflow-x: auto;
        }
        @media (max-width: 767px) {
          .jq-table-wrap {
            -webkit-mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
            mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
          }
          .jq-table {
            min-width: 860px;
          }
        }
        .jq-table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--text-body);
        }
        .jq-table thead th {
          text-align: left;
          padding: var(--space-3) var(--space-4);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted);
          background: var(--bg-surface-2);
          border-bottom: 1px solid var(--border-strong);
          white-space: nowrap;
        }
        .jq-table tbody td {
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
          vertical-align: middle;
          color: var(--text-secondary);
        }
        .jq-table tbody tr {
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .jq-table tbody tr:nth-child(even) {
          background: var(--bg-surface-2);
        }
        .jq-table tbody tr:hover {
          background: var(--accent-soft);
        }
        .jq-table tbody tr.is-busy {
          opacity: 0.6;
        }
        .jq-table tbody tr:last-child td {
          border-bottom: none;
        }

        .jq-col-time {
          width: 110px;
          white-space: nowrap;
        }
        .jq-col-owner {
          min-width: 140px;
          max-width: 220px;
        }
        .jq-col-kind {
          width: 110px;
        }
        .jq-col-status {
          width: 110px;
        }
        .jq-col-id {
          width: 90px;
        }
        .jq-col-ops {
          min-width: 180px;
          text-align: right;
        }

        .jq-time {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .jq-owner {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: var(--text-aux);
          color: var(--text-primary);
        }
        .jq-kind {
          font-family: var(--font-mono);
          font-size: var(--text-aux);
        }
        .jq-prompt {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 380px;
        }
        .jq-err-text {
          display: block;
          margin-top: 2px;
          font-size: var(--text-caption);
          color: var(--err);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 380px;
        }
        .jq-id {
          font-family: var(--font-mono);
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .jq-ops {
          display: inline-flex;
          align-items: center;
          justify-content: flex-end;
          gap: var(--space-1);
          white-space: nowrap;
        }

        .jq-more-row {
          display: flex;
          justify-content: center;
          padding: var(--space-3);
          border-top: 1px solid var(--border-subtle);
        }

        .jq-confirm {
          padding: var(--space-4);
          font-size: var(--text-body);
          color: var(--text-secondary);
          line-height: 1.55;
        }
        .jq-confirm-id {
          color: var(--text-primary);
          font-family: var(--font-mono);
          font-size: var(--text-aux);
        }
        .jq-confirm-purge {
          background: var(--err);
          border-color: var(--err);
          color: var(--text-on-accent);
          min-width: 120px;
          justify-content: center;
        }
        .jq-confirm-purge:hover:not(:disabled) {
          filter: brightness(1.12);
        }
        .jq-confirm-purge:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}

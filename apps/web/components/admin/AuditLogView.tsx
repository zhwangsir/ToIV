"use client";

import { useCallback, useEffect, useState } from "react";

import { listAuditLogs, type AuditLogItem } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";

/** 动作 → 中文标签(未知动作回退原字符串)。 */
const ACTION_LABELS: Record<string, string> = {
  job_delete: "删除作品",
  job_delete_undo: "撤销删除",
  jobs_batch_delete: "批量删除",
  user_create: "创建用户",
  user_delete: "删除用户",
  agent_session_delete: "删除智能体会话",
  workflow_deploy: "部署工作流",
};

/** 相对时间:刚刚 / N 分钟前 / N 小时前 / N 天前 / 完整日期时间。 */
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
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

const PAGE_SIZE = 50;

export function AuditLogView() {
  const [logs, setLogs] = useState<AuditLogItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listAuditLogs({ limit: PAGE_SIZE, action: actionFilter || undefined })
      .then(setLogs)
      .catch((err) => setError(err instanceof Error ? err.message : "审计日志加载失败"))
      .finally(() => setLoading(false));
  }, [actionFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const isEmpty = !loading && !error && (logs?.length ?? 0) === 0;

  return (
    <div className="audit-view">
      <div className="audit-toolbar">
        <select
          className="input audit-filter"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          aria-label="按动作筛选"
        >
          <option value="">全部动作</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button type="button" className="at-btn at-btn--ghost" onClick={load}>
          <Icon name="refresh" size={14} />
          刷新
        </button>
      </div>

      <div className="at-card audit-card">
        {error && !loading && (
          <div className="audit-error-row">
            <ErrorBar message={error} onClose={() => setError(null)} />
          </div>
        )}

        {!error && loading && (
          <LoadingBlock variant="line" count={6} className="audit-loading" />
        )}

        {!error && !loading && isEmpty && (
          <Empty
            icon="history"
            title="暂无操作记录"
            desc="用户的关键操作(删除/撤销/管理动作)会记录在这里"
          />
        )}

        {!error && !loading && !isEmpty && (
          <div className="audit-table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>操作者</th>
                  <th>动作</th>
                  <th>对象</th>
                  <th>摘要</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {logs?.map((l) => (
                  <tr key={l.id}>
                    <td className="audit-user">
                      <div className="audit-email">{l.user_email || l.user_id}</div>
                    </td>
                    <td>
                      <span className="audit-action">{ACTION_LABELS[l.action] ?? l.action}</span>
                    </td>
                    <td className="audit-target">
                      {l.target_type ? `${l.target_type} · ${l.target_id.slice(0, 8)}` : "—"}
                    </td>
                    <td className="audit-summary">{l.summary || "—"}</td>
                    <td>
                      {l.undone ? (
                        <span className="badge">已撤销</span>
                      ) : (
                        <span className="badge badge-accent">生效</span>
                      )}
                    </td>
                    <td className="audit-time">{formatTime(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <style jsx>{`
        .audit-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }

        .audit-toolbar {
          display: flex;
          align-items: center;
          gap: var(--space-3);
        }
        .audit-filter {
          width: 180px;
        }

        .audit-card {
          padding: 0;
          overflow: hidden;
        }
        .audit-loading {
          padding: var(--space-6) var(--space-5);
        }
        .audit-error-row {
          padding: var(--space-4) var(--space-5);
        }

        .audit-table-wrap {
          overflow-x: auto;
        }
        .audit-table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--text-body);
          min-width: 720px;
        }
        .audit-table thead th {
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
        .audit-table tbody td {
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
          vertical-align: middle;
          color: var(--text-secondary);
        }
        .audit-table tbody tr:nth-child(even) {
          background: var(--bg-surface-2);
        }
        .audit-table tbody tr:hover {
          background: var(--accent-soft);
        }
        .audit-table tbody tr:last-child td {
          border-bottom: none;
        }

        .audit-email {
          color: var(--text-primary);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .audit-action {
          white-space: nowrap;
          color: var(--text-primary);
        }
        .audit-target {
          font-family: var(--font-mono);
          font-size: var(--text-aux);
          white-space: nowrap;
        }
        .audit-summary {
          max-width: 320px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: var(--text-aux);
        }
        .audit-time {
          font-family: var(--font-mono);
          font-size: var(--text-aux);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
}

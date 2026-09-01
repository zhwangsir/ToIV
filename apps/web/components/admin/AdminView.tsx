"use client";

import { useCallback, useEffect, useState } from "react";

import { createUser, deleteUser, listUsers } from "@/lib/api";
import type { AdminUser } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { AgentsAdminView } from "@/components/admin/AgentsAdminView";
import { AuditLogView } from "@/components/admin/AuditLogView";

type AdminSubView = "users" | "agents" | "audit";

/** 相对时间格式化:刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
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

/** 邮箱 → 头像首字母(取 @ 前的第一个字符,大写)。 */
function emailInitial(email: string): string {
  const local = email.split("@")[0] ?? email;
  return (local[0] ?? "?").toUpperCase();
}

/** 角色 → 展示标签 + 徽章样式类。 */
function roleBadgeClass(role: string): string {
  return role === "admin" ? "badge badge-accent" : "badge";
}

/** 用量简写:总量 + 主要类型分布(最多取 2 项)。 */
function renderUsage(u: AdminUser["usage"]): string {
  const total = u?.total ?? 0;
  const entries = Object.entries(u?.by_kind ?? {});
  if (entries.length === 0) return `${total} 次`;
  const sorted = entries.sort((a, b) => b[1] - a[1]).slice(0, 2);
  const detail = sorted.map(([k, v]) => `${k} ${v}`).join(" · ");
  return `${total} 次 · ${detail}`;
}

interface CreateForm {
  email: string;
  password: string;
  role: string;
}

const EMPTY_FORM: CreateForm = { email: "", password: "", role: "user" };

export function AdminView() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 子页切换:用户管理 | 智能体管理
  const [subView, setSubView] = useState<AdminSubView>("users");

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 删除确认对话框
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listUsers()
      .then(setUsers)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载用户失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Esc / 焦点陷阱 / 滚动锁统一由 ui/Modal 承接(含提交中 preventClose)

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = form.email.trim();
    const password = form.password;
    const role = form.role;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError("请输入有效邮箱");
      return;
    }
    if (password.length < 6) {
      setFormError("密码至少 6 位");
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const u = await createUser(email, password, role);
      setUsers((prev) => (prev ? [u, ...prev] : [u]));
      setModalOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  // 打开删除确认对话框
  const handleDelete = (u: AdminUser) => {
    setDeleteError(null);
    setConfirmDelete(u);
  };

  // 确认删除(执行实际删除逻辑)
  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setDeletingId(confirmDelete.id);
    setDeleteError(null);
    try {
      await deleteUser(confirmDelete.id);
      setUsers((prev) =>
        (prev ?? []).filter((x) => x.id !== confirmDelete.id),
      );
      setConfirmDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  const isEmpty = !loading && !error && (users?.length ?? 0) === 0;

  return (
    <div className="single-view admin-view">
      <div className="admin-tabs">
        <Tabs
          items={[
            { key: "users", label: "用户管理", icon: <Icon name="admin" size={14} /> },
            { key: "agents", label: "智能体管理", icon: <Icon name="sparkles" size={14} /> },
            { key: "audit", label: "操作日志", icon: <Icon name="history" size={14} /> },
          ]}
          current={subView}
          onChange={(k) => setSubView(k as AdminSubView)}
          ariaLabel="管理子页"
        />
      </div>

      {subView === "agents" && <AgentsAdminView />}

      {subView === "audit" && <AuditLogView />}

      {subView === "users" && (
        <>
      <PageHeader
        title="用户管理"
        desc="账户与权限 · 创建、查看与删除平台用户"
        actions={
          <>
            <span className="admin-count">
              {loading
                ? "加载中…"
                : error
                  ? "加载失败"
                  : `${users?.length ?? 0} 个用户`}
            </span>
            <button
              type="button"
              className="at-btn at-btn--primary admin-create-btn"
              onClick={openCreate}
            >
              <Icon name="plus" size={14} />
              新建用户
            </button>
          </>
        }
      />

      {!error && (
        <div className="admin-stats">
          <div className="admin-stat at-card at-card--lift">
            <span className="admin-stat-label">总用户</span>
            <span className="admin-stat-value">
              {loading ? "—" : (users?.length ?? 0)}
            </span>
            <span className="admin-stat-hint">全部注册账户</span>
          </div>
          <div className="admin-stat at-card at-card--lift">
            <span className="admin-stat-label">管理员</span>
            <span className="admin-stat-value">
              {loading
                ? "—"
                : (users?.filter((u) => u.role === "admin").length ?? 0)}
            </span>
            <span className="admin-stat-hint">拥有管理权限</span>
          </div>
          <div className="admin-stat at-card at-card--lift">
            <span className="admin-stat-label">近 7 天新增</span>
            <span className="admin-stat-value">
              {loading
                ? "—"
                : (users?.filter(
                    (u) =>
                      Date.now() - new Date(u.created_at).getTime() <
                      7 * 24 * 60 * 60 * 1000,
                  ).length ?? 0)}
            </span>
            <span className="admin-stat-hint">新注册账户</span>
          </div>
          <div className="admin-stat at-card at-card--lift">
            <span className="admin-stat-label">累计调用</span>
            <span className="admin-stat-value">
              {loading
                ? "—"
                : (users?.reduce(
                    (sum, u) => sum + (u.usage?.total ?? 0),
                    0,
                  ) ?? 0)}
            </span>
            <span className="admin-stat-hint">全部生成次数</span>
          </div>
        </div>
      )}

      <div className="at-card admin-card">
        {error && !loading && (
          <div className="admin-error-row">
            <ErrorBar message={error} onClose={() => setError(null)} />
            <button type="button" className="at-btn at-btn--ghost" onClick={load}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        )}

        {!error && loading && (
          <LoadingBlock variant="line" count={4} className="admin-loading" />
        )}

        {!error && !loading && isEmpty && (
          <div className="empty-state admin-empty">
            <div className="empty-state-icon">
              <Icon name="admin" size={48} strokeWidth={1.2} />
            </div>
            <div className="empty-state-title">还没有用户</div>
            <div className="empty-state-desc">点击右上角「新建用户」创建第一个账户</div>
          </div>
        )}

        {!error && !loading && !isEmpty && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th className="col-user">用户</th>
                  <th className="col-role">角色</th>
                  <th className="col-created">创建时间</th>
                  <th className="col-usage">用量</th>
                  <th className="col-action"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {users?.map((u) => (
                  <tr
                    key={u.id}
                    className={deletingId === u.id ? "is-deleting" : ""}
                  >
                    <td className="col-user">
                      <div className="admin-user-cell">
                        <div className="admin-avatar" aria-hidden="true">
                          {emailInitial(u.email)}
                        </div>
                        <div className="admin-user-meta">
                          <div className="admin-email">{u.email}</div>
                          <div className="admin-id">{u.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="col-role">
                      <span className={roleBadgeClass(u.role)}>
                        {u.role === "admin" ? "管理员" : "用户"}
                      </span>
                    </td>
                    <td className="col-created">
                      <span className="admin-time">{formatTime(u.created_at)}</span>
                    </td>
                    <td className="col-usage">
                      <span className="admin-usage">
                        {renderUsage(u.usage)}
                      </span>
                    </td>
                    <td className="col-action">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost btn-danger admin-delete"
                        title="删除用户"
                        aria-label={`删除用户 ${u.email}`}
                        disabled={deletingId === u.id}
                        onClick={() => handleDelete(u)}
                      >
                        <Icon
                          name={deletingId === u.id ? "loading" : "delete"}
                          size={14}
                        />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="新建用户"
        preventClose={creating}
        width={420}
      >
        <form className="admin-form" onSubmit={handleCreate}>
          <label className="admin-field">
            <span className="admin-label">邮箱</span>
            <input
              type="email"
              className="input"
              placeholder="name@example.com"
              autoComplete="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              disabled={creating}
              autoFocus
            />
          </label>

          <label className="admin-field">
            <span className="admin-label">密码</span>
            <input
              type="password"
              className="input"
              placeholder="至少 6 位"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) =>
                setForm({ ...form, password: e.target.value })
              }
              disabled={creating}
            />
          </label>

          <label className="admin-field">
            <span className="admin-label">角色</span>
            <select
              className="input admin-select"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              disabled={creating}
            >
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
          </label>

          {formError && <div className="admin-form-error">{formError}</div>}

          <div className="admin-form-actions">
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={creating}
              onClick={() => setModalOpen(false)}
            >
              取消
            </button>
            <button
              type="submit"
              className="at-btn at-btn--primary"
              disabled={creating}
            >
              <Icon name={creating ? "loading" : "send"} size={14} />
              {creating ? "创建中…" : "创建用户"}
            </button>
          </div>
        </form>
      </Modal>

      {/* 删除确认对话框(danger,ui/Modal 承接 focus trap/Esc) */}
      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="删除用户"
        danger
        preventClose={deletingId !== null}
        width={420}
        footer={
          <>
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={deletingId !== null}
              onClick={() => setConfirmDelete(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn admin-confirm-delete"
              disabled={deletingId !== null}
              onClick={() => void handleConfirmDelete()}
            >
              <Icon name={deletingId ? "loading" : "delete"} size={14} />
              {deletingId ? "删除中…" : "确认删除"}
            </button>
          </>
        }
      >
        <div className="admin-confirm-content">
          <div className="admin-confirm-warn">
            确定删除用户
            「<span className="admin-confirm-email">{confirmDelete?.email}</span>」?
            该操作不可撤销,用户的所有数据将被永久移除。
          </div>
          {deleteError && (
            <div className="admin-form-error admin-confirm-error">
              <Icon name="error" size={13} /> {deleteError}
            </div>
          )}
        </div>
      </Modal>
      </>
      )}

      <style jsx>{`
        .admin-view {
          display: flex;
          flex-direction: column;
          gap: var(--section-gap);
        }

        .admin-tabs {
          align-self: flex-start;
        }
        @media (max-width: 767px) {
          .admin-tabs {
            align-self: stretch;
          }
        }

        /* 页头使用全局 .page-header 体系(避让/排版由 globals.css 统一),
           这里只保留本视图特有的计数与统计卡片区。 */
        .admin-count {
          align-self: center;
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.01em;
          white-space: nowrap;
        }
        .admin-create-btn {
          white-space: nowrap;
        }

        /* ── 统计卡片区(栅格化);卡壳由 .at-card 供给,此处只保留布局 ── */
        .admin-stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: var(--space-4);
        }
        .admin-stat {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-4);
        }
        .admin-stat-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted);
        }
        .admin-stat-value {
          font-size: var(--text-2xl);
          font-weight: var(--font-bold);
          letter-spacing: -0.02em;
          line-height: 1.2;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }
        .admin-stat-hint {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }

        .admin-card {
          padding: 0;
          overflow: hidden;
        }

        .admin-loading {
          padding: var(--space-4);
        }

        /* 加载失败:ErrorBar(可关闭) + 重试按钮,横排撑满卡片 */
        .admin-error-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-4) var(--space-5);
        }
        .admin-error-row :global(.ui-error-bar) {
          flex: 1;
          min-width: 0;
        }

        .admin-empty {
          padding: var(--space-10) var(--space-4);
        }
        .admin-empty .empty-state-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 72px;
          height: 72px;
          margin: 0 auto var(--space-3);
          background: var(--accent-soft);
          border-radius: 50%;
        }

        .admin-table-wrap {
          overflow-x: auto;
        }
        /* 角色徽章不折行(移动端避免「管理员」竖排断字) */
        .admin-table .badge {
          white-space: nowrap;
        }
        /* 移动端:表格可横滑,右缘渐隐暗示未裁完 */
        @media (max-width: 767px) {
          .admin-table-wrap {
            -webkit-mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
            mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
          }
        }
        .admin-table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--text-body);
        }
        .admin-table thead th {
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
        .admin-table tbody td {
          padding: var(--space-4) var(--space-5);
          border-bottom: 1px solid var(--border-subtle);
          vertical-align: middle;
          color: var(--text-secondary);
        }
        .admin-table tbody tr {
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        /* 斑马纹:偶数行浅灰底,与 hover 的强调色底拉开层级 */
        .admin-table tbody tr:nth-child(even) {
          background: var(--bg-surface-2);
        }
        .admin-table tbody tr:hover {
          background: var(--accent-soft);
        }
        .admin-table tbody tr.is-deleting {
          opacity: 0.5;
          pointer-events: none;
        }
        .admin-table tbody tr:last-child td {
          border-bottom: none;
        }

        .col-action {
          width: 48px;
          text-align: right;
        }
        .col-role {
          width: 110px;
        }
        .col-created {
          width: 140px;
        }
        .col-usage {
          min-width: 180px;
        }

        .admin-user-cell {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          min-width: 0;
        }
        .admin-avatar {
          flex-shrink: 0;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: var(--accent-soft);
          border: 1px solid var(--accent-glow);
          color: var(--accent);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: var(--text-aux);
          font-weight: var(--font-semibold);
          font-family: var(--font-mono);
        }
        .admin-user-meta {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .admin-email {
          color: var(--text-primary);
          font-size: var(--text-body);
          font-weight: var(--font-medium);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .admin-id {
          font-size: var(--text-label);
          color: var(--text-muted);
          font-family: var(--font-mono);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .admin-time {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }

        .admin-usage {
          font-size: var(--text-aux);
          color: var(--text-secondary);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.01em;
        }

        /* 行内删除按钮:桌面端行 hover / 聚焦时才显现,删除中保持可见;
           触屏与窄屏常驻可见 */
        .admin-delete {
          opacity: 0;
          transition: opacity var(--duration-fast) var(--ease-standard);
        }
        .admin-table tbody tr:hover .admin-delete,
        .admin-table tbody tr:focus-within .admin-delete,
        .admin-table tbody tr.is-deleting .admin-delete {
          opacity: 1;
        }
        @media (hover: none), (max-width: 767px) {
          .admin-delete {
            opacity: 0.7;
          }
          .admin-delete:hover {
            opacity: 1;
          }
        }

        /* 弹窗壳层(overlay/头部/关闭钮)已由 ui/Modal 统一承接,
           此处仅保留表单与删除确认的视图特有样式。 */
        .admin-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
        }
        .admin-field {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .admin-label {
          font-size: var(--text-aux);
          color: var(--text-secondary);
          font-weight: var(--font-medium);
        }
        .admin-select {
          appearance: none;
          -webkit-appearance: none;
          background-image: linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
            linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
          background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
          background-size: 5px 5px, 5px 5px;
          background-repeat: no-repeat;
          padding-right: 2rem;
          cursor: pointer;
        }

        .admin-form-error {
          padding: var(--space-2) var(--space-3);
          background: var(--err-soft);
          border: 1px solid var(--err);
          border-radius: var(--radius-xs);
          color: var(--err);
          font-size: var(--text-aux);
          line-height: 1.45;
        }

        .admin-form-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: var(--space-2);
          margin-top: var(--space-1);
        }

        /* 删除确认对话框(壳层走 ui/Modal,标题 danger 态由 Modal 渲染) */
        .admin-confirm-content {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
        }
        .admin-confirm-warn {
          font-size: var(--text-body);
          color: var(--text-secondary);
          line-height: 1.55;
        }
        .admin-confirm-email {
          color: var(--text-primary);
          font-weight: var(--font-medium);
          font-family: var(--font-mono);
          font-size: var(--text-aux);
        }
        .admin-confirm-error {
          margin: 0;
        }
        .admin-confirm-delete {
          background: var(--err);
          border-color: var(--err);
          color: var(--text-on-accent);
          min-width: 120px;
          justify-content: center;
        }
        .admin-confirm-delete:hover:not(:disabled) {
          filter: brightness(1.12);
        }
        .admin-confirm-delete:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        @media (max-width: 767px) {
          .admin-stats {
            grid-template-columns: repeat(2, 1fr);
            gap: var(--space-3);
          }
          .admin-stat {
            padding: var(--space-4);
          }
          .admin-create-btn {
            align-self: flex-start;
          }
          /* 窄屏不压缩 110-180px 固定列宽:表格保持最小可读宽度,
             由 .admin-table-wrap(overflow-x:auto + 右缘渐隐)横向滚动承载 */
          .admin-table {
            min-width: 640px;
          }
          .col-usage {
            min-width: auto;
          }
        }
      `}</style>
    </div>
  );
}

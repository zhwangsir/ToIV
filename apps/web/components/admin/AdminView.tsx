"use client";

import { useCallback, useEffect, useState } from "react";

import { createUser, deleteUser, listUsers } from "@/lib/api";
import type { AdminUser } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { AgentsAdminView } from "@/components/admin/AgentsAdminView";

type AdminSubView = "users" | "agents";

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

  // Esc 关闭新建弹窗
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  // Esc 关闭删除确认弹窗(删除中不允许关闭)
  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deletingId) setConfirmDelete(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete, deletingId]);

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
          ]}
          current={subView}
          onChange={(k) => setSubView(k as AdminSubView)}
          ariaLabel="管理子页"
        />
      </div>

      {subView === "agents" && <AgentsAdminView />}

      {subView === "users" && (
        <>
      <header className="admin-header">
        <div className="admin-header-left">
          <h1 className="admin-title">用户管理</h1>
          <span className="admin-count">
            {loading
              ? "加载中…"
              : error
                ? "加载失败"
                : `${users?.length ?? 0} 个用户`}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-primary admin-create-btn"
          onClick={openCreate}
        >
          <Icon name="send" size={14} />
          新建用户
        </button>
      </header>

      <div className="card admin-card">
        {error && !loading && (
          <div className="admin-error">
            <Icon name="error" size={36} strokeWidth={1.4} />
            <div className="admin-error-msg">{error}</div>
            <button type="button" className="btn btn-sm" onClick={load}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        )}

        {!error && loading && (
          <div className="loading-spinner admin-loading">
            <Icon name="loading" size={16} />
            加载用户…
          </div>
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

      {modalOpen && (
        <div
          className="admin-modal"
          role="dialog"
          aria-modal="true"
          aria-label="新建用户"
          onClick={() => !creating && setModalOpen(false)}
        >
          <div
            className="admin-modal-body"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-title">新建用户</div>
                <div className="admin-modal-sub">为团队创建一个新账户</div>
              </div>
              <button
                type="button"
                className="admin-modal-close"
                aria-label="关闭"
                disabled={creating}
                onClick={() => setModalOpen(false)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

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
                  className="btn"
                  disabled={creating}
                  onClick={() => setModalOpen(false)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={creating}
                >
                  <Icon name={creating ? "loading" : "send"} size={14} />
                  {creating ? "创建中…" : "创建用户"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 删除确认对话框(替代原生 window.confirm) */}
      {confirmDelete && (
        <div
          className="admin-modal"
          role="dialog"
          aria-modal="true"
          aria-label="确认删除用户"
          onClick={() => !deletingId && setConfirmDelete(null)}
        >
          <div
            className="admin-modal-body"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-title admin-confirm-title">
                  <Icon name="delete" size={16} />
                  删除用户
                </div>
                <div className="admin-modal-sub">此操作不可撤销</div>
              </div>
              <button
                type="button"
                className="admin-modal-close"
                aria-label="关闭"
                disabled={deletingId !== null}
                onClick={() => setConfirmDelete(null)}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="admin-confirm-content">
              <div className="admin-confirm-warn">
                确定删除用户
                「<span className="admin-confirm-email">{confirmDelete.email}</span>」?
                该操作不可撤销,用户的所有数据将被永久移除。
              </div>
              {deleteError && (
                <div className="admin-form-error admin-confirm-error">
                  <Icon name="error" size={13} /> {deleteError}
                </div>
              )}
              <div className="admin-form-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={deletingId !== null}
                  onClick={() => setConfirmDelete(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn admin-confirm-delete"
                  disabled={deletingId !== null}
                  onClick={handleConfirmDelete}
                >
                  <Icon name={deletingId ? "loading" : "delete"} size={14} />
                  {deletingId ? "删除中…" : "确认删除"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      </>
      )}

      <style jsx>{`
        .admin-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }

        .admin-tabs {
          align-self: flex-start;
        }
        @media (max-width: 768px) {
          .admin-tabs {
            align-self: stretch;
          }
        }

        .admin-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: var(--space-4);
          flex-wrap: wrap;
          padding-bottom: var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
        }
        .admin-header-left {
          display: flex;
          align-items: baseline;
          gap: var(--space-3);
          min-width: 0;
        }
        .admin-title {
          margin: 0;
          font-family: var(--font-sans);
          font-size: var(--text-title);
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          line-height: 1.3;
        }
        .admin-count {
          font-size: 0.78rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
        }
        .admin-create-btn {
          white-space: nowrap;
        }

        .admin-card {
          padding: 0;
          overflow: hidden;
        }

        .admin-loading {
          padding: var(--space-6) var(--space-4);
          justify-content: center;
        }

        .admin-empty {
          padding: var(--space-7) var(--space-4);
        }

        .admin-error {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-6);
          color: var(--text-muted);
        }
        .admin-error-msg {
          font-size: 0.88rem;
          color: var(--text-secondary);
        }

        .admin-table-wrap {
          overflow-x: auto;
        }
        .admin-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.88rem;
        }
        .admin-table thead th {
          text-align: left;
          padding: 0.7rem 0.9rem;
          font-size: 0.72rem;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-muted);
          background: var(--bg-surface-2);
          border-bottom: 1px solid var(--border-subtle);
          white-space: nowrap;
        }
        .admin-table tbody td {
          padding: 0.7rem 0.9rem;
          border-bottom: 1px solid var(--border-subtle);
          vertical-align: middle;
          color: var(--text-secondary);
        }
        .admin-table tbody tr {
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .admin-table tbody tr:hover {
          background: var(--bg-surface-2);
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
          gap: 0.7rem;
          min-width: 0;
        }
        .admin-avatar {
          flex-shrink: 0;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: var(--accent-soft);
          border: 1px solid var(--accent-glow);
          color: var(--accent);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.8rem;
          font-weight: 650;
          font-family: var(--font-mono);
        }
        .admin-user-meta {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.05rem;
        }
        .admin-email {
          color: var(--text-primary);
          font-size: 0.88rem;
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .admin-id {
          font-size: 0.7rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .admin-time {
          font-size: 0.78rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          white-space: nowrap;
        }

        .admin-usage {
          font-size: 0.78rem;
          color: var(--text-secondary);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
        }

        .admin-delete {
          opacity: 0.7;
        }
        .admin-delete:hover {
          opacity: 1;
        }

        .admin-modal {
          position: fixed;
          inset: 0;
          z-index: var(--z-modal);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-4);
          background: var(--overlay-strong);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          animation: admin-fade var(--duration-base) var(--ease-standard);
        }
        @keyframes admin-fade {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .admin-modal {
            animation: none;
          }
        }

        .admin-modal-body {
          width: 100%;
          max-width: 420px;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-lg);
          overflow: hidden;
          animation: admin-pop var(--duration-base) var(--ease-standard);
        }
        @keyframes admin-pop {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .admin-modal-body {
            animation: none;
          }
        }

        .admin-modal-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-4) var(--space-4) var(--space-3);
          border-bottom: 1px solid var(--border-subtle);
        }
        .admin-modal-title {
          font-family: var(--font-sans);
          font-size: var(--text-section);
          font-weight: 600;
          color: var(--text-primary);
          letter-spacing: -0.01em;
          line-height: 1.3;
        }
        .admin-modal-sub {
          margin-top: 0.2rem;
          font-size: 0.78rem;
          color: var(--text-muted);
        }
        .admin-modal-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 0;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-xs);
          color: var(--text-muted);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .admin-modal-close:hover {
          background: var(--bg-surface-2);
          color: var(--text-primary);
        }
        .admin-modal-close:focus-visible {
          outline: 1px solid var(--accent);
          outline-offset: 2px;
        }

        .admin-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
        }
        .admin-field {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }
        .admin-label {
          font-size: 0.78rem;
          color: var(--text-secondary);
          font-weight: 500;
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
          padding: 0.5rem 0.7rem;
          background: var(--err-soft);
          border: 1px solid var(--err);
          border-radius: var(--radius-xs);
          color: var(--err);
          font-size: 0.78rem;
          line-height: 1.45;
        }

        .admin-form-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: var(--space-2);
          margin-top: 0.3rem;
        }

        /* 删除确认对话框 */
        .admin-confirm-title {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          color: var(--err);
        }
        .admin-confirm-content {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding: var(--space-4);
        }
        .admin-confirm-warn {
          font-size: 0.88rem;
          color: var(--text-secondary);
          line-height: 1.55;
        }
        .admin-confirm-email {
          color: var(--text-primary);
          font-weight: 500;
          font-family: var(--font-mono);
          font-size: 0.82rem;
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

        @media (max-width: 768px) {
          .admin-header {
            flex-direction: column;
            align-items: stretch;
          }
          .admin-create-btn {
            align-self: flex-start;
          }
          .col-usage {
            min-width: auto;
          }
        }
      `}</style>
    </div>
  );
}

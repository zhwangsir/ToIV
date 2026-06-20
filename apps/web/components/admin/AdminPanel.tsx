"use client";

import { useCallback, useEffect, useState } from "react";

import { deleteUser, listUsers } from "@/lib/api";
import type { AdminUser } from "@/lib/types";

const KIND_LABELS: Record<string, string> = {
  txt2img: "文生图",
  img2img: "图生图",
  wan_i2v: "视频",
};

function usageText(by: Record<string, number>): string {
  const parts = Object.entries(by).map(([k, v]) => `${KIND_LABELS[k] ?? k} ${v}`);
  return parts.length ? parts.join(" · ") : "—";
}

export function AdminPanel() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    listUsers()
      .then(setUsers)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onDelete = async (u: AdminUser) => {
    if (!window.confirm(`确认删除用户 ${u.email}？其作业记录将一并清除。`)) return;
    try {
      await deleteUser(u.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modlib">
      <div className="stage-head">
        <h1>
          用户 <span className="grad">管理</span>
        </h1>
        <span className="count">{users?.length ?? 0} 个账号</span>
      </div>

      {error && <div className="alert">⚠ {error}</div>}

      {!users ? (
        <p className="muted">加载中…</p>
      ) : (
        <div className="admin-table">
          <div className="admin-row admin-head">
            <span>邮箱</span>
            <span>角色</span>
            <span>总生成</span>
            <span>用量明细</span>
            <span>注册时间</span>
            <span>操作</span>
          </div>
          {users.map((u) => (
            <div className="admin-row" key={u.id}>
              <span className="admin-email">{u.email}</span>
              <span>
                <em className={`role-badge${u.role === "admin" ? " admin" : ""}`}>
                  {u.role === "admin" ? "管理员" : "用户"}
                </em>
              </span>
              <span className="num">{u.usage.total}</span>
              <span className="admin-usage">{usageText(u.usage.by_kind)}</span>
              <span className="muted">{u.created_at.slice(0, 10)}</span>
              <span>
                {u.role === "admin" ? (
                  <span className="muted">—</span>
                ) : (
                  <button type="button" className="btn-danger" onClick={() => onDelete(u)}>
                    删除
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

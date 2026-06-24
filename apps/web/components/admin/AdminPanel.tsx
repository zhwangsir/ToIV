"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { createUser, deleteUser, listUsers } from "@/lib/api";
import { springSoft } from "@/lib/motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import type { AdminUser } from "@/lib/types";

const KIND_LABELS: Record<string, string> = {
  txt2img: "文生图",
  img2img: "图生图",
  wan_i2v: "视频",
};

function usageText(by: Record<string, number>): string {
  const parts = Object.entries(by).map(([k, v]) => `${KIND_LABELS[k] ?? k} ${v}`);
  return parts.length ? parts.join(" · ") : "尚无生成";
}

function initials(email: string): string {
  const name = email.split("@")[0] ?? email;
  return name.slice(0, 2).toUpperCase();
}

export function AdminPanel() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reduced = useReducedMotion();

  const [acct, setAcct] = useState("");
  const [pwd, setPwd] = useState("");
  const [role, setRole] = useState("user");
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setError(null);
    listUsers()
      .then(setUsers)
      .catch((e: Error) => setError(e.message));
  }, []);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await createUser(acct.trim(), pwd, role);
      setAcct("");
      setPwd("");
      setRole("user");
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

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
    <div className="view">
      <header className="view-header">
        <span className="view-eyebrow">Console · 后台</span>
        <h1 className="view-title">
          用户 <em>管理</em>
        </h1>
        <p className="view-lede">发放账号、查看每位成员的生成用量,并管理权限。</p>
        <div className="view-tally">
          <span className="n">{users?.length ?? 0}</span>
          <span className="l">个账号</span>
        </div>
      </header>

      <form className="invite-bar" onSubmit={onCreate}>
        <input
          type="text"
          placeholder="新账号(3-64 位)"
          value={acct}
          onChange={(e) => setAcct(e.target.value)}
        />
        <input
          type="text"
          placeholder="初始密码(≥6 位)"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="user">用户</option>
          <option value="admin">管理员</option>
        </select>
        <button
          type="submit"
          className="generate-btn"
          disabled={creating || acct.trim().length < 3 || pwd.length < 6}
        >
          {creating ? "创建中…" : "发放账号"}
        </button>
      </form>

      {error && <div className="alert">⚠ {error}</div>}

      {!users ? (
        <div className="roster">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skel-card" style={{ height: "64px", margin: 0 }} />
          ))}
        </div>
      ) : (
        <motion.div
          className="roster"
          initial="initial"
          animate="enter"
          variants={{ enter: { transition: { staggerChildren: reduced ? 0 : 0.04 } } }}
        >
          <AnimatePresence>
            {users.map((u) => (
              <motion.div
                className="user-card"
                key={u.id}
                variants={{
                  initial: { opacity: 0, y: reduced ? 0 : 10 },
                  enter: { opacity: 1, y: 0, transition: springSoft },
                }}
                exit={{ opacity: 0, height: 0 }}
              >
                <span className={`user-avatar${u.role === "admin" ? "" : " is-user"}`} aria-hidden="true">
                  {initials(u.email)}
                </span>
                <div className="user-meta">
                  <span className="email" title={u.email}>
                    {u.email}
                  </span>
                  <span className="sub">
                    {usageText(u.usage.by_kind)}
                    <span className="dot">·</span>
                    注册于 {u.created_at.slice(0, 10)}
                  </span>
                </div>
                <span className="user-stat">
                  <span className="n">{u.usage.total}</span>
                  <span className="l">次生成</span>
                </span>
                {u.role === "admin" ? (
                  <span className="user-role admin">管理员</span>
                ) : (
                  <button type="button" className="btn-danger" onClick={() => onDelete(u)}>
                    删除
                  </button>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}

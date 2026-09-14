"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch, authHeaders, apiErrorMessage } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { PageHeader } from "@/components/ui/PageHeader";
import { Switch } from "@/components/ui/Switch";

interface CatalogApp {
  id: string;
  name: string;
  category: string;
  is_public: boolean;
  is_builtin: boolean;
  is_nsfw: boolean;
  usage_count: number;
  sort: number;
}

async function raiseErr(res: Response, fallback: string): Promise<never> {
  const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  throw new Error(apiErrorMessage(detail?.detail, `${fallback} (${res.status})`, res.status));
}

async function fetchCatalog(): Promise<CatalogApp[]> {
  const res = await apiFetch(`/api/apps?limit=5000`, { headers: authHeaders() });
  if (!res.ok) return raiseErr(res, "加载应用目录失败");
  const data = (await res.json()) as unknown;
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { items?: unknown[] })?.items)
      ? (data as { items: unknown[] }).items
      : [];
  return list.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      category: String(r.category ?? "other"),
      is_public: Boolean(r.is_public),
      is_builtin: Boolean(r.is_builtin),
      is_nsfw: Boolean(r.is_nsfw),
      usage_count: Number(r.usage_count ?? 0),
      sort: Number(r.sort ?? 100),
    };
  });
}

async function putPublic(id: string, is_public: boolean): Promise<void> {
  const res = await apiFetch(`/api/apps/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ is_public }),
  });
  if (!res.ok) return raiseErr(res, "更新上架状态失败");
}

export function AppOpsAdminView() {
  const [apps, setApps] = useState<CatalogApp[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCatalog()
      .then(setApps)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载应用目录失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = apps ?? [];
    if (!needle) return rows;
    return rows.filter(
      (a) =>
        a.id.toLowerCase().includes(needle) ||
        a.name.toLowerCase().includes(needle) ||
        a.category.toLowerCase().includes(needle),
    );
  }, [apps, q]);

  const publicCount = (apps ?? []).filter((a) => a.is_public).length;

  const togglePublic = async (a: CatalogApp, next: boolean) => {
    setBusyId(a.id);
    setError(null);
    try {
      await putPublic(a.id, next);
      setApps((prev) =>
        (prev ?? []).map((x) => (x.id === a.id ? { ...x, is_public: next } : x)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="admin-ops">
      <PageHeader
        title="应用运营"
        desc="目录上架 · 管理员可见 soft-hide，切换 is_public"
        actions={
          <>
            <span className="admin-count">
              {loading
                ? "加载中…"
                : error
                  ? "加载失败"
                  : `${apps?.length ?? 0} 个应用 · 公开 ${publicCount}`}
            </span>
            <button
              type="button"
              className="at-btn admin-create-btn"
              onClick={load}
              disabled={loading}
            >
              <Icon name="refresh" size={14} />
              刷新
            </button>
          </>
        }
      />

      {error && <ErrorBar message={error} onClose={() => setError(null)} />}

      <div className="admin-ops-toolbar">
        <label className="admin-ops-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 id / 名称 / 分类"
            aria-label="搜索应用"
          />
        </label>
      </div>

      {loading && <LoadingBlock variant="line" count={4} step="加载应用目录…" />}

      {!loading && !error && filtered.length === 0 && (
        <Empty title="没有匹配的应用" desc="换个关键词，或先播种/导入目录应用" />
      )}

      {!loading && filtered.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th className="col-user">应用</th>
                <th>分类</th>
                <th>用量</th>
                <th>标记</th>
                <th>上架</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className={busyId === a.id ? "is-deleting" : undefined}>
                  <td className="col-user">
                    <div className="admin-user-cell">
                      <div className="admin-user-meta">
                        <span className="admin-user-email">{a.name}</span>
                        <span className="admin-user-id">{a.id}</span>
                      </div>
                    </div>
                  </td>
                  <td>{a.category}</td>
                  <td>{a.usage_count}</td>
                  <td>
                    {a.is_builtin && <span className="badge">内置</span>}{" "}
                    {a.is_nsfw && <span className="badge badge-accent">R18</span>}
                  </td>
                  <td>
                    <Switch
                      checked={a.is_public}
                      disabled={busyId === a.id}
                      onChange={(v) => void togglePublic(a, v)}
                      ariaLabel={`${a.name} 上架`}
                      label={a.is_public ? "公开" : "隐藏"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <style jsx>{`
        .admin-ops-toolbar {
          display: flex;
          gap: var(--space-3);
          margin-bottom: var(--space-3);
        }
        .admin-ops-search {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          flex: 1;
          max-width: 420px;
          padding: 6px 10px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          background: var(--bg-surface);
        }
        .admin-ops-search input {
          flex: 1;
          border: 0;
          outline: none;
          background: transparent;
          color: var(--text-primary);
          font-size: var(--text-body);
        }
        .admin-user-id {
          display: block;
          font-size: var(--text-caption);
          color: var(--text-tertiary);
          font-variant-numeric: tabular-nums;
        }
      `}</style>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch, authHeaders, apiErrorMessage } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { PageHeader } from "@/components/ui/PageHeader";

interface CatalogApp {
  id: string;
  name: string;
  category: string;
}

interface GuideForm {
  app_id: string;
  purpose: string;
  when_to_use: string;
  stepsText: string;
  inputsText: string;
  outputsText: string;
  tipsText: string;
  relatedText: string;
  status: "draft" | "published";
}

async function raiseErr(res: Response, fallback: string): Promise<never> {
  const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  throw new Error(apiErrorMessage(detail?.detail, `${fallback} (${res.status})`, res.status));
}

function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function listToLines(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
}

async function fetchCatalog(): Promise<CatalogApp[]> {
  const res = await apiFetch(`/api/apps?limit=5000`, { headers: authHeaders() });
  if (!res.ok) return raiseErr(res, "加载应用失败");
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
    };
  });
}

async function fetchGuide(appId: string): Promise<GuideForm> {
  const res = await apiFetch(`/api/admin/apps/${encodeURIComponent(appId)}/guide`, {
    headers: authHeaders(),
  });
  if (!res.ok) return raiseErr(res, "加载说明书失败");
  const g = (await res.json()) as Record<string, unknown>;
  return {
    app_id: String(g.app_id ?? appId),
    purpose: String(g.purpose ?? ""),
    when_to_use: String(g.when_to_use ?? ""),
    stepsText: listToLines(g.steps),
    inputsText: listToLines(g.inputs),
    outputsText: listToLines(g.outputs),
    tipsText: listToLines(g.tips),
    relatedText: listToLines(g.related_app_ids),
    status: g.status === "published" ? "published" : "draft",
  };
}

async function saveGuide(form: GuideForm): Promise<void> {
  const res = await apiFetch(`/api/admin/apps/${encodeURIComponent(form.app_id)}/guide`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      purpose: form.purpose,
      when_to_use: form.when_to_use,
      steps: linesToList(form.stepsText),
      inputs: linesToList(form.inputsText),
      outputs: linesToList(form.outputsText),
      tips: linesToList(form.tipsText),
      related_app_ids: linesToList(form.relatedText),
      status: form.status,
    }),
  });
  if (!res.ok) return raiseErr(res, "保存说明书失败");
}

const EMPTY: GuideForm = {
  app_id: "",
  purpose: "",
  when_to_use: "",
  stepsText: "",
  inputsText: "",
  outputsText: "",
  tipsText: "",
  relatedText: "",
  status: "draft",
};

export function AppGuidesAdminView() {
  const [apps, setApps] = useState<CatalogApp[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<GuideForm>(EMPTY);
  const [loadingApps, setLoadingApps] = useState(true);
  const [loadingGuide, setLoadingGuide] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    setLoadingApps(true);
    fetchCatalog()
      .then((rows) => {
        setApps(rows);
        if (rows[0] && !selectedId) setSelectedId(rows[0].id);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载应用失败"),
      )
      .finally(() => setLoadingApps(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = apps ?? [];
    if (!needle) return rows;
    return rows.filter(
      (a) =>
        a.id.toLowerCase().includes(needle) ||
        a.name.toLowerCase().includes(needle),
    );
  }, [apps, q]);

  const loadGuide = useCallback((appId: string) => {
    if (!appId) return;
    setLoadingGuide(true);
    setError(null);
    setOkMsg(null);
    fetchGuide(appId)
      .then(setForm)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载说明书失败"),
      )
      .finally(() => setLoadingGuide(false));
  }, []);

  useEffect(() => {
    if (selectedId) loadGuide(selectedId);
  }, [selectedId, loadGuide]);

  const onSave = async () => {
    if (!form.app_id) return;
    setSaving(true);
    setError(null);
    setOkMsg(null);
    try {
      await saveGuide(form);
      setOkMsg(form.status === "published" ? "已保存并发布" : "已保存为草稿");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const setField = <K extends keyof GuideForm>(key: K, value: GuideForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="admin-guides">
      <PageHeader
        title="说明书"
        desc="为应用填写用途 / 场景 / 步骤 · 草稿或发布"
        actions={
          <button
            type="button"
            className="at-btn at-btn--primary admin-create-btn"
            onClick={() => void onSave()}
            disabled={!form.app_id || saving || loadingGuide}
          >
            <Icon name="check" size={14} />
            {saving ? "保存中…" : "保存说明书"}
          </button>
        }
      />

      {error && <ErrorBar message={error} onClose={() => setError(null)} />}
      {okMsg && <div className="admin-guides-ok">{okMsg}</div>}

      <div className="admin-guides-layout">
        <aside className="admin-guides-aside at-card">
          <label className="admin-ops-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="筛选应用"
              aria-label="筛选应用"
            />
          </label>
          {loadingApps && <LoadingBlock variant="line" count={3} step="加载应用…" />}
          {!loadingApps && filtered.length === 0 && (
            <Empty title="无应用" desc="目录为空" />
          )}
          <ul className="admin-guides-list">
            {filtered.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={
                    selectedId === a.id
                      ? "admin-guides-item is-active"
                      : "admin-guides-item"
                  }
                  onClick={() => setSelectedId(a.id)}
                >
                  <span className="admin-guides-item-name">{a.name}</span>
                  <span className="admin-guides-item-id">{a.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="admin-guides-editor at-card">
          {!selectedId && <Empty title="请选择应用" desc="左侧点选一张卡" />}
          {selectedId && loadingGuide && <LoadingBlock variant="line" count={3} step="加载说明书…" />}
          {selectedId && !loadingGuide && (
            <div className="admin-guides-form">
              <div className="admin-guides-row">
                <label>
                  状态
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setField(
                        "status",
                        e.target.value === "published" ? "published" : "draft",
                      )
                    }
                  >
                    <option value="draft">草稿</option>
                    <option value="published">已发布</option>
                  </select>
                </label>
              </div>
              <label>
                用途
                <textarea
                  rows={2}
                  value={form.purpose}
                  onChange={(e) => setField("purpose", e.target.value)}
                  placeholder="这张应用做什么"
                />
              </label>
              <label>
                适用场景
                <textarea
                  rows={2}
                  value={form.when_to_use}
                  onChange={(e) => setField("when_to_use", e.target.value)}
                  placeholder="什么时候该用它"
                />
              </label>
              <label>
                步骤（一行一步）
                <textarea
                  rows={4}
                  value={form.stepsText}
                  onChange={(e) => setField("stepsText", e.target.value)}
                />
              </label>
              <label>
                输入（一行一项）
                <textarea
                  rows={3}
                  value={form.inputsText}
                  onChange={(e) => setField("inputsText", e.target.value)}
                />
              </label>
              <label>
                输出（一行一项）
                <textarea
                  rows={3}
                  value={form.outputsText}
                  onChange={(e) => setField("outputsText", e.target.value)}
                />
              </label>
              <label>
                提示（一行一条）
                <textarea
                  rows={3}
                  value={form.tipsText}
                  onChange={(e) => setField("tipsText", e.target.value)}
                />
              </label>
              <label>
                关联应用 id（一行一个）
                <textarea
                  rows={2}
                  value={form.relatedText}
                  onChange={(e) => setField("relatedText", e.target.value)}
                />
              </label>
            </div>
          )}
        </section>
      </div>

      <style jsx>{`
        .admin-guides-ok {
          margin-bottom: var(--space-3);
          padding: 8px 12px;
          border-radius: var(--radius-md);
          background: color-mix(in srgb, var(--accent) 12%, transparent);
          color: var(--text-primary);
          font-size: var(--text-body);
        }
        .admin-guides-layout {
          display: grid;
          grid-template-columns: minmax(200px, 280px) 1fr;
          gap: var(--space-3);
          align-items: start;
        }
        @media (max-width: 900px) {
          .admin-guides-layout {
            grid-template-columns: 1fr;
          }
        }
        .admin-guides-aside,
        .admin-guides-editor {
          padding: var(--space-3);
        }
        .admin-ops-search {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          width: 100%;
          margin-bottom: var(--space-3);
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
        }
        .admin-guides-list {
          list-style: none;
          margin: 0;
          padding: 0;
          max-height: 60vh;
          overflow: auto;
        }
        .admin-guides-item {
          width: 100%;
          text-align: left;
          border: 0;
          background: transparent;
          padding: 8px 10px;
          border-radius: var(--radius-md);
          cursor: pointer;
          color: var(--text-primary);
        }
        .admin-guides-item:hover {
          background: var(--bg-surface-2);
        }
        .admin-guides-item.is-active {
          background: color-mix(in srgb, var(--accent) 14%, transparent);
        }
        .admin-guides-item-name {
          display: block;
          font-weight: 600;
        }
        .admin-guides-item-id {
          display: block;
          font-size: var(--text-caption);
          color: var(--text-tertiary);
        }
        .admin-guides-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .admin-guides-form label {
          display: flex;
          flex-direction: column;
          gap: 6px;
          font-size: var(--text-body);
          color: var(--text-secondary);
        }
        .admin-guides-form textarea,
        .admin-guides-form select {
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          padding: 8px 10px;
          background: var(--bg-surface);
          color: var(--text-primary);
          font: inherit;
        }
      `}</style>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  listApps,
  putCuration,
  retagOne,
  smokeOne,
  togglePublic,
  type AdminApp,
} from "@/lib/api";

const USE_CASES = [
  "photo", "face", "edit", "fashion", "drama", "motion",
  "art", "anime", "avatar", "ecommerce", "ad", "other",
] as const;

type RowState = { busy?: boolean; note?: string };

export function AppsManager() {
  const [apps, setApps] = useState<AdminApp[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "public" | "smoke-fail">("all");
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const load = useCallback(async () => {
    try {
      setApps(await listApps(q));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const visible = useMemo(() => {
    const list = apps ?? [];
    if (filter === "public") return list.filter((a) => a.is_public);
    if (filter === "smoke-fail") return list.filter((a) => a.smoke_status === "fail" || a.smoke_status === "timeout");
    return list;
  }, [apps, filter]);

  const mark = (id: string, patch: RowState) =>
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const doSmoke = async (a: AdminApp) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      const r = (await smokeOne(a.id)) as { status?: string; cls?: string };
      mark(a.id, { busy: false, note: `烟测 ${r.status ?? "?"}` });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: e instanceof Error ? e.message : "烟测出错" });
    }
  };

  const doRetag = async (a: AdminApp) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      const r = await retagOne(a.id);
      mark(a.id, { busy: false, note: `→ ${r.use_case}` });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: e instanceof Error ? e.message : "打标出错" });
    }
  };

  const doCuration = async (a: AdminApp, useCase: string) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      await putCuration(a.id, { use_case: useCase });
      mark(a.id, { busy: false, note: `分类 → ${useCase}` });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: e instanceof Error ? e.message : "策展出错" });
    }
  };

  const toggleFeatured = async (a: AdminApp) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      await putCuration(a.id, { featured: !a.featured });
      mark(a.id, { busy: false });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: e instanceof Error ? e.message : "策展出错" });
    }
  };

  const togglePublicState = async (a: AdminApp) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      await togglePublic(a.id, !a.is_public);
      mark(a.id, { busy: false });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: e instanceof Error ? e.message : "切换出错" });
    }
  };

  return (
    <div>
      <div className="bar">
        <input
          style={{ width: 280 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索名称/简介…"
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">全部应用</option>
          <option value="public">仅已上架</option>
          <option value="smoke-fail">烟测失败/超时</option>
        </select>
        <div className="spacer" />
        <span className="muted">{visible.length} 个应用</span>
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </div>
      {err && <div className="login-err">{err}</div>}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>封面</th>
              <th>应用</th>
              <th>产物</th>
              <th>分类</th>
              <th>上架</th>
              <th>烟测</th>
              <th className="num">用量</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, 120).map((a) => {
              const st = rows[a.id] ?? {};
              return (
                <tr key={a.id}>
                  <td>
                    {a.cover_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        className="cover-thumb"
                        src={`${a.cover_url}${a.cover_url.includes("?") ? "&" : "?"}token=${typeof window !== "undefined" ? window.localStorage.getItem("toiv_admin_token") ?? "" : ""}`}
                        alt=""
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <div>{a.name}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{a.id}</div>
                    {st.note && <div className="pill warn">{st.note}</div>}
                  </td>
                  <td>{a.output_kind}</td>
                  <td>
                    <select
                      value={USE_CASES.includes((a.use_case ?? "") as never) ? a.use_case : "other"}
                      disabled={st.busy}
                      onChange={(e) => void doCuration(a, e.target.value)}
                    >
                      {USE_CASES.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className={`act-btn${a.is_public ? " is-done" : ""}`}
                      title="切换上架(公开)状态"
                      onClick={() => void togglePublicState(a)}
                    >
                      {a.is_public ? "已上架" : "未上架"}
                    </button>
                    {a.featured && <span className="pill on">精选</span>}
                    {a.is_nsfw && <span className="pill danger">R18</span>}
                  </td>
                  <td>
                    <span
                      className={`pill${a.smoke_status === "pass" ? " ok" : a.smoke_status === "fail" || a.smoke_status === "timeout" ? " danger" : ""}`}
                    >
                      {a.smoke_status || "未测"}
                    </span>
                  </td>
                  <td className="num">{a.usage_count}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className={`act-btn${st.busy ? " is-busy" : ""}`}
                      disabled={st.busy}
                      onClick={() => void doSmoke(a)}
                    >
                      烟测
                    </button>
                    <button
                      className={`act-btn${st.busy ? " is-busy" : ""}`}
                      disabled={st.busy}
                      onClick={() => void doRetag(a)}
                    >
                      重打标
                    </button>
                    <button
                      className={`act-btn${a.featured ? " is-done" : ""}`}
                      disabled={st.busy}
                      onClick={() => void toggleFeatured(a)}
                    >
                      {a.featured ? "取消精选" : "设精选"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length > 120 && (
          <div className="muted" style={{ padding: 10 }}>
            仅显示前 120 个,用搜索缩小范围。
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { getToken, systemJobs, type SystemJob } from "@/lib/api";

type SysTab = "covers" | "failed";

const TABS: { key: SysTab; label: string; kinds: string; desc: string }[] = [
  {
    key: "covers",
    label: "封面生成记录",
    kinds: "app_cover_demo,app_cover",
    desc: "封面产物的溯源档案(prompt_id/worker/来源文件)——独立于用户作品库,此处只读",
  },
  {
    key: "failed",
    label: "失败作业(全体用户)",
    kinds: "",
    desc: "全平台生成失败作业;用户侧「一键清理失败」会将其软删入回收站",
  },
];

function resultUrl(result: string): string {
  try {
    const arr = JSON.parse(result) as string[];
    return arr[0] ?? "";
  } catch {
    return "";
  }
}

export function SystemJobs() {
  const [tab, setTab] = useState<SysTab>("covers");
  const [jobs, setJobs] = useState<SystemJob[] | null>(null);
  const [err, setErr] = useState("");
  const active = TABS.find((t) => t.key === tab)!;

  const load = useCallback(async () => {
    setErr("");
    try {
      setJobs(await systemJobs(active.kinds || "app_cover_demo,app_cover"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [active.kinds]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    let list = jobs ?? [];
    if (tab === "failed") {
      // 失败页:拉系统封面记录无意义,改拉全体失败作业
      return list;
    }
    return list;
  }, [jobs, tab]);

  const fetchFailed = useCallback(async () => {
    setErr("");
    try {
      const res = await fetch("/api/jobs?all=1&limit=100&status=error", {
        headers: { Authorization: `Bearer ${getToken() ?? ""}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setJobs((await res.json()) as SystemJob[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    if (tab === "failed") void fetchFailed();
    else void load();
  }, [tab, fetchFailed, load]);

  return (
    <div>
      <div className="bar">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`btn${tab === t.key ? " primary" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <div className="spacer" />
        <span className="muted">{active.desc}</span>
        <button className="btn" onClick={() => (tab === "failed" ? void fetchFailed() : void load())}>
          刷新
        </button>
      </div>
      {err && <div className="login-err">{err}</div>}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {tab === "covers" && <th>封面</th>}
              <th>kind</th>
              <th>时间</th>
              <th>worker</th>
              <th>提示词/来源</th>
              {tab === "failed" && <th>错误</th>}
              <th>产物</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => {
              const url = resultUrl(j.result);
              const token = getToken() ?? "";
              let source = "";
              try {
                source = (JSON.parse(j.params) as { source?: string }).source ?? "";
              } catch {
                /* params 非 JSON */
              }
              return (
                <tr key={j.id}>
                  {tab === "covers" && (
                    <td>
                      {url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          className="cover-thumb"
                          src={`${url}${url.includes("?") ? "&" : "?"}token=${token}`}
                          alt=""
                        />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  )}
                  <td>
                    <span className="pill">{j.kind}</span>
                  </td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {j.created_at?.slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {j.worker?.replace(/^https?:\/\//, "")}
                  </td>
                  <td>
                    {(j.prompt || "").slice(0, 60) || "—"}
                    {source && <div className="muted" style={{ fontSize: 11 }}>来源 {source}</div>}
                  </td>
                  {tab === "failed" && (
                    <td className="muted">{(j.params || "").slice(0, 0)}{(j as SystemJob & { error?: string }).error ? String((j as SystemJob & { error?: string }).error).slice(0, 60) : "—"}</td>
                  )}
                  <td>
                    {url ? (
                      <a className="act-btn" href={`${url}?token=${token}`} target="_blank" rel="noreferrer">
                        查看
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !err && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: "center", padding: 20 }}>
                  暂无记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

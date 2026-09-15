"use client";

import { useCallback, useEffect, useState } from "react";

import {
  cleanupFailed,
  demoStatus,
  health,
  jobCounts,
  listProposals,
  smokeStatus,
  startDemoBatch,
  startSmokeBatch,
  type DemoStatus,
  type HealthInfo,
  type JobCounts,
  type SelfhealProposal,
} from "@/lib/api";

export function Dashboard() {
  const [healthInfo, setHealthInfo] = useState<HealthInfo | null>(null);
  const [counts, setCounts] = useState<JobCounts | null>(null);
  const [demo, setDemo] = useState<DemoStatus | null>(null);
  const [smoke, setSmoke] = useState<DemoStatus | null>(null);
  const [proposals, setProposals] = useState<SelfhealProposal[]>([]);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    const results = await Promise.allSettled([
      health(),
      jobCounts(),
      demoStatus(),
      smokeStatus(),
      listProposals(),
    ]);
    if (results[0].status === "fulfilled") setHealthInfo(results[0].value);
    if (results[1].status === "fulfilled") setCounts(results[1].value);
    if (results[2].status === "fulfilled") setDemo(results[2].value);
    if (results[3].status === "fulfilled") setSmoke(results[3].value);
    if (results[4].status === "fulfilled") setProposals(results[4].value.proposals ?? []);
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(reload, 15000);
    return () => clearInterval(timer);
  }, [reload]);

  const doCleanup = async () => {
    setCleanupBusy(true);
    try {
      const { deleted } = await cleanupFailed();
      setNote(`已清理 ${deleted} 件失败作品(回收站 72h 可恢复)`);
      await reload();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "清理出错");
    } finally {
      setCleanupBusy(false);
    }
  };

  const doDemoBatch = async () => {
    try {
      const r = await startDemoBatch(600);
      setNote(`封面批已启动,待做 ${r.planned}`);
      await reload();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "启动出错");
    }
  };

  const doSmokeBatch = async () => {
    try {
      await startSmokeBatch(100);
      setNote("烟测批已启动(limit=100)");
      await reload();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "启动出错");
    }
  };

  const pct =
    demo && demo.total && demo.done !== undefined
      ? Math.round((demo.done / Math.max(demo.total, 1)) * 100)
      : 0;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="grid-cards">
        <div className="card">
          <h3>平台健康</h3>
          <div className="stat-row">
            <div className="stat">
              <div className="num">{healthInfo?.status === "ok" ? "正常" : "—"}</div>
              <div className="lbl">API 状态</div>
            </div>
            <div className="stat">
              <div className="num">{healthInfo?.workers?.length ?? "—"}</div>
              <div className="lbl">GPU Worker</div>
            </div>
          </div>
          {healthInfo?.workers && (
            <div className="muted" style={{ marginTop: 8, fontSize: 12, wordBreak: "break-all" }}>
              {healthInfo.workers.join(" · ")}
            </div>
          )}
        </div>

        <div className="card">
          <h3>作品库(全体用户)</h3>
          <div className="stat-row">
            <div className="stat">
              <div className="num">{counts?.count ?? "—"}</div>
              <div className="lbl">作品总数</div>
            </div>
            <div className="stat">
              <div className="num" style={{ color: "var(--danger)" }}>
                {counts?.failed ?? "—"}
              </div>
              <div className="lbl">失败待清理</div>
            </div>
          </div>
          <div className="bar">
            <button className="btn danger" disabled={cleanupBusy || !counts?.failed} onClick={doCleanup}>
              一键清理失败
            </button>
            {note && <span className="muted">{note}</span>}
          </div>
        </div>

        <div className="card">
          <h3>真实 Demo 封面批</h3>
          {demo && !demo.never_run && demo.total ? (
            <>
              <div className="bar">
                <div className="progressbar">
                  <i style={{ width: `${pct}%` }} />
                </div>
                <span className="pill on">
                  {demo.done}/{demo.total}
                </span>
              </div>
              <div className="bar">
                <span className="pill">{demo.running ? "运行中" : "空闲"}</span>
                <span className="pill ok">成功 {demo.ok}</span>
                <span className="pill warn">失败 {Math.max(0, (demo.done ?? 0) - (demo.ok ?? 0))}</span>
                <div className="spacer" />
                <button className="btn" disabled={demo.running} onClick={doDemoBatch}>
                  {demo.running ? "运行中…" : "补跑/续跑 limit=600"}
                </button>
              </div>
            </>
          ) : (
            <div className="bar">
              <span className="muted">尚未运行</span>
              <div className="spacer" />
              <button className="btn" onClick={doDemoBatch}>
                启动全量批
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <h3>应用烟测批</h3>
          <div className="bar">
            <span className="pill">{smoke?.running ? "运行中" : "空闲"}</span>
            {smoke?.done !== undefined && <span className="pill">done {smoke.done}</span>}
            <div className="spacer" />
            <button className="btn" disabled={smoke?.running} onClick={doSmokeBatch}>
              启动批 limit=100
            </button>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            烟测 = 应用真跑一遍 + 失败归因;封面批已内含同能力,此入口用于不产出封面的纯烟测。
          </div>
        </div>

        <div className="card">
          <h3>LLM 自愈提案(最近)</h3>
          {proposals.length === 0 ? (
            <div className="muted">暂无提案</div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>应用</th>
                    <th>归因</th>
                    <th>状态</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.slice(0, 8).map((p) => (
                    <tr key={p.id}>
                      <td>{p.app_id}</td>
                      <td>
                        <span className="pill warn">{p.cls}</span>
                      </td>
                      <td>{p.status}</td>
                      <td className="muted">{p.note?.slice(0, 60)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

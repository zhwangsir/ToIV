"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  fetchTestMatrix,
  type L0ResultRow,
  type L2ResultRow,
  type TestMatrixResponse,
} from "@/lib/api";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { PageHeader } from "@/components/ui/PageHeader";

const L0_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部" },
  { value: "fail", label: "失败" },
  { value: "warn", label: "警告" },
  { value: "pass", label: "通过" },
];

/** warn/fail 优先排前:fail → warn → pass → 其他;同级保持原序(稳定排序)。 */
function l0Rank(s: string): number {
  if (s === "fail") return 0;
  if (s === "warn") return 1;
  if (s === "pass") return 2;
  return 3;
}

function l0Tone(s: string): BadgeTone {
  if (s === "pass") return "ok";
  if (s === "warn") return "warn";
  if (s === "fail") return "err";
  return "neutral";
}

function l0Label(s: string): string {
  if (s === "pass") return "通过";
  if (s === "warn") return "警告";
  if (s === "fail") return "失败";
  return s || "—";
}

function l2Tone(s: string | undefined): BadgeTone {
  if (s === "pass") return "ok";
  if (s === "fail_timeout") return "warn";
  if (s && s.startsWith("fail")) return "err";
  return "neutral";
}

function l2Label(s: string | undefined): string {
  if (s === "pass") return "通过";
  if (s === "fail_product") return "失败";
  if (s === "fail_timeout") return "超时";
  return s || "—";
}

function httpTone(code: number | null | undefined): BadgeTone {
  if (code == null) return "neutral";
  return code >= 200 && code < 300 ? "ok" : "err";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** L2 行 job_id:优先 run_response(提交响应),兜底行顶层字段。 */
function l2JobId(r: L2ResultRow): string | null {
  return r.run_response?.job_id ?? r.job_id ?? null;
}

/** by_output_kind 分布渲染:{image:{pass:189},…} → "image 189 · video 359"。 */
function kindDist(by: Record<string, Record<string, number>> | undefined): string {
  if (!by) return "—";
  const parts = Object.entries(by).map(([k, v]) => {
    const n = Object.values(v ?? {}).reduce((s, x) => s + (Number(x) || 0), 0);
    return `${k} ${n}`;
  });
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * Admin D6 实测矩阵(2026-09-22 实装,替换骨架占位):
 * L0 结构扫描 550 行 + L2 真 GPU 热路径 24 行(静态快照,admin 只读端点)。
 */
export function AppTestMatrixAdminView() {
  const [data, setData] = useState<TestMatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [l0Filter, setL0Filter] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTestMatrix()
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载实测矩阵失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const l0Counts = useMemo(() => {
    const m: Record<string, number> = { pass: 0, warn: 0, fail: 0 };
    for (const r of data?.l0_results ?? []) {
      m[r.l0_status] = (m[r.l0_status] ?? 0) + 1;
    }
    return m;
  }, [data]);

  const l0Rows = useMemo(() => {
    const rows = (data?.l0_results ?? []).filter(
      (r) => !l0Filter || r.l0_status === l0Filter,
    );
    return rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => l0Rank(a.r.l0_status) - l0Rank(b.r.l0_status) || a.i - b.i)
      .map(({ r }) => r);
  }, [data, l0Filter]);

  const isEmpty =
    !loading &&
    !error &&
    data !== null &&
    data.l0_results.length === 0 &&
    data.l2_results.length === 0;

  const l0s = data?.l0_summary;
  const l2s = data?.l2_summary;
  const l2Counts = l2s?.counts ?? {};

  return (
    <div className="tm-view">
      <PageHeader
        title="实测矩阵"
        desc="应用分级实测 · L0 结构扫描(全量公开应用)+ L2 真 GPU 热路径冒烟(静态快照)"
      />

      {error && !loading && (
        <div className="at-card tm-state-card">
          <div className="tm-error-row">
            <ErrorBar message={error} onClose={() => setError(null)} />
            <button type="button" className="at-btn at-btn--ghost" onClick={load}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          </div>
        </div>
      )}

      {!error && loading && (
        <div className="at-card tm-state-card">
          <LoadingBlock variant="line" count={4} className="tm-loading" />
        </div>
      )}

      {!error && !loading && isEmpty && (
        <div className="at-card tm-state-card">
          <Empty
            size="section"
            icon="grid"
            title="实测矩阵暂无数据"
            desc="结果快照未部署或为空(app/data/app_test_matrix/)"
          />
        </div>
      )}

      {!error && !loading && data && !isEmpty && (
        <>
          {/* ── L0 结构扫描 ─────────────────────────────────── */}
          <section className="tm-section">
            <h2 className="tm-h">L0 结构扫描</h2>
            <div className="tm-stats">
              <div className="tm-stat at-card">
                <span className="tm-stat-label">公开应用</span>
                <span className="tm-stat-value">{l0s?.total_public ?? "—"}</span>
                <span className="tm-stat-hint">
                  {l0s?.elapsed_sec != null ? `扫描耗时 ${l0s.elapsed_sec}s` : "schema/bindings 结构检查"}
                </span>
              </div>
              <div className="tm-stat at-card">
                <span className="tm-stat-label">通过</span>
                <span className="tm-stat-value tm-v-ok">{l0s?.pass ?? "—"}</span>
                <span className="tm-stat-hint">l0_status = pass</span>
              </div>
              <div className="tm-stat at-card">
                <span className="tm-stat-label">警告</span>
                <span className="tm-stat-value tm-v-warn">{l0s?.warn ?? "—"}</span>
                <span className="tm-stat-hint">l0_status = warn</span>
              </div>
              <div className="tm-stat at-card">
                <span className="tm-stat-label">失败</span>
                <span className="tm-stat-value tm-v-err">{l0s?.fail ?? "—"}</span>
                <span className="tm-stat-hint">l0_status = fail</span>
              </div>
              <div className="tm-stat at-card">
                <span className="tm-stat-label">输出分布</span>
                <span className="tm-stat-dist">{kindDist(l0s?.by_output_kind)}</span>
                <span className="tm-stat-hint">
                  {l0s?.generated_at ? `生成于 ${l0s.generated_at}` : "按 output_kind"}
                </span>
              </div>
            </div>

            <div className="tm-filters at-card">
              <div className="tm-chips" role="group" aria-label="L0 状态筛选">
                {L0_FILTERS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`tm-chip${l0Filter === o.value ? " is-active" : ""}`}
                    onClick={() => setL0Filter(o.value)}
                  >
                    {o.label}
                    <span className="tm-chip-n">
                      {o.value === ""
                        ? (data.l0_results.length ?? 0)
                        : (l0Counts[o.value] ?? 0)}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="at-card tm-card">
              {l0Rows.length === 0 ? (
                <Empty
                  size="section"
                  icon="grid"
                  title="无匹配行"
                  desc="当前筛选条件下没有 L0 结果"
                />
              ) : (
                <div className="tm-table-wrap">
                  <table className="tm-table">
                    <thead>
                      <tr>
                        <th>应用</th>
                        <th className="tm-col-status">状态</th>
                        <th className="tm-col-kind">输出</th>
                        <th className="tm-col-usage">用量</th>
                        <th>原因 / 警告</th>
                      </tr>
                    </thead>
                    <tbody>
                      {l0Rows.map((r: L0ResultRow) => {
                        const notes = [...(r.reasons ?? []), ...(r.warns ?? [])];
                        return (
                          <tr key={r.id}>
                            <td>
                              <span className="tm-name">{r.name}</span>
                              <span className="tm-id" title={r.id}>
                                {r.id}
                              </span>
                            </td>
                            <td className="tm-col-status">
                              <Badge tone={l0Tone(r.l0_status)} dot={false}>
                                {l0Label(r.l0_status)}
                              </Badge>
                            </td>
                            <td className="tm-col-kind">
                              <span className="tm-mono tm-dim">{r.output_kind}</span>
                            </td>
                            <td className="tm-col-usage">
                              <span className="tm-mono tm-dim">{r.usage_count}</span>
                            </td>
                            <td>
                              <span className="tm-dim" title={notes.join("\n")}>
                                {notes.length > 0 ? truncate(notes.join(";"), 90) : "—"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* ── L2 真 GPU 热路径 ────────────────────────────── */}
          <section className="tm-section">
            <h2 className="tm-h">L2 热路径冒烟(真 GPU 提交)</h2>
            <div className="tm-stats">
              <div className="tm-stat at-card">
                <span className="tm-stat-label">实测总数</span>
                <span className="tm-stat-value">{l2s?.total ?? "—"}</span>
                <span className="tm-stat-hint">
                  {l2s?.generated_at ? `生成于 ${l2s.generated_at}` : "热路径候选"}
                </span>
              </div>
              <div className="tm-stat at-card">
                <span className="tm-stat-label">通过</span>
                <span className="tm-stat-value tm-v-ok">{l2Counts.pass ?? "—"}</span>
                <span className="tm-stat-hint">作业 done</span>
              </div>
              <div className="tm-stat at-card">
                <span className="tm-stat-label">失败</span>
                <span className="tm-stat-value tm-v-err">
                  {l2Counts.fail_product ?? "—"}
                </span>
                <span className="tm-stat-hint">fail_product</span>
              </div>
              <div className="tm-stat at-card">
                <span className="tm-stat-label">超时</span>
                <span className="tm-stat-value tm-v-warn">
                  {l2Counts.fail_timeout ?? "—"}
                </span>
                <span className="tm-stat-hint">fail_timeout</span>
              </div>
            </div>

            <div className="at-card tm-card">
              {data.l2_results.length === 0 ? (
                <Empty
                  size="section"
                  icon="zap"
                  title="L2 暂无结果"
                  desc="热路径冒烟快照为空"
                />
              ) : (
                <div className="tm-table-wrap">
                  <table className="tm-table">
                    <thead>
                      <tr>
                        <th>应用</th>
                        <th className="tm-col-kind">引擎族</th>
                        <th className="tm-col-kind">提交方式</th>
                        <th className="tm-col-status">HTTP</th>
                        <th className="tm-col-status">结果</th>
                        <th className="tm-col-usage">耗时</th>
                        <th className="tm-col-job">作业</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.l2_results.map((r) => {
                        const jobId = l2JobId(r);
                        return (
                          <tr key={r.id}>
                            <td>
                              <span className="tm-name">{r.name}</span>
                              <span className="tm-id" title={r.id}>
                                {r.id}
                              </span>
                            </td>
                            <td className="tm-col-kind">
                              <span className="tm-mono tm-dim">{r.family}</span>
                            </td>
                            <td className="tm-col-kind">
                              <span className="tm-mono tm-dim">{r.submit_kind}</span>
                            </td>
                            <td className="tm-col-status">
                              <Badge tone={httpTone(r.run_http)} dot={false}>
                                {r.run_http ?? "—"}
                              </Badge>
                            </td>
                            <td className="tm-col-status">
                              <Badge tone={l2Tone(r.status)} dot={false}>
                                {l2Label(r.status)}
                              </Badge>
                            </td>
                            <td className="tm-col-usage">
                              <span className="tm-mono tm-dim">
                                {r.elapsed_sec != null ? `${r.elapsed_sec.toFixed(1)}s` : "—"}
                              </span>
                            </td>
                            <td className="tm-col-job">
                              <span className="tm-mono tm-dim" title={jobId ?? ""}>
                                {jobId ? jobId.slice(0, 8) : "—"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {data.l2_candidates.length > 0 && (
                <details className="tm-cands">
                  <summary>
                    L2 候选清单({data.l2_candidates.length})· 入选评分与理由
                  </summary>
                  <div className="tm-table-wrap">
                    <table className="tm-table">
                      <thead>
                        <tr>
                          <th>应用</th>
                          <th className="tm-col-kind">引擎族</th>
                          <th className="tm-col-usage">评分</th>
                          <th className="tm-col-usage">用量</th>
                          <th>入选理由</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.l2_candidates.map((c) => (
                          <tr key={c.id}>
                            <td>
                              <span className="tm-name">{c.name}</span>
                              <span className="tm-id" title={c.id}>
                                {c.id}
                              </span>
                            </td>
                            <td className="tm-col-kind">
                              <span className="tm-mono tm-dim">{c.family}</span>
                            </td>
                            <td className="tm-col-usage">
                              <span className="tm-mono">{c.score}</span>
                            </td>
                            <td className="tm-col-usage">
                              <span className="tm-mono tm-dim">{c.usage_count ?? "—"}</span>
                            </td>
                            <td>
                              <span className="tm-dim" title={c.why}>
                                {c.why}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          </section>
        </>
      )}

      <style jsx>{`
        .tm-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }
        .tm-section {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .tm-h {
          margin: 0;
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
        }

        .tm-state-card {
          padding: 0;
          overflow: hidden;
        }
        .tm-loading {
          padding: var(--space-4);
        }
        .tm-error-row {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-4) var(--space-5);
        }
        .tm-error-row :global(.ui-error-bar) {
          flex: 1;
          min-width: 0;
        }

        .tm-stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: var(--space-3);
        }
        .tm-stat {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-4);
        }
        .tm-stat-label {
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted);
        }
        .tm-stat-value {
          font-size: var(--text-display-md);
          font-weight: var(--font-bold);
          font-family: var(--font-mono);
          letter-spacing: -0.02em;
          line-height: 1.2;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }
        .tm-stat-value.tm-v-ok {
          color: var(--ok);
        }
        .tm-stat-value.tm-v-warn {
          color: var(--warn);
        }
        .tm-stat-value.tm-v-err {
          color: var(--err);
        }
        .tm-stat-dist {
          font-size: var(--text-aux);
          font-family: var(--font-mono);
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
          line-height: 1.5;
        }
        .tm-stat-hint {
          font-size: var(--text-aux);
          color: var(--text-muted);
        }

        .tm-filters {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-3);
          flex-wrap: wrap;
        }
        .tm-chips {
          display: inline-flex;
          align-items: center;
          flex-wrap: wrap;
          gap: var(--space-2);
        }
        .tm-chip {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          min-height: 26px;
          padding: 0 var(--space-3);
          border-radius: var(--radius-full);
          border: 1px solid var(--border-subtle);
          background: transparent;
          color: var(--text-secondary);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          cursor: pointer;
          white-space: nowrap;
          transition: border-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .tm-chip:hover {
          border-color: var(--border-strong);
          color: var(--text-primary);
        }
        .tm-chip.is-active {
          background: var(--accent-soft);
          border-color: var(--accent);
          color: var(--text-primary);
        }
        .tm-chip-n {
          font-family: var(--font-mono);
          font-size: var(--text-label);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }

        .tm-card {
          padding: 0;
          overflow: hidden;
        }
        .tm-table-wrap {
          overflow-x: auto;
        }
        @media (max-width: 767px) {
          .tm-table-wrap {
            -webkit-mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
            mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
          }
          .tm-table {
            min-width: 720px;
          }
        }
        .tm-table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--text-body);
        }
        .tm-table thead th {
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
        .tm-table tbody td {
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
          vertical-align: middle;
          color: var(--text-secondary);
        }
        .tm-table tbody tr {
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .tm-table tbody tr:nth-child(even) {
          background: var(--bg-surface-2);
        }
        .tm-table tbody tr:hover {
          background: var(--accent-soft);
        }
        .tm-table tbody tr:last-child td {
          border-bottom: none;
        }

        .tm-col-status {
          width: 90px;
          white-space: nowrap;
        }
        .tm-col-kind {
          width: 110px;
          white-space: nowrap;
        }
        .tm-col-usage {
          width: 80px;
          white-space: nowrap;
        }
        .tm-col-job {
          width: 100px;
          white-space: nowrap;
        }

        .tm-name {
          display: block;
          color: var(--text-primary);
          font-weight: var(--font-medium);
        }
        .tm-id {
          display: block;
          margin-top: 1px;
          font-family: var(--font-mono);
          font-size: var(--text-label);
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 240px;
        }
        .tm-mono {
          font-family: var(--font-mono);
          font-size: var(--text-aux);
        }
        .tm-dim {
          color: var(--text-muted);
          font-size: var(--text-aux);
        }

        .tm-cands {
          border-top: 1px solid var(--border-subtle);
        }
        .tm-cands summary {
          padding: var(--space-3) var(--space-4);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          color: var(--text-secondary);
          cursor: pointer;
          user-select: none;
        }
        .tm-cands summary:hover {
          color: var(--text-primary);
        }
        .tm-cands[open] summary {
          border-bottom: 1px solid var(--border-subtle);
        }
      `}</style>
    </div>
  );
}

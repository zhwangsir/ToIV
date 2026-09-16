"use client";

/**
 * 画布视图(2026-09-16 原生化重构)。
 *
 * 默认「原生」模式:React Flow 自绘节点图(FlowCanvas),工作流来自 ComfyUI
 * userdata(经 /api/canvas/proxy 同源代理),参数就地改、一键 POST /api/generate/raw
 * 运行入作品库 —— 浏览器不再直连 Workstation,公网/移动端/主题全兼容。
 * 「ComfyUI 原版」模式 = 旧 iframe 全功能逃生门(CanvasIframe),拓扑级编辑仍走它。
 *
 * 应用「在 ComfyUI 中打开」的 pending:优先读其上传到 userdata 的 UI 图(带原始
 * 坐标),失败退回 fetchApp 的 workflow_json(API 格式 + 自动布局)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { getApp } from "@/lib/apps";
import { layoutWorkflow } from "@/components/apps/AppWorkflowGraph";
import {
  parseApiWorkflow,
  parseUiWorkflow,
  toApiFormat,
  type ApiGraphNode,
  type CanvasGraph,
  type NodeDef,
  type ObjectInfoMap,
  type UiWorkflow,
} from "@/lib/canvasFlow";
import { API_BASE, getToken, imageUrl } from "@/lib/api";
import FlowCanvas from "./FlowCanvas";
import { CanvasIframe } from "./CanvasIframe";

/* object_info 前端累积缓存:只增量取缺失类,跨工作流复用 */
const _objCache = new Map<string, NodeDef>();
const _objFail = new Set<string>();
const BUILTIN_SPECIAL_TYPES = new Set(["Reroute", "PrimitiveNode", "Note", "MarkdownNote"]);

async function fetchObjectInfo(classes: string[]): Promise<ObjectInfoMap> {
  const missing = [...new Set(classes)].filter(
    (c) => c && !_objCache.has(c) && !_objFail.has(c) && !BUILTIN_SPECIAL_TYPES.has(c),
  );
  if (missing.length > 0) {
    try {
      const resp = await fetch(
        `${API_BASE}/api/canvas/object_info?classes=${encodeURIComponent(missing.join(","))}`,
        // 12s 快速失败:LB 被大作业压住时降级为未知节点渲染,不让画布白转一分钟
        { headers: { Authorization: `Bearer ${getToken()}` }, signal: AbortSignal.timeout(12_000) },
      );
      if (!resp.ok) throw new Error(`object_info ${resp.status}`);
      const data = (await resp.json()) as ObjectInfoMap;
      for (const [k, v] of Object.entries(data)) _objCache.set(k, v);
      for (const c of missing) if (!data[c]) _objFail.add(c);
    } catch {
      for (const c of missing) _objFail.add(c); // 失败不再反复打上游;节点按未知类渲染
    }
  }
  const out: ObjectInfoMap = {};
  for (const c of classes) {
    if (BUILTIN_SPECIAL_TYPES.has(c)) continue;
    out[c] = _objCache.get(c) ?? {};
  }
  return out;
}

/* ── 工作流清单/读取(经同源代理) ── */

interface UdFile {
  path: string;
  size: number;
  modified: number;
}

const UD_LIST_URL = `${API_BASE}/api/canvas/proxy/api/userdata?dir=workflows&recurse=true&split=false&full_info=true`;

function authFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${getToken()}` },
    signal: AbortSignal.timeout(45_000),
  });
}

async function listWorkflows(): Promise<UdFile[]> {
  const resp = await authFetch(UD_LIST_URL);
  if (!resp.ok) throw new Error(`工作流列表 ${resp.status}`);
  const data = (await resp.json()) as Array<{ path: string; size?: number; modified?: number } | string>;
  return (Array.isArray(data) ? data : [])
    .map((d) =>
      typeof d === "string" ? { path: d, size: 0, modified: 0 } : { path: d.path, size: d.size ?? 0, modified: d.modified ?? 0 },
    )
    .filter((f) => f.path.toLowerCase().endsWith(".json"))
    .sort((a, b) => b.modified - a.modified);
}

async function readWorkflow(path: string): Promise<UiWorkflow> {
  // 专用端点:proxy 透传会把 %2F 解码导致上游 404,这里由 api 侧自行编码转发
  const resp = await authFetch(
    `${API_BASE}/api/canvas/workflow?path=${encodeURIComponent(path)}`,
  );
  if (!resp.ok) throw new Error(`工作流读取 ${resp.status}`);
  return (await resp.json()) as UiWorkflow;
}

/* ── pending(应用「在 ComfyUI 中打开」) ── */

interface PendingApp {
  id?: string;
  name?: string;
  workflowName?: string;
}

function readPending(): PendingApp | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem("toiv_pending_comfy_workflow");
    if (!raw) return null;
    const d = JSON.parse(raw) as { id?: string; name?: string; workflow_name?: string };
    if (!d.id && !d.workflow_name) return null;
    return { id: d.id, name: d.name, workflowName: d.workflow_name };
  } catch {
    return null;
  }
}

function prettyName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.json$/i, "").replace(/^toiv_app_/, "");
}

/** api 的 detail 可能是字符串也可能是 ComfyUI 校验错误对象,统一转可读文案。 */
function detailText(d: unknown, fallback: string): string {
  if (typeof d === "string" && d) return d;
  if (d && typeof d === "object") {
    const err = (d as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string" && err.message) return err.message;
    try {
      return JSON.stringify(d);
    } catch {
      /* 循环引用兜底 */
    }
  }
  return fallback;
}

/* ── 运行态 ── */

type RunState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "running"; promptId: string; since: number }
  | { phase: "done"; promptId: string; preview?: string }
  | { phase: "error"; message: string };

export function CanvasView() {
  const [mode, setMode] = useState<"native" | "comfy">("native");
  const [files, setFiles] = useState<UdFile[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [graph, setGraph] = useState<CanvasGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrClosed, setLoadErrClosed] = useState(false);
  const [graphKey, setGraphKey] = useState(0);
  const [pending, setPending] = useState<PendingApp | null>(() => readPending());
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [graphLabel, setGraphLabel] = useState<string>("");
  const reloadTick = useRef(0);

  /** 统一装载:先补 object_info,再解析;uiJson 带坐标,apiJson 走自动布局。 */
  const loadUi = useCallback(async (json: UiWorkflow, label: string) => {
    const types = (json.nodes ?? []).map((n) => n.type);
    const info = await fetchObjectInfo(types);
    setGraph(parseUiWorkflow(json, info));
    setGraphLabel(label);
    setGraphKey((k) => k + 1);
  }, []);

  const loadApi = useCallback(
    async (wf: Record<string, ApiGraphNode>, label: string) => {
      const info = await fetchObjectInfo(Object.values(wf).map((n) => n.class_type));
      const g = parseApiWorkflow(wf, info);
      try {
        const layout = layoutWorkflow(wf, {});
        const pos = new Map(layout.boxes.map((b) => [b.id, b]));
        for (const n of g.nodes) {
          const b = pos.get(n.id);
          if (b) {
            n.x = b.x;
            n.y = b.y;
          }
        }
      } catch {
        /* 布局失败保持 (0,0) 竖排,不阻塞 */
      }
      setGraph(g);
      setGraphLabel(label);
      setGraphKey((k) => k + 1);
    },
    [],
  );

  const reloadList = useCallback(async () => {
    setListState("loading");
    try {
      const fs = await listWorkflows();
      setFiles(fs);
      setListState("ready");
      return fs;
    } catch {
      setListState("error");
      return [];
    }
  }, []);

  const loadSelected = useCallback(
    async (path: string) => {
      if (!path) return;
      setGraphLoading(true);
      setLoadError(null);
      setLoadErrClosed(false);
      try {
        await loadUi(await readWorkflow(path), prettyName(path));
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "工作流加载失败");
      } finally {
        setGraphLoading(false);
      }
    },
    [loadUi],
  );

  /* 首次:pending 优先(应用入口),否则自动选最新工作流 */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fs = await reloadList();
      if (cancelled) return;
      if (pending?.workflowName) {
        const name = pending.workflowName.replace(/^workflows\//, "");
        const hit = fs.find((f) => f.path === name || f.path === `${name}.json`) ?? null;
        try {
          const json = await readWorkflow(hit ? hit.path : name);
          if (!cancelled) await loadUi(json, pending.name ? `应用「${pending.name}」` : prettyName(name));
          return;
        } catch {
          /* userdata 读不到 → 退回 fetchApp 的 API 图 */
        }
      }
      if (pending?.id) {
        try {
          const app = await getApp(pending.id);
          if (app.workflow_json && !cancelled) {
            await loadApi(app.workflow_json, pending.name ? `应用「${pending.name}」` : app.name);
            return;
          }
        } catch {
          /* 应用详情不可得 → 走默认选择 */
        }
      }
      const firstUser = fs.find((f) => !f.path.startsWith("toiv_app_"));
      const pick = firstUser ?? fs[0];
      if (pick && !cancelled) {
        setSelected(pick.path);
        await loadSelected(pick.path);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* widget 编辑:父层同步(FlowCanvas 内部态独立防重建) */
  const handleWidgetChange = useCallback((nodeId: string, name: string, v: unknown) => {
    setGraph(
      (g) =>
        g && {
          ...g,
          nodes: g.nodes.map((n) =>
            n.id !== nodeId ? n : { ...n, widgets: n.widgets.map((w) => (w.name === name ? { ...w, value: v } : w)) },
          ),
        },
    );
  }, []);

  /* 运行:API 格式导出 → /generate/raw → lookup 轮询 */
  const submitRun = useCallback(async () => {
    if (!graph || run.phase === "submitting" || run.phase === "running") return;
    const { graph: apiGraph, warnings } = toApiFormat(graph);
    if (!apiGraph) {
      setRun({ phase: "error", message: "导出后的图为空,无法运行" });
      return;
    }
    setRun({ phase: "submitting" });
    try {
      const resp = await authFetch(`${API_BASE}/api/generate/raw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph: apiGraph }),
      });
      const data = (await resp.json().catch(() => ({}))) as { prompt_id?: string; detail?: unknown };
      if (!resp.ok || !data.prompt_id)
        throw new Error(detailText(data.detail, `提交失败 ${resp.status}`));
      setRun({ phase: "running", promptId: data.prompt_id, since: Date.now() });
      if (warnings.length > 0) console.info("[canvas] 运行告警:", warnings);
    } catch (e) {
      setRun({ phase: "error", message: e instanceof Error ? e.message : "提交失败" });
    }
  }, [graph, run.phase]);

  useEffect(() => {
    if (run.phase !== "running") return;
    const { promptId, since } = run;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const resp = await authFetch(`${API_BASE}/api/jobs/lookup?prompt_id=${encodeURIComponent(promptId)}`);
        if (!resp.ok) return; // 404/500:下一轮再试
        const job = (await resp.json()) as { status?: string; results?: string[]; error?: unknown };
        if (cancelled) return;
        if (job.status === "done") {
          const first = job.results?.[0];
          const isImg = first ? /\.(png|jpe?g|webp|gif)(\?|$)/i.test(first) : false;
          setRun({ phase: "done", promptId, preview: isImg && first ? imageUrl(first) : undefined });
          clearInterval(timer);
        } else if (job.status === "error" || job.status === "cancelled") {
          setRun({ phase: "error", message: detailText(job.error, `作业 ${job.status}`) });
          clearInterval(timer);
        } else if (Date.now() - since > 30 * 60_000) {
          setRun({ phase: "error", message: "等待超时(>30 分钟),作业可能仍在排队,可到作品库查看" });
          clearInterval(timer);
        }
      } catch {
        /* 弱网:下轮再试 */
      }
    }, 3500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [run]);

  const grouped = useMemo(() => {
    const mine = files.filter((f) => !f.path.startsWith("toiv_app_")).slice(0, 200);
    const exported = files.filter((f) => f.path.startsWith("toiv_app_")).slice(0, 200);
    return { mine, exported };
  }, [files]);

  return (
    <div className="cfl2-view">
      <header className="cfl2-bar">
        <div className="cfl2-bar-left">
          <div className="cfl2-mode" role="tablist" aria-label="画布模式">
            <button type="button" data-active={mode === "native"} onClick={() => setMode("native")}>
              <Icon name="layers" size={13} strokeWidth={1.8} />
              原生画布
            </button>
            <button type="button" data-active={mode === "comfy"} onClick={() => setMode("comfy")}>
              <Icon name="workflow" size={13} strokeWidth={1.8} />
              ComfyUI 原版
            </button>
          </div>
          {mode === "native" && (
            <>
              <select
                className="cfl2-select"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  void loadSelected(e.target.value);
                }}
                aria-label="选择工作流"
              >
                {listState === "loading" && <option value="">列表加载中…</option>}
                {listState === "error" && <option value="">列表加载失败</option>}
                {grouped.mine.length > 0 && (
                  <optgroup label="我的工作流">
                    {grouped.mine.map((f) => (
                      <option key={f.path} value={f.path}>
                        {prettyName(f.path)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {grouped.exported.length > 0 && (
                  <optgroup label="应用导出">
                    {grouped.exported.map((f) => (
                      <option key={f.path} value={f.path}>
                        {prettyName(f.path)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <button
                type="button"
                className="cfl2-iconbtn"
                title="刷新工作流列表"
                onClick={() => void reloadList()}
              >
                <Icon name="refresh" size={14} strokeWidth={1.8} />
              </button>
            </>
          )}
        </div>
        <div className="cfl2-bar-right">
          {mode === "native" && graph && (
            <>
              <span className="cfl2-meta">
                {graphLabel}
                {graph.nodes.length > 0 && ` · ${graph.nodes.length} 节点 · ${graph.edges.length} 连线`}
                {graph.hasSubgraphDefs && " · 含子图"}
              </span>
              <RunChip run={run} onRetry={() => setRun({ phase: "idle" })} />
              <button
                type="button"
                className="cfl2-run"
                onClick={() => void submitRun()}
                disabled={run.phase === "submitting" || run.phase === "running"}
              >
                <Icon name={run.phase === "running" ? "loading" : "play"} size={14} strokeWidth={1.9} />
                {run.phase === "submitting" ? "提交中…" : run.phase === "running" ? "运行中" : "运行"}
              </button>
            </>
          )}
        </div>
      </header>

      <ErrorBar
        message={mode === "native" && !loadErrClosed ? loadError : null}
        onClose={() => setLoadErrClosed(true)}
      />

      {mode === "comfy" ? (
        <div className="cfl2-iframe-host">
          <CanvasIframe />
        </div>
      ) : (
        <div className="cfl2-body">
          {pending && (
            <div className="cfl2-pending" role="status">
              <Icon name="info" size={14} />
              <span>
                来自应用「{pending.name ?? pending.id}」
                {graph ? "的工作流已载入原生画布,可直接改参数后运行。" : ":工作流载入失败,可在下方列表手动选择。"}
              </span>
              <button
                type="button"
                className="cfl2-pending-x"
                onClick={() => {
                  try {
                    sessionStorage.removeItem("toiv_pending_comfy_workflow");
                  } catch {
                    /* ignore */
                  }
                  setPending(null);
                }}
              >
                知道了
              </button>
            </div>
          )}
          <div className="cfl2-stage">
            {graph ? (
              <FlowCanvas graph={graph} graphKey={`g${graphKey}`} onWidgetChange={handleWidgetChange} />
            ) : graphLoading || listState === "loading" ? (
              <div className="cfl2-empty">
                <Icon name="loading" size={20} className="cfl2-spin" />
                <p>正在载入工作流…</p>
              </div>
            ) : (
              <div className="cfl2-empty">
                <Icon name="workflow" size={26} />
                <p>{listState === "error" ? "工作流列表不可达" : "暂无工作流,可从应用页「在 ComfyUI 中打开」进入"}</p>
              </div>
            )}
            {run.phase === "done" && (
              <div className="cfl2-runpanel">
                <div className="cfl2-runpanel-head">
                  <Icon name="check" size={14} />
                  <span>运行完成</span>
                  <button type="button" className="cfl2-pending-x" onClick={() => setRun({ phase: "idle" })}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
                {run.preview && <img className="cfl2-runpanel-img" src={run.preview} alt="生成结果" />}
                <a className="cfl2-runpanel-link" href="/?view=library">
                  前往作品库查看 →
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RunChip({ run, onRetry }: { run: RunState; onRetry: () => void }) {
  if (run.phase === "idle" || run.phase === "submitting") return null;
  if (run.phase === "running") {
    return (
      <span className="cfl2-chip cfl2-chip--run">
        <Icon name="loading" size={12} className="cfl2-spin" />
        排队/运行中
      </span>
    );
  }
  if (run.phase === "error") {
    return (
      <span className="cfl2-chip cfl2-chip--err" title={run.message}>
        <Icon name="warning" size={12} />
        失败
        <button type="button" onClick={onRetry} className="cfl2-chip-x">
          知道了
        </button>
      </span>
    );
  }
  return null;
}

import { app } from "../../scripts/app.js";

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_WAIT_MS = 45000;
const RETRY_DELAYS_MS = [0, 200, 500, 1000, 2000, 3000, 5000, 8000];

function toast(severity, summary, detail) {
  try {
    const api = window.comfyAPI || window;
    const toastStore =
      api?.toastStore ||
      app?.extensionManager?.toast ||
      app?.ui?.dialog;
    if (toastStore?.add) {
      toastStore.add({ severity, summary, detail, life: 8000 });
      return;
    }
  } catch (_) {
    /* ignore */
  }
  console[severity === "error" ? "error" : "log"](`[toiv.workflow_query] ${summary}: ${detail}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Canvas/graph ready enough for loadGraphData on Comfy 1.45.x Vue frontend. */
function isCanvasReady() {
  try {
    if (!app) return false;
    if (!app.graph && !app.rootGraph) return false;
    const canvas = app.canvas || app.canvasEl || null;
    if (!canvas) return false;
    // LiteGraph canvas object usually exposes .canvas DOM element
    const el = canvas.canvas || canvas.canvasElement || (canvas instanceof HTMLCanvasElement ? canvas : null);
    if (el && typeof el.getContext === "function") {
      // Prefer visible non-zero size when available; accept attached element otherwise.
      if (el.isConnected === false) return false;
      if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) {
        // Still allow if getContext works — some layouts keep canvas in hidden host briefly.
        try {
          if (!el.getContext("2d")) return false;
        } catch (_) {
          return false;
        }
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function waitForCanvasReady(timeoutMs = MAX_WAIT_MS) {
  const start = Date.now();
  // Fast path
  if (isCanvasReady()) return true;
  // Prefer Comfy status events when available
  try {
    const apiMod = await import("../../scripts/api.js").catch(() => null);
    const api = apiMod?.api || window.comfyAPI?.api || window.api;
    if (api?.addEventListener) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try {
            api.removeEventListener("status", onStatus);
          } catch (_) {
            /* ignore */
          }
          resolve();
        };
        const onStatus = () => {
          if (isCanvasReady()) finish();
        };
        api.addEventListener("status", onStatus);
        const tick = async () => {
          while (!done && Date.now() - start < timeoutMs) {
            if (isCanvasReady()) {
              finish();
              return;
            }
            await sleep(150);
          }
          finish();
        };
        tick();
      });
      return isCanvasReady();
    }
  } catch (_) {
    /* fall through to poll */
  }
  while (Date.now() - start < timeoutMs) {
    if (isCanvasReady()) return true;
    await sleep(150);
  }
  return isCanvasReady();
}

function stripQueryFlags() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete("workflow");
    u.searchParams.delete("_r");
    window.history.replaceState({}, "", u.toString());
  } catch (_) {
    /* ignore */
  }
}

function isCanvasNullError(err) {
  const msg = String(err?.message || err || "");
  return /canvas is null|getCanvas/i.test(msg);
}

async function fetchWorkflowGraph(name) {
  const url = `/api/userdata/workflows%2F${encodeURIComponent(name)}`;
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`无法读取 ${name} (HTTP ${resp.status}). 请返回应用页重试「打开工作流」。`);
  }
  const graph = await resp.json();
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes)) {
    throw new Error(`${name} 不是有效的 UI 工作流 JSON`);
  }
  return graph;
}

async function loadGraphWithRetries(graph, name) {
  let lastErr = null;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    const delay = RETRY_DELAYS_MS[i];
    if (delay) await sleep(delay);
    // Re-check readiness each attempt
    if (!isCanvasReady()) {
      await waitForCanvasReady(8000);
    }
    try {
      // Avoid app.clean() — on Vue 1.45 it can tear down canvas and cause getCanvas:null.
      // Prefer clearing nodes on the existing graph when available.
      try {
        if (app.graph?.clear) app.graph.clear();
        else if (app.rootGraph?.clear) app.rootGraph.clear();
      } catch (_) {
        /* ignore */
      }
      const fname = name.replace(/\.json$/i, "");
      if (typeof app.loadGraphData === "function") {
        await app.loadGraphData(graph, /* clean */ true, /* restore_view */ true, fname);
      } else if (app.ui?.loadGraphData) {
        await app.ui.loadGraphData(graph);
      } else {
        throw new Error("loadGraphData 不可用");
      }
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[toiv.workflow_query] load attempt ${i + 1} failed`, err);
      if (!isCanvasNullError(err) && i >= 2) break;
    }
  }
  throw lastErr || new Error("loadGraphData 失败");
}

async function loadNamedWorkflow(name, { stripQuery = true } = {}) {
  if (!name) return false;
  if (!NAME_RE.test(name)) {
    toast("error", "ToIV 工作流", `非法 workflow 参数: ${name}`);
    return false;
  }
  let graph;
  try {
    graph = await fetchWorkflowGraph(name);
  } catch (err) {
    toast("error", "ToIV 工作流加载失败", String(err?.message || err));
    return false;
  }
  const ready = await waitForCanvasReady();
  if (!ready) {
    console.warn("[toiv.workflow_query] canvas not ready after wait; attempting load anyway");
  }
  try {
    await loadGraphWithRetries(graph, name);
    toast("success", "ToIV 工作流已加载", name);
    if (stripQuery) stripQueryFlags();
    return true;
  } catch (err) {
    console.error("[toiv.workflow_query] loadGraphData failed", err);
    toast(
      "error",
      "ToIV 工作流加载失败",
      String(err?.message || err) || "loadGraphData 异常",
    );
    return false;
  }
}

async function loadFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get("workflow");
  if (!name) return;
  await loadNamedWorkflow(name, { stripQuery: true });
}

function installPostMessageBridge() {
  window.addEventListener("message", (ev) => {
    try {
      const data = ev?.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "toiv-load-workflow" && data.type !== "toiv.loadWorkflow") return;
      const name = data.workflow || data.workflowName || data.name;
      if (!name || typeof name !== "string") return;
      loadNamedWorkflow(name, { stripQuery: false });
    } catch (err) {
      console.warn("[toiv.workflow_query] postMessage handler error", err);
    }
  });
}

app.registerExtension({
  name: "toiv.workflow_query",
  async setup() {
    installPostMessageBridge();
    // Defer past first paint / Vue mount; then wait for canvas.
    await sleep(50);
    await loadFromQuery();
  },
  // Extra hooks when Comfy provides them (no-op if never called)
  async afterConfigureGraph() {
    // If query still present (prior load aborted), retry once canvas configured.
    const params = new URLSearchParams(window.location.search);
    const name = params.get("workflow");
    if (name) {
      await loadNamedWorkflow(name, { stripQuery: true });
    }
  },
});

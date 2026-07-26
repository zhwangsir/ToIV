/** 画布模块 zustand store —— 前端画布状态中心。
 *
 * 职责:
 *  1. 管理画布列表 + 当前激活画布
 *  2. 维护 @xyflow/react 的 nodes/edges 状态(与后端 CanvasNode/CanvasEdge 双向同步)
 *  3. SSE 订阅画布事件(Agent 后端操作节点时,前端实时收到并更新)
 *  4. 提供操作方法:addNode / updateNode / removeNode / addEdge / removeEdge / runNode
 *
 * 设计:
 *  - 节点/边状态用 @xyflow/react 的 OnNodesChange / OnEdgesChange 协议,
 *    前端拖动/缩放后通过 onNodesChange 回写 store,store 再 debounce 同步到后端
 *  - SSE 事件收到后,直接 set nodes/edges,不触发后端回写(避免循环)
 *  - 后端节点状态变更(Agent 执行中/完成)只通过 SSE 推,前端不主动轮询
 */

"use client";

import { create } from "zustand";
import {
  addEdge as apiAddEdge,
  addNode as apiAddNode,
  createCanvas as apiCreateCanvas,
  deleteCanvas as apiDeleteCanvas,
  deleteEdge as apiDeleteEdge,
  deleteNode as apiDeleteNode,
  getCanvas,
  listCanvases,
  runNode as apiRunNode,
  subscribeCanvasEvents,
  updateCanvas as apiUpdateCanvas,
  updateNode as apiUpdateNode,
  type CanvasEvent,
  type CreateNodeInput,
} from "./api";
import {
  toFlowEdge,
  toFlowNode,
  type Canvas,
  type CanvasNodeKind,
  type ToivFlowEdge,
  type ToivFlowNode,
} from "./types";
import type { Connection, EdgeChange, NodeChange } from "@xyflow/react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";

interface CanvasStoreState {
  // 画布列表
  canvases: Canvas[];
  canvasesLoading: boolean;
  canvasesError: string | null;

  // 当前激活画布
  activeCanvasId: string | null;
  activeCanvas: Canvas | null;

  // @xyflow/react 节点/边状态
  nodes: ToivFlowNode[];
  edges: ToivFlowEdge[];

  // 加载/错误状态
  loading: boolean;
  error: string | null;

  // SSE 断连标记(重连次数耗尽后置 true,供 UI 层提示"连接已丢失")
  connectionLost: boolean;

  // SSE 订阅实例(切换画布时关闭旧的)
  _eventSource: EventSource | null;

  // ---------- 画布列表操作 ----------
  loadCanvases: () => Promise<void>;
  createCanvas: (name?: string) => Promise<Canvas>;
  selectCanvas: (id: string) => Promise<void>;
  deleteActiveCanvas: () => Promise<void>;
  renameActiveCanvas: (name: string) => Promise<void>;

  // ---------- 节点/边操作 ----------
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  addNode: (input: Omit<CreateNodeInput, "position_x" | "position_y"> & { position?: { x: number; y: number } }) => Promise<void>;
  updateNodePayload: (nodeId: string, payload: Record<string, unknown>) => Promise<void>;
  removeNode: (nodeId: string) => Promise<void>;
  runNode: (nodeId: string) => Promise<void>;

  // ---------- 派生 getter(非 state,从 nodes 派生) ----------
  /** 当前选中节点 id 列表(M2 子图执行用) */
  selectedNodeIds: () => string[];

  // ---------- SSE 订阅 ----------
  _subscribe: (canvasId: string) => void;
  _unsubscribe: () => void;
  _handleEvent: (ev: CanvasEvent) => void;
  clearConnectionLost: () => void;

  // ---------- 重置 ----------
  reset: () => void;
}

// ---------- 模块级 debounce 表:节点位置变更回写后端 ----------
// 注:zustand store 是模块级单例,但不能在 store state 里放 timer(ref-like state
// 会破坏 zustand 序列化模型)。因此在模块顶层维护 Map<nodeId, setTimeout handle>。
// key=nodeId,value=尚未触发的回写 setTimeout handle。
const _positionWritebackTimers = new Map<string, ReturnType<typeof setTimeout>>();
const POSITION_WRITEBACK_DEBOUNCE_MS = 500;

/** 为某节点调度一次 500ms 后的位置回写。
 *  - 同一节点的新调用会取消上次未触发的回写(debounce)
 *  - 失败不回滚(M1 容忍最终一致,失败时刷新会拉到旧位置)
 *  - 静默失败:不打断用户拖动体验
 */
function _schedulePositionWriteback(
  canvasId: string,
  nodeId: string,
  x: number,
  y: number,
) {
  const prev = _positionWritebackTimers.get(nodeId);
  if (prev) clearTimeout(prev);
  const handle = setTimeout(() => {
    _positionWritebackTimers.delete(nodeId);
    apiUpdateNode(canvasId, nodeId, { position_x: x, position_y: y }).catch(() => {
      // 静默失败
    });
  }, POSITION_WRITEBACK_DEBOUNCE_MS);
  _positionWritebackTimers.set(nodeId, handle);
}

/** 清空所有未触发的位置回写 timer(切换/删除/重置画布时调用)。 */
function _clearAllPositionWritebackTimers() {
  _positionWritebackTimers.forEach((h) => clearTimeout(h));
  _positionWritebackTimers.clear();
}

/** 取消某节点未触发的位置回写(节点被删除时调用,避免回写 404)。 */
function _cancelPositionWriteback(nodeId: string) {
  const h = _positionWritebackTimers.get(nodeId);
  if (h) {
    clearTimeout(h);
    _positionWritebackTimers.delete(nodeId);
  }
}

// ---------- 模块级 SSE 断线重连状态 ----------
// 指数退避参数:初始 1s,每次 ×2,封顶 30s,最多 5 次后放弃并置 connectionLost。
// 与 _positionWritebackTimers 同理,重连计数/定时器放模块顶层,不进 store state。
const SSE_RETRY_BASE_MS = 1000;
const SSE_RETRY_MAX_MS = 30000;
const SSE_RETRY_MAX_COUNT = 5;
let _retryCount = 0;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;

/** 取消未触发的重连 timer(不重置计数,供 _unsubscribe 使用;
 * 注意 _subscribe 内部会调 _unsubscribe,若在此重置计数会破坏退避累积)。 */
function _cancelRetryTimer() {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
}

/** 取消重连 timer 并重置计数(切换/删除/重置画布时调用)。 */
function _clearRetryState() {
  _cancelRetryTimer();
  _retryCount = 0;
}

export const useCanvasStore = create<CanvasStoreState>((set, get) => ({
  canvases: [],
  canvasesLoading: false,
  canvasesError: null,

  activeCanvasId: null,
  activeCanvas: null,

  nodes: [],
  edges: [],

  loading: false,
  error: null,

  connectionLost: false,

  _eventSource: null,

  // ---------- 画布列表 ----------
  loadCanvases: async () => {
    set({ canvasesLoading: true, canvasesError: null });
    try {
      const items = await listCanvases();
      set({ canvases: items, canvasesLoading: false });
    } catch (e) {
      set({ canvasesError: (e as Error).message, canvasesLoading: false });
    }
  },

  createCanvas: async (name) => {
    const c = await apiCreateCanvas(name);
    set((s) => ({ canvases: [c, ...s.canvases] }));
    return c;
  },

  selectCanvas: async (id) => {
    // 切换前关闭旧的 SSE(_unsubscribe 内部会取消重连 timer)
    get()._unsubscribe();
    // 重置重连计数,新画布从 0 开始退避
    _clearRetryState();
    // 清理上一画布未触发的位置回写 timer,避免回写到错误画布
    _clearAllPositionWritebackTimers();
    // 持久化激活画布:刷新后恢复,避免"切到第一个画布导致看似删除复活"
    if (typeof window !== "undefined") {
      window.localStorage.setItem("toiv_active_canvas", id);
    }
    set({
      activeCanvasId: id,
      loading: true,
      error: null,
      nodes: [],
      edges: [],
      connectionLost: false,
    });
    try {
      const snap = await getCanvas(id);
      set({
        activeCanvas: snap.canvas,
        nodes: snap.nodes.map(toFlowNode),
        edges: snap.edges.map(toFlowEdge),
        loading: false,
      });
      // 订阅画布事件
      get()._subscribe(id);
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  deleteActiveCanvas: async () => {
    const id = get().activeCanvasId;
    if (!id) return;
    get()._unsubscribe();
    // 重置重连计数
    _clearRetryState();
    // 清理未触发的位置回写 timer(画布已删,回写无意义且会 404)
    _clearAllPositionWritebackTimers();
    await apiDeleteCanvas(id);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("toiv_active_canvas");
    }
    set((s) => ({
      canvases: s.canvases.filter((c) => c.id !== id),
      activeCanvasId: null,
      activeCanvas: null,
      nodes: [],
      edges: [],
      connectionLost: false,
    }));
  },

  renameActiveCanvas: async (name) => {
    const id = get().activeCanvasId;
    if (!id) return;
    const c = await apiUpdateCanvas(id, { name });
    set((s) => ({
      activeCanvas: c,
      canvases: s.canvases.map((x) => (x.id === id ? c : x)),
    }));
  },

  // ---------- 节点/边操作 ----------
  onNodesChange: (changes) => {
    // 本地立即应用(拖动/选区等 UI 反馈)
    // 注:applyNodeChanges 的 changes 参数类型为 NodeChange<Node>[](默认 Node),
    // 不会自动推断为 NodeChange<ToivFlowNode>[],因此返回 Node[] 而非 ToivFlowNode[]。
    // 这里 cast 为 ToivFlowNode[] 是类型安全的:运行时 applyNodeChanges 只做位置/选区
    // 等纯字段变更,不会破坏 data: CanvasNodeData 结构。
    set({ nodes: applyNodeChanges(changes, get().nodes) as ToivFlowNode[] });

    // 位置变更(position 类型 change)debounce 500ms 后回写后端;
    // 拖动过程中会触发多次 position change(dragging=true),debounce 自然合并:
    // 每次新 change 取消旧 timer,只在用户停手 500ms 后才发请求。
    const canvasId = get().activeCanvasId;
    if (canvasId) {
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) {
          _schedulePositionWriteback(canvasId, ch.id, ch.position.x, ch.position.y);
        } else if (ch.type === "remove") {
          // O3.1:删除闭环 —— 键盘 Delete/Backspace 删除节点此前只改本地,
          // 刷新后"复活"。这里同步调后端删除(静默失败,与位置回写同策略);
          // 节点级联边由后端删除,本地的边 remove change 重复删会 404,吞掉即可。
          _cancelPositionWriteback(ch.id);
          apiDeleteNode(canvasId, ch.id).catch(() => {});
        }
      }
    }
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
    // O3.1:边删除同步后端(同上,此前仅本地生效)
    const canvasId = get().activeCanvasId;
    if (canvasId) {
      for (const ch of changes) {
        if (ch.type === "remove") {
          apiDeleteEdge(canvasId, ch.id).catch(() => {});
        }
      }
    }
  },

  onConnect: (conn) => {
    const canvasId = get().activeCanvasId;
    if (!canvasId || !conn.source || !conn.target) return;
    // 先本地加一条临时边,后端确认后替换为真实边(含 id)
    const tempId = `temp_${Date.now()}`;
    const tempEdge: ToivFlowEdge = {
      id: tempId,
      source: conn.source,
      target: conn.target,
      sourceHandle: conn.sourceHandle || undefined,
      targetHandle: conn.targetHandle || undefined,
    };
    set((s) => ({ edges: [...s.edges, tempEdge] }));
    apiAddEdge(canvasId, {
      source: conn.source,
      target: conn.target,
      source_handle: conn.sourceHandle || "",
      target_handle: conn.targetHandle || "",
    })
      .then((e) => {
        // 替换临时边为真实边
        set((s) => ({
          edges: s.edges.map((x) => (x.id === tempId ? toFlowEdge(e) : x)),
        }));
      })
      .catch(() => {
        // 失败移除临时边
        set((s) => ({ edges: s.edges.filter((x) => x.id !== tempId) }));
      });
  },

  addNode: async (input) => {
    const canvasId = get().activeCanvasId;
    if (!canvasId) throw new Error("未激活画布");
    const pos = input.position ?? { x: Math.random() * 400, y: Math.random() * 300 };
    const node = await apiAddNode(canvasId, {
      kind: input.kind,
      title: input.title,
      position_x: pos.x,
      position_y: pos.y,
      payload: input.payload,
      width: input.width,
      height: input.height,
    });
    // 本地追加(SSE 也会推,但本地加更快)
    set((s) => ({ nodes: [...s.nodes, toFlowNode(node)] }));
  },

  updateNodePayload: async (nodeId, payload) => {
    const canvasId = get().activeCanvasId;
    if (!canvasId) return;
    // 先本地更新
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, payload: { ...n.data.payload, ...payload } as never } }
          : n
      ),
    }));
    // 后端同步(失败不回滚,M1 容忍最终一致)
    await apiUpdateNode(canvasId, nodeId, { payload });
  },

  removeNode: async (nodeId) => {
    const canvasId = get().activeCanvasId;
    if (!canvasId) return;
    // O3.1:清理未触发的位置回写,避免删除后回写 404
    _cancelPositionWriteback(nodeId);
    // 先本地移除
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== nodeId),
      edges: s.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    }));
    await apiDeleteNode(canvasId, nodeId);
  },

  runNode: async (nodeId) => {
    const canvasId = get().activeCanvasId;
    if (!canvasId) return;
    // O3.3:running 防重(节点组件双击/连点不重复触发后端执行)
    const cur = get().nodes.find((n) => n.id === nodeId);
    if (!cur || cur.data.status === "running") return;
    // 标记 running
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, status: "running", error: undefined } } : n
      ),
    }));
    try {
      const updated = await apiRunNode(canvasId, nodeId);
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === nodeId ? toFlowNode(updated) : n)),
      }));
    } catch (e) {
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, status: "error", error: (e as Error).message } }
            : n
        ),
      }));
    }
  },

  // ---------- 派生 getter ----------
  selectedNodeIds: () => get().nodes.filter((n) => n.selected).map((n) => n.id),

  // ---------- SSE 订阅 ----------
  _subscribe: (canvasId) => {
    get()._unsubscribe();
    const es = subscribeCanvasEvents(
      canvasId,
      (ev) => get()._handleEvent(ev),
      () => {
        // 断线处理:关闭旧 EventSource(阻止浏览器自带的自动重连),
        // 改由 store 做指数退避重连:1s → 2s → 4s → 8s → 16s(封顶 30s),
        // 连续失败 5 次后放弃并置 connectionLost,等 UI 层提示用户手动刷新。
        const cur = get()._eventSource;
        if (cur) {
          cur.close();
          set({ _eventSource: null });
        }
        if (get().activeCanvasId !== canvasId) return;
        if (_retryCount >= SSE_RETRY_MAX_COUNT) {
          _retryCount = 0;
          set({ connectionLost: true });
          return;
        }
        const delay = Math.min(
          SSE_RETRY_BASE_MS * 2 ** _retryCount,
          SSE_RETRY_MAX_MS,
        );
        _retryCount += 1;
        _retryTimer = setTimeout(() => {
          _retryTimer = null;
          if (get().activeCanvasId === canvasId) get()._subscribe(canvasId);
        }, delay);
      }
    );
    set({ _eventSource: es });
  },

  _unsubscribe: () => {
    // 取消未触发的重连 timer,但不重置计数;
    // 外层手动调用 _clearRetryState(切换/删除/重置画布)才会重置。
    _cancelRetryTimer();
    const es = get()._eventSource;
    if (es) {
      es.close();
      set({ _eventSource: null });
    }
  },

  _handleEvent: (ev) => {
    const state = get();
    if (ev.canvas_id !== state.activeCanvasId) return;
    // 能收到事件说明连接已恢复:重置重连计数并清除断连标记
    _retryCount = 0;
    if (state.connectionLost) set({ connectionLost: false });

    if (ev.type === "node_added" && ev.node) {
      // 避免重复(SSE 与本地追加可能同时发生)
      if (!state.nodes.find((n) => n.id === ev.node!.id)) {
        set((s) => ({ nodes: [...s.nodes, toFlowNode(ev.node!)] }));
      }
    } else if (ev.type === "node_updated" && ev.node) {
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== ev.node!.id) return n;
          const updated = toFlowNode(ev.node!);
          // 用户正在拖动此节点(有未触发的回写 timer):
          // SSE 推来的位置可能是回写前的旧值,会"跳回去"。保留本地拖动位置,
          // 只更新其他字段(status/payload/title/width/height 等)。
          // 注:@xyflow/react v12 的 Node 类型只有 position(positionAbsolute
          // 已移到 InternalNode.internals 中),故只覆盖 position。
          if (_positionWritebackTimers.has(n.id)) {
            return {
              ...updated,
              position: n.position,
            };
          }
          return updated;
        }),
      }));
    } else if (ev.type === "node_deleted" && ev.node_id) {
      // O3.1:其他端删除的节点,清理本地可能残留的位置回写 timer
      _cancelPositionWriteback(ev.node_id);
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== ev.node_id),
        edges: s.edges.filter((e) => e.source !== ev.node_id && e.target !== ev.node_id),
      }));
    } else if (ev.type === "edge_added" && ev.edge) {
      if (!state.edges.find((e) => e.id === ev.edge!.id)) {
        set((s) => ({ edges: [...s.edges, toFlowEdge(ev.edge!)] }));
      }
    } else if (ev.type === "edge_deleted" && ev.edge_id) {
      set((s) => ({ edges: s.edges.filter((e) => e.id !== ev.edge_id) }));
    }
  },

  clearConnectionLost: () => {
    set({ connectionLost: false });
  },

  reset: () => {
    get()._unsubscribe();
    // 重置重连计数
    _clearRetryState();
    // 清理所有未触发的位置回写 timer,避免 reset 后误回写
    _clearAllPositionWritebackTimers();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("toiv_active_canvas");
    }
    set({
      activeCanvasId: null,
      activeCanvas: null,
      nodes: [],
      edges: [],
      loading: false,
      error: null,
      connectionLost: false,
    });
  },
}));

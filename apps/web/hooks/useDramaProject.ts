"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getDramaProject,
  patchDramaProject,
  storyboardDrama,
  createDramaCharacter,
  patchDramaCharacter,
  deleteDramaCharacter,
  generateDramaShotVideo,
  generateDramaShotVoice,
  generateDramaShotLipsync,
  continueDramaShotVideo,
  patchDramaShot,
  assembleDrama,
  dramaGenerateCharacterReference,
  dramaGridStoryboard,
  dramaListVideoGenerators,
  dramaGetSceneLayout,
  dramaUpdateSceneLayout,
  dramaGenerateVideoV2,
  pickDramaShotCandidate,
  deleteDramaShotCandidate,
  applyDramaAssetToProject,
  listDramaAssets,
  deleteDramaAsset,
  refineDramaScript,
} from "@/lib/api";
import { loadJSON, saveJSON } from "@/lib/storage";
import { usePoll } from "@/hooks/usePoll";
import type {
  DramaProjectDetail,
  DramaProjectSummary,
  DramaProjectPatch,
  DramaCharacterItem,
  DramaCharacterInput,
  DramaCharacterPatch,
  DramaShotItem,
  DramaShotCandidate,
  DramaAssembleResult,
  DramaProcessStep,
  DramaSceneLayout,
  DramaSceneLayoutActor,
  DramaSceneLayoutProp,
  VideoGeneratorInfo,
  GenerateVideoV2Body,
  DramaGridStoryboardResponse,
  DramaAsset,
  DramaAssetKind,
} from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { begin as genBegin, end as genEnd, progress as genProgress } from "@/lib/generationBus";

// 轮询节奏:每 3.5s 拉一次,15 分钟超时
const POLL_INTERVAL = 3500;
const POLL_MAX_ATTEMPTS = Math.floor((15 * 60 * 1000) / POLL_INTERVAL);

// 三视图生成任务的全局进度条 id(poll 与提交两处共用,防串号)
const refTaskIdOf = (cid: string) => `drama-reference-${cid}`;

/**
 * M3.1:任务日志条目(持久化到 localStorage,跨刷新恢复)。
 * status 流转:running → done(activeTasks diff 检测完成态)。
 * error 态当前不区分(各操作自带 error toast),P0 标记 done 即可。
 */
export interface TaskLogEntry {
  key: string;
  label: string;
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt?: number;
  detail?: string;
}

/**
 * P0-2:autorun 后台管线进度(从 process_data 最新一条 step=autorun 记录派生)。
 * running=true 时 useDramaProject 内部自动轮询项目详情驱动进度面板刷新。
 */
export interface DramaAutorunInfo {
  taskId: string;
  status: string; // pending / running / assembling / done / error
  running: boolean;
  done: number;
  total: number;
  current: string;
  error: string;
}

/** useDramaProject 返回值:封装项目详情的全部共享状态与操作,供各 Tab 组件消费。 */
export interface UseDramaProjectReturn {
  // 数据
  current: DramaProjectDetail | null;
  characters: DramaCharacterItem[];
  shots: DramaShotItem[];
  loading: boolean;
  error: string;
  processSteps: DramaProcessStep[];
  // P0-2:autorun 后台管线进度(null = 无 autorun 记录)
  autorun: DramaAutorunInfo | null;
  doneCount: number;
  gridImage: string;
  gridShots: DramaShotItem[];
  // 项目操作
  reload: (id?: string) => void;
  patchProject: (patch: DramaProjectPatch) => Promise<DramaProjectSummary>;
  // 剧本拆解
  storyboard: (numShots: number) => Promise<void>;
  storyboarding: boolean;
  // 宫格分镜 M2
  gridStoryboard: (numShots: 9 | 25) => Promise<void>;
  gridBusy: boolean;
  gridResult: DramaGridStoryboardResponse | null;
  gridError: string;
  showGridPicker: boolean;
  setShowGridPicker: React.Dispatch<React.SetStateAction<boolean>>;
  clearGridResult: () => void;
  // 角色 M1
  createCharacter: (body: DramaCharacterInput) => Promise<DramaCharacterItem>;
  patchCharacter: (
    cid: string,
    body: DramaCharacterPatch,
  ) => Promise<DramaCharacterItem>;
  deleteCharacter: (cid: string, name: string) => Promise<void>;
  generateReference: (cid: string, name: string) => Promise<void>;
  busyRef: string | null;
  // M2:从资产库应用角色到项目
  applyAsset: (aid: string, name: string) => Promise<void>;
  // 资产库:列表(可按 kind 过滤)/删除(应用走 applyAsset)
  assets: DramaAsset[] | null;
  assetsLoading: boolean;
  loadAssets: (kind?: DramaAssetKind) => Promise<void>;
  deleteAsset: (aid: string, name: string) => Promise<void>;
  // 导演台 L2 剧本润色(同步返回 original/refined,采纳与否由 UI 决定)
  refineScript: (
    text: string,
    instruction?: string,
  ) => Promise<{ original: string; refined: string }>;
  // 分镜
  saveShot: (
    shot: DramaShotItem,
    patch: {
      prompt: string;
      dialogue: string;
      scene: string;
      // LibTV 工作台追加(可选,缺省不提交):情绪标签/节拍注记/关联角色
      mood?: string;
      beat?: string;
      characters?: string[];
      // P1 衔接策略层(可选):接缝策略/衔接锚点
      seam_to_next?: string;
      seam_anchor?: string;
    },
  ) => Promise<void>;
  generateVideo: (shot: DramaShotItem) => void;
  generateVideoV2: (sid: string, body: GenerateVideoV2Body) => void;
  /** 末帧续写(抽当前视频末帧 i2v 逐段延续,轮询 shot.continue_* 字段) */
  continueVideo: (shot: DramaShotItem) => void;
  /** 单镜抽卡:对单个分镜生成 N 个候选视频(绕过单发守卫,与批量共用提交通道) */
  generateShotCandidates: (sid: string, numCandidates: number) => void;
  generateVoice: (shot: DramaShotItem) => void;
  generateLipsync: (sid: string) => Promise<void>;
  busyShot: string | null;
  busyVoice: string | null;
  busyLipsync: string | null;
  busyContinue: string | null;
  editingShot: string | null;
  setEditingShot: React.Dispatch<React.SetStateAction<string | null>>;
  // M1:单镜候选
  candidatesByShot: Record<string, DramaShotCandidate[]>;
  pickCandidate: (sid: string, cid: string) => Promise<void>;
  deleteCandidate: (sid: string, cid: string) => Promise<void>;
  // 导演台 M3
  directorOpen: string | null;
  directorLayout: DramaSceneLayout | null;
  directorBusy: boolean;
  directorLoading: boolean;
  toggleDirector: (shot: DramaShotItem) => void;
  saveDirector: (shot: DramaShotItem, generateReference: boolean) => void;
  directorLayoutChange: (next: DramaSceneLayout) => void;
  // M2.3:导演台 overlay(全屏聚焦模式)
  directorOverlayShot: DramaShotItem | null;
  openDirectorOverlay: (shot: DramaShotItem) => void;
  closeDirectorOverlay: () => void;
  // 模型 M6
  videoModel: string;
  videoGenerators: VideoGeneratorInfo[];
  videoModelLoading: boolean;
  setVideoModel: React.Dispatch<React.SetStateAction<string>>;
  // 合成
  assemble: () => Promise<void>;
  assembling: boolean;
  assembleResult: DramaAssembleResult | null;
  assembleError: string;
  clearAssembleResult: () => void;
  // 三视图 / 宫格大图预览
  refPreview: { url: string; label: string } | null;
  setRefPreview: React.Dispatch<
    React.SetStateAction<{ url: string; label: string } | null>
  >;
  // ── Agent 命令条(LibTV 双入口)──
  agentBusy: boolean;
  agentReply: string;
  agentExec: (cmd: string) => void;
  clearAgentReply: () => void;
  // ── 镜头选中(故事板 ↔ 检查器联动)──
  selectedShotId: string | null;
  setSelectedShotId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedShot: DramaShotItem | null;
  // ── 批量生成 ──
  generateAllShots: (numCandidates?: number) => void;
  // M2.1:批量配音(遍历有台词且未完成的分镜,逐个调 generateVoice)
  generateAllVoices: () => void;
  pendingCount: number;
  // ── 全局任务聚合 ──
  activeTaskCount: number;
  activeTaskLabel: string;
  activeTasks: { key: string; label: string; detail?: string }[];
  // M3.1:任务日志(持久化,含已完成记录)
  taskLog: TaskLogEntry[];
}

/**
 * 封装短剧项目详情的全部状态与操作。主组件持有返回值并下发给各 Tab 组件,
 * Tab 切换时状态不丢失。轮询定时器与防重入逻辑均在此 hook 内部管理。
 *
 * opts.nsfw:/nsfw 专区嵌入时置 true,视频生成/续写请求体自动带 nsfw:true
 * (后端门控 + Job 打标);缺省 false,主站请求体逐字节不变。
 */
export function useDramaProject(
  activeId: string | null,
  onSummaryChange?: (id: string, patch: Partial<DramaProjectSummary>) => void,
  opts?: { nsfw?: boolean },
): UseDramaProjectReturn {
  const nsfw = opts?.nsfw === true;
  const [current, setCurrent] = useState<DramaProjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  // 单镜忙碌(防重入)
  const [busyShot, setBusyShot] = useState<string | null>(null);
  const [busyVoice, setBusyVoice] = useState<string | null>(null);
  const [busyLipsync, setBusyLipsync] = useState<string | null>(null);
  const [busyContinue, setBusyContinue] = useState<string | null>(null);
  const [assembling, setAssembling] = useState(false);
  const [storyboarding, setStoryboarding] = useState(false);
  const [editingShot, setEditingShot] = useState<string | null>(null);
  const [assembleResult, setAssembleResult] =
    useState<DramaAssembleResult | null>(null);
  const [assembleError, setAssembleError] = useState<string>("");

  // M1:角色三视图生成(按角色 id 防重入)+ 大图预览
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [refPreview, setRefPreview] = useState<{
    url: string;
    label: string;
  } | null>(null);

  // M2:9/25 宫格分镜
  const [showGridPicker, setShowGridPicker] = useState(false);
  const [gridBusy, setGridBusy] = useState(false);
  const [gridResult, setGridResult] =
    useState<DramaGridStoryboardResponse | null>(null);
  const [gridError, setGridError] = useState<string>("");

  // M3:导演台(单镜 2D 场景布局编辑器)
  const [directorOpen, setDirectorOpen] = useState<string | null>(null);
  const [directorLayout, setDirectorLayout] =
    useState<DramaSceneLayout | null>(null);
  const [directorBusy, setDirectorBusy] = useState(false);
  const [directorLoading, setDirectorLoading] = useState(false);
  // M2.3:导演台 overlay 聚焦模式(全屏编辑,与 directorOpen 解耦)
  const [directorOverlayShot, setDirectorOverlayShot] =
    useState<DramaShotItem | null>(null);

  // M3.1:任务日志(持久化到 localStorage,按 projectId 隔离)
  const [taskLog, setTaskLog] = useState<TaskLogEntry[]>(() =>
    loadJSON<TaskLogEntry[]>(`toiv_drama_tasks_${activeId ?? "default"}`, []),
  );
  // taskLog 的 ref:供 activeTasks diff effect 读取最新值,避免依赖 taskLog 触发循环
  const taskLogRef = useRef<TaskLogEntry[]>(taskLog);
  useEffect(() => {
    taskLogRef.current = taskLog;
  }, [taskLog]);
  // 防止 StrictMode 双调用导致重复 toast 的签名守卫
  const lastTaskSigRef = useRef<string>("");

  // M6:模型聚合(默认 ltx,其他模型未接入时仅 UI 占位)
  const [videoModel, setVideoModel] = useState<string>("ltx");
  const [videoGenerators, setVideoGenerators] = useState<VideoGeneratorInfo[]>(
    [],
  );
  const [videoModelLoading, setVideoModelLoading] = useState(false);

  // LibTV:Agent 命令条 + 镜头选中(故事板 ↔ 检查器联动)
  const [agentReply, setAgentReply] = useState<string>("");
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);

  const { show: showToast } = useToast();

  // ── 定时器集中管理 ──
  const timersRef = useRef<Set<number>>(new Set());
  const safeSetTimeout = useCallback((fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((id) => clearTimeout(id));
      timersRef.current.clear();
    };
  }, []);

  // 当前项目 id 的 ref:轮询时校验是否已切换项目,避免回写覆盖
  const currentIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentIdRef.current = current?.id ?? null;
  }, [current]);

  // 切换/关闭项目时清理详情相关本地状态
  const resetDetailState = useCallback(() => {
    setBusyShot(null);
    setBusyVoice(null);
    setBusyLipsync(null);
    setBusyContinue(null);
    setAssembling(false);
    setStoryboarding(false);
    setEditingShot(null);
    setAssembleResult(null);
    setAssembleError("");
    setBusyRef(null);
    setRefPreview(null);
    setShowGridPicker(false);
    setGridResult(null);
    setGridError("");
    setDirectorOpen(null);
    setDirectorLayout(null);
    setDirectorBusy(false);
    setDirectorLoading(false);
    setSelectedShotId(null);
    setAgentReply("");
  }, []);

  // activeId 变化:项目关闭时清空详情;切换项目时重载 taskLog(按 projectId 隔离)
  useEffect(() => {
    if (activeId === null) {
      setCurrent(null);
      resetDetailState();
      setLoading(false);
      setError("");
      setTaskLog([]);
      lastTaskSigRef.current = "";
    } else {
      // M3.1:切换项目时从 localStorage 恢复该项目的任务日志
      setTaskLog(loadJSON<TaskLogEntry[]>(`toiv_drama_tasks_${activeId}`, []));
      lastTaskSigRef.current = "";
    }
  }, [activeId, resetDetailState]);

  // M3.1:taskLog 变化时持久化到 localStorage(按 projectId 隔离)
  useEffect(() => {
    if (activeId) {
      saveJSON(`toiv_drama_tasks_${activeId}`, taskLog);
    }
  }, [taskLog, activeId]);

  // M6:挂载时拉取可用视频生成模型列表(失败静默,保留 ltx 默认)
  useEffect(() => {
    setVideoModelLoading(true);
    dramaListVideoGenerators()
      .then((res) => {
        // QA-FULL-2026-08-11 P3:available/reason 由后端统一下发(与 /api/models/engines
        // 同源),前端不再叠加白名单,避免两处引擎状态显示不一致。
        const list = res.generators ?? [];
        setVideoGenerators(list);
        if (list.length > 0) {
          const hasLtx = list.some((g) => g.name === "ltx");
          setVideoModel((prev) => (hasLtx && prev === "ltx" ? "ltx" : prev));
        }
      })
      .catch(() => {
        // 静默失败:保留默认 ltx
      })
      .finally(() => setVideoModelLoading(false));
  }, []);

  // ── 加载项目详情(切换项目或手动刷新)──
  const reload = useCallback(
    (id?: string) => {
      const targetId = id ?? activeId;
      if (!targetId) return;
      setCurrent(null);
      resetDetailState();
      setLoading(true);
      setError("");
      getDramaProject(targetId)
        .then((d) => setCurrent(d))
        .catch((err) => {
          setError(err instanceof Error ? err.message : "加载项目详情失败");
          setCurrent(null);
        })
        .finally(() => setLoading(false));
    },
    [activeId, resetDetailState],
  );

  // ── activeId 切换为非空时自动加载详情 ──
  // 历史 bug:加载原由调用方触发,NsfwDramaView 点项目只 setActiveId,没人调
  // reload → current=null/loading=false/error="" → 工作区静默空白。故收进 hook。
  useEffect(() => {
    if (activeId) reload();
  }, [activeId, reload]);

  // ── 保存项目编辑 ──
  const patchProject = useCallback(
    (patch: DramaProjectPatch): Promise<DramaProjectSummary> => {
      const pid = currentIdRef.current;
      if (!pid) return Promise.reject(new Error("无当前项目"));
      return patchDramaProject(pid, patch)
        .then((updated) => {
          setCurrent((d) => (d ? { ...d, ...updated } : d));
          onSummaryChange?.(pid, updated);
          return updated;
        })
        .catch((err) => {
          throw err;
        });
    },
    [onSummaryChange],
  );

  // ── AI 拆分镜(会清旧分镜)──
  const storyboard = useCallback(
    (numShotsValue: number): Promise<void> => {
      const pid = currentIdRef.current;
      if (!pid) return Promise.resolve();
      setStoryboarding(true);
      return storyboardDrama(pid, {
        num_shots: numShotsValue > 0 ? numShotsValue : undefined,
        ...(current?.style ? { style: current.style } : {}),
      })
        .then((res) => {
          const shots = res.shots ?? [];
          setCurrent((d) =>
            d ? { ...d, shots, status: "storyboard" } : d,
          );
          onSummaryChange?.(pid, { status: "storyboard" });
          showToast("success", `已拆分 ${shots.length} 镜`);
        })
        .catch((err) => {
          showToast(
            "error",
            err instanceof Error ? err.message : "拆分镜失败",
          );
        })
        .finally(() => setStoryboarding(false));
    },
    [current, onSummaryChange, showToast],
  );

  // ── M2:9/25 宫格分镜 ──
  const gridStoryboard = useCallback(
    (numShotsValue: 9 | 25): Promise<void> => {
      const pid = currentIdRef.current;
      if (!pid) return Promise.resolve();
      if (gridBusy) {
        showToast("info", "宫格分镜生成中,请稍候");
        return Promise.resolve();
      }
      setShowGridPicker(false);
      setGridBusy(true);
      setGridError("");
      return dramaGridStoryboard(pid, {
        num_shots: numShotsValue,
        ...(current?.style ? { style: current.style } : {}),
      })
        .then((res) => {
          setGridResult(res);
          setCurrent((d) =>
            d
              ? {
                  ...d,
                  shots: res.shots ?? d.shots ?? [],
                  grid_image: res.grid_image ?? d.grid_image,
                  status: "storyboard",
                }
              : d,
          );
          onSummaryChange?.(pid, { status: "storyboard" });
          showToast("success", `已生成 ${numShotsValue} 宫格分镜`);
        })
        .catch((err) => {
          setGridError(err instanceof Error ? err.message : "宫格分镜失败");
        })
        .finally(() => setGridBusy(false));
    },
    [current, gridBusy, onSummaryChange, showToast],
  );

  const clearGridResult = useCallback(() => {
    setGridResult(null);
    setGridError("");
  }, []);

  // ── 角色:新增/编辑/删除 ──
  const createCharacter = useCallback(
    (body: DramaCharacterInput): Promise<DramaCharacterItem> => {
      const pid = currentIdRef.current;
      if (!pid) return Promise.reject(new Error("无当前项目"));
      return createDramaCharacter(pid, body)
        .then((c) => {
          setCurrent((d) => (d ? { ...d, characters: [...(d.characters ?? []), c] } : d));
          showToast("success", "角色已添加");
          return c;
        })
        .catch((err) => {
          throw err;
        });
    },
    [showToast],
  );

  const patchCharacter = useCallback(
    (cid: string, body: DramaCharacterPatch): Promise<DramaCharacterItem> => {
      return patchDramaCharacter(cid, body)
        .then((c) => {
          setCurrent((d) =>
            d
              ? {
                  ...d,
                  characters: (d.characters ?? []).map((x) => (x.id === c.id ? c : x)),
                }
              : d,
          );
          showToast("success", "角色已更新");
          return c;
        })
        .catch((err) => {
          throw err;
        });
    },
    [showToast],
  );

  const deleteCharacter = useCallback(
    (cid: string, name: string): Promise<void> => {
      return deleteDramaCharacter(cid)
        .then(() => {
          setCurrent((d) =>
            d
              ? { ...d, characters: (d.characters ?? []).filter((c) => c.id !== cid) }
              : d,
          );
          showToast("success", `角色「${name}」已删除`);
        })
        .catch((err) => {
          showToast(
            "error",
            err instanceof Error ? err.message : "删除角色失败",
          );
        });
    },
    [showToast],
  );

  // ── M1:生成角色三视图(正/侧/背,异步提交 + 轮询,同对口型模式)──
  const pollCharacterReference = useCallback(
    (pid: string, cid: string, name: string) => {
      const taskId = refTaskIdOf(cid);
      let attempts = 0;
      const clearBusy = () => {
        setBusyRef(null);
        genEnd(taskId);
      };
      const tick = () => {
        if (currentIdRef.current !== pid) {
          clearBusy();
          return;
        }
        attempts++;
        getDramaProject(pid)
          .then((d) => {
            if (currentIdRef.current !== pid) {
              clearBusy();
              return;
            }
            const ch = d.characters?.find((c) => c.id === cid);
            if (!ch) {
              clearBusy();
              showToast("error", `角色「${name}」已被删除,轮询终止`);
              return;
            }
            const st = (ch.reference_status || "").toLowerCase();
            setCurrent(d);
            onSummaryChange?.(pid, {
              status: d.status,
              updated_at: d.updated_at,
            });
            if (st === "done" || st === "ready" || st === "completed") {
              clearBusy();
              showToast("success", `角色「${name}」三视图已生成`);
              return;
            }
            if (st === "error" || st === "failed") {
              clearBusy();
              showToast(
                "error",
                `角色「${name}」三视图生成失败:${ch.reference_error || st}`,
              );
              return;
            }
            if (attempts >= POLL_MAX_ATTEMPTS) {
              clearBusy();
              showToast(
                "error",
                `角色「${name}」三视图生成超时(15 分钟),请稍后重试`,
              );
              return;
            }
            safeSetTimeout(tick, POLL_INTERVAL);
          })
          .catch(() => {
            clearBusy();
            showToast("error", "轮询项目状态失败,请刷新查看");
          });
      };
      safeSetTimeout(tick, POLL_INTERVAL);
    },
    [onSummaryChange, safeSetTimeout, showToast],
  );

  const generateReference = useCallback(
    (cid: string, name: string): Promise<void> => {
      const pid = currentIdRef.current;
      if (!pid) return Promise.resolve();
      if (busyRef) {
        showToast("info", "已有三视图任务进行中,请稍候");
        return Promise.resolve();
      }
      setBusyRef(cid);
      genBegin(refTaskIdOf(cid), `角色「${name}」三视图`);
      return dramaGenerateCharacterReference(cid)
        .then((updated) => {
          // 提交即返回(generating):先就地更新一次,再轮询等待回写
          setCurrent((d) =>
            d
              ? {
                  ...d,
                  characters: (d.characters ?? []).map((c) =>
                    c.id === cid ? updated : c,
                  ),
                }
              : d,
          );
          showToast("info", "三视图任务已提交,生成中…");
          pollCharacterReference(pid, cid, name);
        })
        .catch((err) => {
          setBusyRef(null);
          genEnd(refTaskIdOf(cid));
          showToast(
            "error",
            err instanceof Error ? err.message : "生成三视图失败",
          );
        });
    },
    [busyRef, pollCharacterReference, showToast],
  );

  // ── M2:从资产库应用角色到当前项目 ──
  const applyAsset = useCallback(
    (aid: string, name: string): Promise<void> => {
      const pid = currentIdRef.current;
      if (!pid) return Promise.resolve();
      return applyDramaAssetToProject(aid, pid)
        .then((c) => {
          setCurrent((d) =>
            d ? { ...d, characters: [...(d.characters ?? []), c] } : d,
          );
          showToast("success", `资产「${name}」已应用到项目`);
        })
        .catch((err) => {
          showToast(
            "error",
            err instanceof Error ? err.message : "应用资产失败",
          );
        });
    },
    [showToast],
  );

  // ── 资产库:列表/删除(面板打开时按需加载,不做常驻轮询)──
  const [assets, setAssets] = useState<DramaAsset[] | null>(null);
  const [assetsLoading, setAssetsLoading] = useState(false);

  const loadAssets = useCallback(
    async (kind?: DramaAssetKind): Promise<void> => {
      setAssetsLoading(true);
      try {
        const res = await listDramaAssets(kind);
        setAssets(res.assets ?? []);
      } catch (err) {
        setAssets(null);
        showToast("error", err instanceof Error ? err.message : "加载资产库失败");
      } finally {
        setAssetsLoading(false);
      }
    },
    [showToast],
  );

  const deleteAsset = useCallback(
    async (aid: string, name: string): Promise<void> => {
      try {
        await deleteDramaAsset(aid);
        setAssets((prev) => (prev ? prev.filter((a) => a.id !== aid) : prev));
        showToast("success", `资产「${name}」已删除`);
      } catch (err) {
        showToast("error", err instanceof Error ? err.message : "删除资产失败");
      }
    },
    [showToast],
  );

  // ── 导演台 L2:剧本润色(同步;UI 拿到 refined 后自行决定采纳/放弃)──
  const refineScript = useCallback(
    (
      text: string,
      instruction?: string,
    ): Promise<{ original: string; refined: string }> => {
      const pid = currentIdRef.current;
      if (!pid) return Promise.reject(new Error("无当前项目"));
      return refineDramaScript(pid, text, instruction).then((r) => ({
        original: r.original,
        refined: r.refined,
      }));
    },
    [],
  );

  // ── 保存分镜编辑(patchDramaShot)──
  const saveShot = useCallback(
    (
      shot: DramaShotItem,
      patch: {
        prompt: string;
        dialogue: string;
        scene: string;
        mood?: string;
        beat?: string;
        characters?: string[];
        seam_to_next?: string;
        seam_anchor?: string;
      },
    ): Promise<void> => {
      return patchDramaShot(shot.id, {
        prompt: patch.prompt,
        dialogue: patch.dialogue,
        scene: patch.scene,
        ...(patch.mood !== undefined ? { mood: patch.mood } : {}),
        ...(patch.beat !== undefined ? { beat: patch.beat } : {}),
        ...(patch.characters !== undefined
          ? { characters: patch.characters }
          : {}),
        ...(patch.seam_to_next !== undefined
          ? { seam_to_next: patch.seam_to_next }
          : {}),
        ...(patch.seam_anchor !== undefined
          ? { seam_anchor: patch.seam_anchor }
          : {}),
      })
        .then((updated) => {
          setCurrent((d) =>
            d
              ? {
                  ...d,
                  shots: (d.shots ?? []).map((s) => (s.id === shot.id ? updated : s)),
                }
              : d,
          );
          setEditingShot(null);
          showToast("success", `分镜 #${shot.idx} 已保存`);
        })
        .catch((err) => {
          showToast(
            "error",
            err instanceof Error ? err.message : "保存分镜失败",
          );
        });
    },
    [showToast],
  );

  // ── 单镜视频生成轮询:直到该镜 video_status 变为 done/error 或超时 ──
  const pollShotVideo = useCallback(
    (pid: string, shotId: string, shotIdx: number) => {
      const taskId = `drama-shot-${shotId}`;
      let attempts = 0;
      // 全局进度条收尾:任一语义终态(切项目/镜头删除/done/error/超时/轮询失败)统一清除
      const clearBusy = () => {
        setBusyShot(null);
        genEnd(taskId);
      };
      const tick = () => {
        if (currentIdRef.current !== pid) {
          clearBusy();
          return;
        }
        attempts++;
        getDramaProject(pid)
          .then((d) => {
            if (currentIdRef.current !== pid) {
              clearBusy();
              return;
            }
            const shot = d.shots?.find((s) => s.id === shotId);
            if (!shot) {
              clearBusy();
              showToast("error", `分镜 #${shotIdx} 已被删除,轮询终止`);
              return;
            }
            const st = (shot.video_status || "").toLowerCase();
            setCurrent(d);
            onSummaryChange?.(pid, {
              status: d.status,
              updated_at: d.updated_at,
            });
            if (st === "done" || st === "ready" || st === "completed") {
              clearBusy();
              showToast("success", `分镜 #${shotIdx} 视频已生成`);
              return;
            }
            if (st === "error" || st === "failed") {
              clearBusy();
              showToast(
                "error",
                `分镜 #${shotIdx} 视频生成失败:${shot.error || st}`,
              );
              return;
            }
            if (attempts >= POLL_MAX_ATTEMPTS) {
              clearBusy();
              showToast(
                "error",
                `分镜 #${shotIdx} 视频生成超时(15 分钟),请稍后重试`,
              );
              return;
            }
            safeSetTimeout(tick, POLL_INTERVAL);
          })
          .catch(() => {
            clearBusy();
            showToast("error", "轮询项目状态失败,请刷新查看");
          });
      };
      safeSetTimeout(tick, POLL_INTERVAL);
    },
    [onSummaryChange, safeSetTimeout, showToast],
  );

  // ── 提交单镜视频生成任务(不含 busyShot 守卫,供单发/批量共用)──
  const submitShotVideoJob = useCallback(
    (shot: DramaShotItem, onError?: () => void) => {
      const pid = currentIdRef.current;
      if (!pid) return;
      // 全局进度条:提交即登记(轮询接管至终态清除)
      genBegin(`drama-shot-${shot.id}`, `分镜 #${shot.idx} 视频生成`);
      generateDramaShotVideo(shot.id, {
        steps: 20,
        cfg: 1.0,
        ...(nsfw ? { nsfw: true } : {}),
      })
        .then(() => {
          showToast("info", `分镜 #${shot.idx} 视频任务已提交,轮询中…`);
          pollShotVideo(pid, shot.id, shot.idx);
        })
        .catch((err) => {
          genEnd(`drama-shot-${shot.id}`);
          onError?.();
          showToast(
            "error",
            err instanceof Error ? err.message : "提交视频生成失败",
          );
        });
    },
    [pollShotVideo, showToast, nsfw],
  );

  // ── 提交单镜视频生成(generateDramaShotVideo 异步 + 轮询)──
  const generateVideo = useCallback(
    (shot: DramaShotItem) => {
      if (busyShot) {
        showToast("info", "已有分镜任务进行中,请稍候");
        return;
      }
      if (!currentIdRef.current) return;
      setBusyShot(shot.id);
      submitShotVideoJob(shot, () => setBusyShot(null));
    },
    [busyShot, submitShotVideoJob, showToast],
  );

  // ── M6:单镜视频生成 v2(支持模型选择,异步 + 轮询)──
  const submitShotVideoV2 = useCallback(
    (sid: string, body: GenerateVideoV2Body) => {
      const pid = currentIdRef.current;
      if (!pid) return;
      const shot = current?.shots?.find((s) => s.id === sid);
      const shotIdx = shot?.idx ?? 0;
      const numCandidates = body.num_candidates ?? 1;
      setBusyShot(sid);
      // 全局进度条:逐镜登记(批量生成时胶囊自然聚合成「N 项生成中」)
      genBegin(`drama-shot-${sid}`, `分镜 #${shotIdx} 视频生成`);
      dramaGenerateVideoV2(sid, { ...body, ...(nsfw ? { nsfw: true } : {}) })
        .then(() => {
          const message =
            numCandidates > 1
              ? `已提交 ${numCandidates} 个候选视频任务,轮询中…`
              : `分镜 #${shotIdx} 视频任务已提交,轮询中…`;
          showToast("info", message);
          pollShotVideo(pid, sid, shotIdx);
        })
        .catch((err) => {
          setBusyShot(null);
          genEnd(`drama-shot-${sid}`);
          showToast(
            "error",
            err instanceof Error ? err.message : "提交视频生成失败",
          );
        });
    },
    [current, pollShotVideo, showToast, nsfw],
  );

  const generateVideoV2 = useCallback(
    (sid: string, body: GenerateVideoV2Body) => {
      if (busyShot) {
        showToast("info", "已有分镜任务进行中,请稍候");
        return;
      }
      submitShotVideoV2(sid, body);
    },
    [busyShot, submitShotVideoV2, showToast],
  );

  // ── 单镜抽卡:对单个分镜生成 N 个候选,直接走提交通道(与批量一致,各自独立轮询)──
  const generateShotCandidates = useCallback(
    (sid: string, numCandidates: number) => {
      const n = Math.max(1, Math.min(4, numCandidates));
      submitShotVideoV2(sid, {
        model: videoModel,
        steps: 20,
        cfg: 1.0,
        ...(n > 1 ? { num_candidates: n } : {}),
      });
    },
    [submitShotVideoV2, videoModel],
  );

  // ── 末帧续写:轮询直到 shot.continue_status 变为 done/error 或超时 ──
  const pollShotContinue = useCallback(
    (pid: string, shotId: string, shotIdx: number) => {
      const taskId = `drama-continue-${shotId}`;
      let attempts = 0;
      // 全局进度条收尾:任一语义终态(切项目/镜头删除/done/error/超时/轮询失败)统一清除
      const clearBusy = () => {
        setBusyContinue(null);
        genEnd(taskId);
      };
      const tick = () => {
        if (currentIdRef.current !== pid) {
          clearBusy();
          return;
        }
        attempts++;
        getDramaProject(pid)
          .then((d) => {
            if (currentIdRef.current !== pid) {
              clearBusy();
              return;
            }
            const shot = d.shots?.find((s) => s.id === shotId);
            if (!shot) {
              clearBusy();
              showToast("error", `分镜 #${shotIdx} 已被删除,轮询终止`);
              return;
            }
            const st = (shot.continue_status || "").toLowerCase();
            setCurrent(d);
            if (st === "done" || st === "ready" || st === "completed") {
              clearBusy();
              showToast("success", `分镜 #${shotIdx} 续写已完成`);
              return;
            }
            if (st === "error" || st === "failed") {
              clearBusy();
              showToast(
                "error",
                `分镜 #${shotIdx} 续写失败:${shot.continue_error || st}`,
              );
              return;
            }
            if (attempts >= POLL_MAX_ATTEMPTS) {
              clearBusy();
              showToast(
                "error",
                `分镜 #${shotIdx} 续写超时(15 分钟),请稍后重试`,
              );
              return;
            }
            safeSetTimeout(tick, POLL_INTERVAL);
          })
          .catch(() => {
            clearBusy();
            showToast("error", "轮询项目状态失败,请刷新查看");
          });
      };
      safeSetTimeout(tick, POLL_INTERVAL);
    },
    [safeSetTimeout, showToast],
  );

  // ── 提交末帧续写(默认 1 段 + auto_concat 拼成完整视频,异步 + 轮询)──
  const continueVideo = useCallback(
    (shot: DramaShotItem) => {
      const pid = currentIdRef.current;
      if (!pid) return;
      if (busyContinue) {
        showToast("info", "已有续写任务进行中,请稍候");
        return;
      }
      if (!shot.video_url) {
        showToast("error", `分镜 #${shot.idx} 尚未生成视频,无法续写`);
        return;
      }
      setBusyContinue(shot.id);
      genBegin(`drama-continue-${shot.id}`, `分镜 #${shot.idx} 末帧续写`);
      continueDramaShotVideo(shot.id, {
        segments: 1,
        auto_concat: true,
        ...(nsfw ? { nsfw: true } : {}),
      })
        .then(() => {
          showToast("info", `分镜 #${shot.idx} 续写任务已提交,轮询中…`);
          pollShotContinue(pid, shot.id, shot.idx);
        })
        .catch((err) => {
          setBusyContinue(null);
          genEnd(`drama-continue-${shot.id}`);
          showToast(
            "error",
            err instanceof Error ? err.message : "提交续写任务失败",
          );
        });
    },
    [busyContinue, nsfw, pollShotContinue, showToast],
  );

  // ── M1:单镜候选管理 ──
  const candidatesByShot = useMemo(() => {
    return (
      (current?.shots ?? []).reduce((acc, shot) => {
        if (shot.candidates && shot.candidates.length > 0) {
          acc[shot.id] = shot.candidates;
        }
        return acc;
      }, {} as Record<string, DramaShotCandidate[]>) ?? {}
    );
  }, [current?.shots]);

  const pickCandidate = useCallback(
    async (sid: string, cid: string): Promise<void> => {
      try {
        const updatedShot = await pickDramaShotCandidate(sid, cid);
        setCurrent((prev) =>
          prev
            ? {
                ...prev,
                shots: (prev.shots ?? []).map((s) =>
                  s.id === sid ? updatedShot : s,
                ),
              }
            : prev,
        );
        showToast("success", "已选择该候选视频");
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "选择候选视频失败",
        );
      }
    },
    [showToast],
  );

  const deleteCandidate = useCallback(
    async (sid: string, cid: string): Promise<void> => {
      try {
        await deleteDramaShotCandidate(sid, cid);
        setCurrent((prev) =>
          prev
            ? {
                ...prev,
                shots: (prev.shots ?? []).map((s) =>
                  s.id === sid
                    ? {
                        ...s,
                        candidates: s.candidates?.filter((c) => c.id !== cid),
                      }
                    : s,
                ),
              }
            : prev,
        );
        showToast("success", "已删除候选视频");
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "删除候选视频失败",
        );
      }
    },
    [showToast],
  );

  // ── 单镜配音(同步返回 wav)──
  const generateVoice = useCallback(
    (shot: DramaShotItem) => {
      if (busyVoice) {
        showToast("info", "已有配音任务进行中,请稍候");
        return;
      }
      setBusyVoice(shot.id);
      genBegin(`drama-voice-${shot.id}`, `分镜 #${shot.idx} 配音`);
      generateDramaShotVoice(shot.id, {})
        .then((res) => {
          setCurrent((d) =>
            d
              ? {
                  ...d,
                  shots: (d.shots ?? []).map((s) =>
                    s.id === shot.id
                      ? {
                          ...s,
                          voice_url: res.url,
                          voice_status: "done",
                        }
                      : s,
                  ),
                }
              : d,
          );
          showToast(
            "success",
            `分镜 #${shot.idx} 配音已合成(${res.duration_sec.toFixed(1)}s)`,
          );
        })
        .catch((err) =>
          showToast("error", err instanceof Error ? err.message : "配音失败"),
        )
        .finally(() => {
          setBusyVoice(null);
          genEnd(`drama-voice-${shot.id}`);
        });
    },
    [busyVoice, showToast],
  );

  // ── M3:单镜对口型(异步 + 轮询)──
  const pollShotLipsync = useCallback(
    (pid: string, shotId: string, shotIdx: number) => {
      const taskId = `drama-lipsync-${shotId}`;
      let attempts = 0;
      // 全局进度条收尾:任一语义终态(切项目/镜头删除/done/error/超时/轮询失败)统一清除
      const clearBusy = () => {
        setBusyLipsync(null);
        genEnd(taskId);
      };
      const tick = () => {
        if (currentIdRef.current !== pid) {
          clearBusy();
          return;
        }
        attempts++;
        getDramaProject(pid)
          .then((d) => {
            if (currentIdRef.current !== pid) {
              clearBusy();
              return;
            }
            const shot = d.shots?.find((s) => s.id === shotId);
            if (!shot) {
              clearBusy();
              showToast("error", `分镜 #${shotIdx} 已被删除,轮询终止`);
              return;
            }
            const st = (shot.lipsync_status || "").toLowerCase();
            setCurrent(d);
            onSummaryChange?.(pid, {
              status: d.status,
              updated_at: d.updated_at,
            });
            if (st === "done" || st === "ready" || st === "completed") {
              clearBusy();
              showToast("success", `分镜 #${shotIdx} 对口型已完成`);
              return;
            }
            if (st === "error" || st === "failed") {
              clearBusy();
              showToast(
                "error",
                `分镜 #${shotIdx} 对口型失败:${shot.error || st}`,
              );
              return;
            }
            if (attempts >= POLL_MAX_ATTEMPTS) {
              clearBusy();
              showToast(
                "error",
                `分镜 #${shotIdx} 对口型超时(15 分钟),请稍后重试`,
              );
              return;
            }
            safeSetTimeout(tick, POLL_INTERVAL);
          })
          .catch(() => {
            clearBusy();
            showToast("error", "轮询项目状态失败,请刷新查看");
          });
      };
      safeSetTimeout(tick, POLL_INTERVAL);
    },
    [onSummaryChange, safeSetTimeout, showToast],
  );

  const generateLipsync = useCallback(
    (sid: string): Promise<void> => {
      const pid = currentIdRef.current;
      if (!pid) return Promise.resolve();
      if (busyLipsync) {
        showToast("info", "已有对口型任务进行中,请稍候");
        return Promise.resolve();
      }
      const shot = current?.shots?.find((s) => s.id === sid);
      const shotIdx = shot?.idx ?? 0;
      setBusyLipsync(sid);
      genBegin(`drama-lipsync-${sid}`, `分镜 #${shotIdx} 对口型`);
      return generateDramaShotLipsync(sid, {})
        .then(() => {
          showToast("info", "对口型任务已提交");
          pollShotLipsync(pid, sid, shotIdx);
        })
        .catch((err) => {
          setBusyLipsync(null);
          genEnd(`drama-lipsync-${sid}`);
          showToast(
            "error",
            err instanceof Error ? err.message : "提交对口型任务失败",
          );
        });
    },
    [busyLipsync, current, pollShotLipsync, showToast],
  );

  // ── M3:导演台 - 切换展开/收起 + 拉取已存布局 ──
  const toggleDirector = useCallback(
    (shot: DramaShotItem) => {
      if (directorOpen === shot.id) {
        setDirectorOpen(null);
        setDirectorLayout(null);
        return;
      }
      setDirectorOpen(shot.id);
      setDirectorLayout({
        actors: [],
        props: [],
        camera: { angle: 0, distance: 50 },
        notes: "",
      });
      setDirectorLoading(true);
      dramaGetSceneLayout(shot.id)
        .then((res) => {
          if (res.scene_layout) {
            setDirectorLayout(res.scene_layout);
          }
        })
        .catch(() => {
          // 静默失败:保留上面初始化的空布局
        })
        .finally(() => setDirectorLoading(false));
    },
    [directorOpen],
  );

  const directorLayoutChange = useCallback((next: DramaSceneLayout) => {
    setDirectorLayout(next);
  }, []);

  const saveDirector = useCallback(
    (shot: DramaShotItem, generateReferenceFlag: boolean) => {
      if (!directorLayout) return;
      if (directorBusy) {
        showToast("info", "导演台任务进行中,请稍候");
        return;
      }
      setDirectorBusy(true);
      dramaUpdateSceneLayout(shot.id, {
        layout: directorLayout,
        generate_reference: generateReferenceFlag,
      })
        .then((updated) => {
          setCurrent((d) =>
            d
              ? {
                  ...d,
                  shots: (d.shots ?? []).map((s) => (s.id === shot.id ? updated : s)),
                }
              : d,
          );
          showToast(
            "success",
            generateReferenceFlag
              ? `分镜 #${shot.idx} 布局已保存并生成参考图`
              : `分镜 #${shot.idx} 布局已保存`,
          );
        })
        .catch((err) =>
          showToast(
            "error",
            err instanceof Error ? err.message : "保存导演台布局失败",
          ),
        )
        .finally(() => setDirectorBusy(false));
    },
    [directorBusy, directorLayout, showToast],
  );

  // M2.3:导演台 overlay —— 打开全屏聚焦编辑,复用 toggleDirector 的布局加载逻辑
  const openDirectorOverlay = useCallback(
    (shot: DramaShotItem) => {
      setDirectorOverlayShot(shot);
      // 若该分镜的导演台尚未打开,触发布局初始化+拉取(避免重复 toggle 导致关闭)
      if (directorOpen !== shot.id) {
        toggleDirector(shot);
      }
    },
    [directorOpen, toggleDirector],
  );

  // M2.3:关闭 overlay,一并清理 directorOpen/directorLayout
  const closeDirectorOverlay = useCallback(() => {
    setDirectorOverlayShot(null);
    if (directorOpen) {
      setDirectorOpen(null);
      setDirectorLayout(null);
    }
  }, [directorOpen]);

  // ── 一键合成(assembleDrama)──
  const assemble = useCallback((): Promise<void> => {
    const pid = currentIdRef.current;
    if (!pid || !current) return Promise.resolve();
    const doneShots = (current.shots ?? []).filter(
      (s) => (s.video_status || "").toLowerCase() === "done",
    );
    if (doneShots.length === 0) {
      setAssembleError("暂无可合成的分镜视频(需至少 1 个视频状态为 done)");
      return Promise.resolve();
    }
    setAssembling(true);
    setAssembleError("");
    setAssembleResult(null);
    // M3:合成片段优先使用 lipsync_video_url,否则回退 video_url
    const clips = doneShots.map((s) => s.lipsync_video_url || s.video_url);
    const options = {
      transition: "none",
      aspect: "auto", // 随项目宽高(2026-08-15 起后端 auto 继承项目分辨率;写死 16:9 会把 1344×768 压成 720p)
      fps: current.fps ?? 0, // 0=继承项目 fps(后端缺省 16)
      title: current.title,
      sub_box: true,
      voice_volume: 1.0,
      bgm_volume: 0.35,
      duck: true,
      clips,
    };
    genBegin(`drama-assemble-${pid}`, "合成成片");
    return assembleDrama(pid, options)
      .then((res) => {
        setAssembleResult(res);
        onSummaryChange?.(pid, { video_url: res.url, status: "ready" });
        showToast("success", `成片已合成:${res.name}`);
      })
      .catch((err) =>
        setAssembleError(err instanceof Error ? err.message : "合成成片失败"),
      )
      .finally(() => {
        setAssembling(false);
        genEnd(`drama-assemble-${pid}`);
      });
  }, [current, onSummaryChange, showToast]);

  const clearAssembleResult = useCallback(() => setAssembleResult(null), []);

  // ── P0-2:autorun 后台管线进度轮询 ──
  // from-image / 项目内自动管线进度写在 process_data(step=autorun);检测到进行中
  // 即用 usePoll 轮询项目详情,驱动 processSteps / 分镜状态实时刷新,终态自动停。
  const autorun = useMemo<DramaAutorunInfo | null>(() => {
    const steps = current?.process_data;
    if (!steps) return null;
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.step !== "autorun") continue;
      const st = (s.status ?? "").toLowerCase();
      return {
        taskId: s.task_id ?? "",
        status: st,
        running: st === "pending" || st === "running" || st === "assembling",
        done: s.done ?? 0,
        total: s.total ?? 0,
        current: s.current ?? "",
        error: s.error ?? "",
      };
    }
    return null;
  }, [current?.process_data]);

  // 后端建议轮询间隔(详情响应 poll_interval_sec),未返回时默认 5s
  const [autorunPollMs, setAutorunPollMs] = useState(5000);
  // 终态通知去重:按 task_id:status 记录,同一任务只 toast 一次
  const autorunNotifiedRef = useRef<string>("");

  const pollAutorun = useCallback(async () => {
    const pid = currentIdRef.current;
    if (!pid) return;
    const d = await getDramaProject(pid);
    if (currentIdRef.current !== pid) return; // 轮询途中已切换项目,丢弃结果
    setCurrent(d);
    if (typeof d.poll_interval_sec === "number" && d.poll_interval_sec > 0) {
      setAutorunPollMs(Math.max(1000, Math.round(d.poll_interval_sec * 1000)));
    }
    // 到达终态:同步项目列表摘要 + toast 通知(轮询随即因 enabled=false 自停)
    const last = [...(d.process_data ?? [])]
      .reverse()
      .find((s) => s.step === "autorun");
    const st = (last?.status ?? "").toLowerCase();
    if (last && (st === "done" || st === "error")) {
      const sig = `${last.task_id ?? ""}:${st}`;
      if (autorunNotifiedRef.current !== sig) {
        autorunNotifiedRef.current = sig;
        if (st === "done") {
          onSummaryChange?.(pid, {
            status: d.status,
            video_url: d.video_url,
          });
          showToast("success", "自动管线已完成,成片已合成");
        } else {
          showToast("error", `自动管线失败:${last.error || "未知错误"}`);
        }
      }
    }
  }, [onSummaryChange, showToast]);

  usePoll(pollAutorun, {
    intervalMs: autorunPollMs,
    enabled: autorun?.running === true,
    backoff: true,
  });

  // ── 全局进度条:autorun 后台管线接入(THEME-INPUT-PROGRESS 二期遗留) ──
  // running 期 begin + 按 done/total 报真实进度(label 带当前步骤,begin 幂等仅更新);
  // 终态(done/error)收口 end;切换项目/卸载由下方 cleanup 收口。两 effect 均对
  // 未 begin 的 id no-op,重复轮询触发重跑开销可忽略(begin/progress 同值不 emit)。
  const autorunPid = current?.id ?? null;
  useEffect(() => {
    if (!autorunPid || !autorun) return;
    const id = `drama-autorun-${autorunPid}`;
    if (!autorun.running) {
      genEnd(id);
      return;
    }
    genBegin(
      id,
      autorun.current ? `自动管线 · ${autorun.current}` : "自动管线",
      { determinate: autorun.total > 0 },
    );
    if (autorun.total > 0) genProgress(id, (autorun.done / autorun.total) * 100);
  }, [autorunPid, autorun]);

  useEffect(() => {
    if (!autorunPid) return;
    const id = `drama-autorun-${autorunPid}`;
    return () => genEnd(id);
  }, [autorunPid]);

  // ── 派生值 ──
  const characters = current?.characters ?? [];
  const shots = current?.shots ?? [];
  const doneCount = useMemo(
    () =>
      shots.filter((s) => (s.video_status || "").toLowerCase() === "done")
        .length,
    [shots],
  );
  const gridImage = gridResult?.grid_image || current?.grid_image || "";
  const gridShots = gridResult?.shots ?? [];
  const processSteps: DramaProcessStep[] = current?.process_data ?? [];

  // ── LibTV:镜头选中(故事板 ↔ 检查器联动)──
  const selectedShot = useMemo(
    () => shots.find((s) => s.id === selectedShotId) ?? null,
    [shots, selectedShotId],
  );

  // ── LibTV:待生成镜头数(video_status 非 done 即待生成)──
  const pendingCount = useMemo(
    () => shots.filter((s) => s.video_status !== "done").length,
    [shots],
  );

  // ── 全局任务聚合:统计当前正在进行的长任务数,用于顶栏指示器 ──
  // 注意:agentBusy 本身是聚合状态,不重复计数(其包含的子状态已单独统计)
  const { activeTaskCount, activeTaskLabel, activeTasks } = useMemo(() => {
    const tasks: { key: string; label: string; detail?: string }[] = [];
    if (storyboarding) tasks.push({ key: "sb", label: "拆分镜" });
    if (gridBusy) tasks.push({ key: "grid", label: "宫格分镜" });
    if (busyShot) tasks.push({ key: "shot", label: "视频生成", detail: busyShot });
    if (busyContinue) tasks.push({ key: "continue", label: "末帧续写", detail: busyContinue });
    if (busyVoice) tasks.push({ key: "voice", label: "配音", detail: busyVoice });
    if (busyLipsync) tasks.push({ key: "lipsync", label: "对口型", detail: busyLipsync });
    if (directorBusy) tasks.push({ key: "director", label: "导演台" });
    if (assembling) tasks.push({ key: "asm", label: "合成" });
    if (busyRef) tasks.push({ key: "ref", label: "参考图" });
    return {
      activeTaskCount: tasks.length,
      activeTaskLabel: tasks.length > 0 ? tasks.map((t) => t.label).join(" · ") : "",
      activeTasks: tasks,
    };
  }, [storyboarding, gridBusy, busyShot, busyContinue, busyVoice, directorBusy, assembling, busyRef]);

  // M3.1:activeTasks 变化时同步 taskLog —— 新增 running 项,完成的标记 done + toast 通知。
  // 用 ref 读取最新 taskLog 避免依赖 taskLog 触发循环;签名守卫防止 StrictMode 双调用重复 toast。
  useEffect(() => {
    if (!activeId) return;
    const sig = activeTasks.map((t) => t.key).join(",");
    if (sig === lastTaskSigRef.current) return;
    lastTaskSigRef.current = sig;

    const prev = taskLogRef.current;
    const runningKeys = new Set(activeTasks.map((t) => t.key));
    const next: TaskLogEntry[] = [...prev];
    const justCompleted: TaskLogEntry[] = [];

    // 1. 之前 running 现已不在 activeTasks 的 → 标记 done
    for (const e of next) {
      if (e.status === "running" && !runningKeys.has(e.key)) {
        e.status = "done";
        e.endedAt = Date.now();
        justCompleted.push(e);
      }
    }
    // 2. activeTasks 中尚未在 taskLog running 的 → 新增 running 项
    for (const t of activeTasks) {
      if (!next.find((e) => e.key === t.key && e.status === "running")) {
        next.unshift({
          key: t.key,
          label: t.label,
          status: "running",
          startedAt: Date.now(),
          detail: t.detail,
        });
      }
    }
    // 3. 限长:保留最近 50 条
    const trimmed = next.slice(0, 50);

    if (justCompleted.length > 0 || trimmed.length !== prev.length) {
      setTaskLog(trimmed);
      justCompleted.forEach((e) =>
        showToast("success", `${e.label} 已完成`),
      );
    }
  }, [activeTasks, activeId, showToast]);

  // ── LibTV:批量生成所有待生成分镜(绕过 busyShot 单发守卫,各自独立轮询)──
  const generateAllShots = useCallback(
    (numCandidates?: number) => {
      const targets = shots.filter((s) => {
        const st = (s.video_status || "").toLowerCase();
        return st !== "done" && st !== "generating";
      });
      if (targets.length === 0) {
        showToast("info", "全部镜头已就绪");
        return;
      }
      const body: GenerateVideoV2Body = {
        model: videoModel,
        steps: 20,
        cfg: 1.0,
        ...(numCandidates && numCandidates > 1
          ? { num_candidates: numCandidates }
          : {}),
      };
      targets.forEach((s) => submitShotVideoV2(s.id, body));
      // M3.2:批量生成 ETA(每镜约 1-2 分钟,取 1.5 均值;多候选按候选数倍增)
      const candidateFactor = numCandidates && numCandidates > 1 ? numCandidates : 1;
      const etaMin = Math.max(1, Math.ceil(targets.length * 1.5 * candidateFactor));
      const candidateHint =
        candidateFactor > 1 ? `(${candidateFactor} 候选/镜) ` : "";
      showToast(
        "info",
        `已提交 ${targets.length} 个分镜生成 ${candidateHint}预计 ${etaMin} 分钟`,
      );
    },
    [shots, submitShotVideoV2, videoModel, showToast],
  );

  // M2.1:批量配音 —— 遍历有台词且未完成的分镜,逐个调 generateVoice(自带防重入)
  const generateAllVoices = useCallback(() => {
    const targets = shots.filter(
      (s) =>
        (s.dialogue || "").trim().length > 0 &&
        (s.voice_status || "").toLowerCase() !== "done",
    );
    if (targets.length === 0) {
      showToast("info", "暂无需要配音的分镜");
      return;
    }
    targets.forEach((s) => generateVoice(s));
    // M3.2:批量配音 ETA(每个约 10 秒)
    const etaSec = targets.length * 10;
    showToast(
      "info",
      `已提交 ${targets.length} 个分镜配音,预计 ${etaSec} 秒`,
    );
  }, [shots, generateVoice, showToast]);

  // ── LibTV:Agent 命令条忙碌态(拆分镜/宫格/批量生成/合成进行中任一)──
  const agentBusy = useMemo(
    () => storyboarding || gridBusy || assembling || busyShot !== null,
    [storyboarding, gridBusy, assembling, busyShot],
  );

  const clearAgentReply = useCallback(() => setAgentReply(""), []);

  // ── LibTV:Agent 命令条(自然语言命令解析,fire-and-forget)──
  const agentExec = useCallback(
    (cmd: string) => {
      const text = cmd.trim();
      if (!text) return;
      // 1) 拆分镜
      if (/拆|分镜.*镜|拆解/.test(text)) {
        if (storyboarding) {
          setAgentReply("正在拆解,请稍候");
        } else {
          setAgentReply("收到,开始拆解剧本为 6 个分镜…");
          void storyboard(6);
        }
        return;
      }
      // 2) 批量生成全部分镜视频
      if (/全部|所有.*视频|全部分镜/.test(text)) {
        setAgentReply("已提交全部分镜生成,进度见各镜头卡片。");
        generateAllShots();
        return;
      }
      // 3) 镜头 N(可选运镜修改)
      const shotMatch = text.match(/镜头\s*(\d+)/);
      if (shotMatch) {
        const n = parseInt(shotMatch[1], 10);
        const shot = shots[n - 1];
        if (!shot) {
          setAgentReply(`镜头 ${n} 不存在,当前共 ${shots.length} 个分镜。`);
          return;
        }
        setSelectedShotId(shot.id);
        const moveMatch = text.match(
          /低角度|仰拍|俯拍|特写|远景|全景|中景|推轨|跟拍/g,
        );
        if (moveMatch && moveMatch.length > 0) {
          const phrase = moveMatch.join("");
          const newPrompt = `${phrase}, ${shot.prompt}`;
          void saveShot(shot, {
            prompt: newPrompt,
            dialogue: shot.dialogue,
            scene: shot.scene,
          });
          setAgentReply(
            `已选中镜头 ${n},并将运镜「${phrase}」追加到提示词前缀。`,
          );
        } else {
          setAgentReply(`已选中镜头 ${n},可在检查器中查看与编辑。`);
        }
        return;
      }
      // 4) 合成成片
      if (/合成|成片/.test(text)) {
        const notDone = shots.filter(
          (s) => (s.video_status || "").toLowerCase() !== "done",
        ).length;
        if (shots.length > 0 && notDone === 0) {
          setAgentReply("所有镜头就绪,开始合成成片…");
          void assemble();
        } else {
          setAgentReply(
            `还有 ${notDone} 个镜头未生成,建议先执行「生成所有分镜视频」。`,
          );
        }
        return;
      }
      // 5) 角色
      if (/角色/.test(text)) {
        setAgentReply(
          "角色卡位于剧本区下方角色条,可新增角色并生成三视图锁定一致性。",
        );
        return;
      }
      setAgentReply(
        "我可以:拆解剧本、生成角色、生成所有分镜视频、修改镜头运镜(如「镜头3 低角度仰拍」)、合成成片。直接告诉我下一步。",
      );
    },
    [
      storyboarding,
      storyboard,
      generateAllShots,
      shots,
      saveShot,
      assemble,
    ],
  );

  return {
    current,
    characters,
    shots,
    loading,
    error,
    processSteps,
    autorun,
    doneCount,
    gridImage,
    gridShots,
    reload,
    patchProject,
    storyboard,
    storyboarding,
    gridStoryboard,
    gridBusy,
    gridResult,
    gridError,
    showGridPicker,
    setShowGridPicker,
    clearGridResult,
    createCharacter,
    patchCharacter,
    deleteCharacter,
    generateReference,
    busyRef,
    applyAsset,
    assets,
    assetsLoading,
    loadAssets,
    deleteAsset,
    refineScript,
    saveShot,
    generateVideo,
    generateVideoV2,
    continueVideo,
    generateShotCandidates,
    generateVoice,
    generateLipsync,
    busyShot,
    busyVoice,
    busyLipsync,
    busyContinue,
    editingShot,
    setEditingShot,
    candidatesByShot,
    pickCandidate,
    deleteCandidate,
    directorOpen,
    directorLayout,
    directorBusy,
    directorLoading,
    toggleDirector,
    saveDirector,
    directorLayoutChange,
    directorOverlayShot,
    openDirectorOverlay,
    closeDirectorOverlay,
    videoModel,
    videoGenerators,
    videoModelLoading,
    setVideoModel,
    assemble,
    assembling,
    assembleResult,
    assembleError,
    clearAssembleResult,
    refPreview,
    setRefPreview,
    agentBusy,
    agentReply,
    agentExec,
    clearAgentReply,
    selectedShotId,
    setSelectedShotId,
    selectedShot,
    generateAllShots,
    generateAllVoices,
    pendingCount,
    activeTaskCount,
    activeTaskLabel,
    activeTasks,
    taskLog,
  };
}

// 重新导出布局子类型,供 ShotTab 内 DirectorPanel 使用
export type { DramaSceneLayoutActor, DramaSceneLayoutProp };

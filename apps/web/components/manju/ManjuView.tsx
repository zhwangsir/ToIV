"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  listManjuProjects,
  createManjuProject,
  getManjuProject,
  updateManjuProject,
  deleteManjuProject,
  saveManjuShots,
  saveManjuAssets,
  renderManjuShot,
  synthManjuVoice,
  uploadVoiceRef,
  lipsyncManjuShot,
  assembleManju,
  kenburnsManju,
  generateStoryboard,
  listModels,
  imageUrl,
} from "@/lib/api";
import { consumeEngineDraft } from "@/lib/engine";
import type {
  ManjuProjectSummary,
  ManjuProjectDetail,
  ManjuProjectInput,
  ManjuShotItem,
  ManjuShotInput,
  ManjuAssetInput,
  ManjuVoiceResult,
  StoryboardShot,
  AssembleOptions,
  AssembleResult,
} from "@/lib/api";
import type { ModelsResponse } from "@/lib/types";
import { Icon, type IconName } from "@/components/ui/Icon";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { useToast } from "@/components/ui/Toast";

// ── 统一展示类型:兼容已持久化镜头与刚生成的草稿 ──
interface ShotView {
  id: string;
  idx: number;
  scene: string;
  description: string;
  camera: string;
  dialogue: string;
  duration_sec: number;
  characters: string[];
  image_url: string;
  video_url: string;
  voice_url: string;
  status: string;
  draft: boolean;
}

function shotFromItem(s: ManjuShotItem, fallbackIdx: number): ShotView {
  return {
    id: s.id,
    idx: typeof s.idx === "number" ? s.idx : fallbackIdx,
    scene: s.scene ?? "",
    description: s.prompt || s.scene || "",
    camera: s.camera ?? "",
    dialogue: s.dialogue ?? "",
    duration_sec: s.duration_sec ?? 0,
    characters: s.characters ?? [],
    image_url: s.image_url ?? "",
    video_url: s.video_url ?? "",
    voice_url: s.voice_url ?? "",
    status: s.status ?? "pending",
    draft: false,
  };
}

function shotFromDraft(s: StoryboardShot, idx: number): ShotView {
  return {
    id: s.id || `draft-${idx}`,
    idx: idx + 1,
    scene: s.scene ?? "",
    description: s.description || s.scene || "",
    camera: s.camera ?? "",
    dialogue: s.dialogue ?? "",
    duration_sec: s.duration_sec ?? 0,
    characters: s.characters ?? [],
    image_url: "",
    video_url: "",
    voice_url: "",
    status: "draft",
    draft: true,
  };
}

// ── 状态元数据 ──
function statusMeta(status: string): {
  icon: IconName;
  color: string;
  label: string;
  badgeCls: string;
} {
  const s = (status ?? "").toLowerCase();
  if (s === "draft")
    return { icon: "create", color: "var(--accent)", label: "草稿", badgeCls: "badge badge-accent" };
  if (["done", "completed", "finished", "ready", "ok"].includes(s))
    return { icon: "success", color: "var(--success)", label: "完成", badgeCls: "badge badge-success" };
  if (["running", "in_progress", "processing", "rendering", "busy"].includes(s))
    return { icon: "loading", color: "var(--accent)", label: "进行中", badgeCls: "badge badge-accent" };
  if (["error", "failed", "fail"].includes(s))
    return { icon: "error", color: "var(--danger)", label: "失败", badgeCls: "badge badge-danger" };
  return { icon: "queued", color: "var(--ink-faint)", label: "待处理", badgeCls: "badge" };
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000;
    const hr = 60 * min;
    const day = 24 * hr;
    if (diff < min) return "刚刚";
    if (diff < hr) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hr)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    return d.toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

// ── ShotCard 动作集合 ──
interface ShotActions {
  onRender: (shot: ShotView) => void;
  onSave: (shot: ShotView) => void;
  onVoice: (shot: ShotView) => void;
  onLipsync: (shot: ShotView) => void;
  onKenburns: (shot: ShotView) => void;
  isBusy: (shotId: string, action: string) => boolean;
}

// ── 子组件:分镜卡片 ──
function ShotCard({ shot, actions }: { shot: ShotView; actions: ShotActions }) {
  const meta = statusMeta(shot.status);
  const desc = shot.description || shot.scene || `分镜 ${shot.idx}`;
  const hasMedia = shot.video_url || shot.image_url;

  const actBtn = (
    label: string,
    icon: IconName,
    action: string,
    onClick: () => void,
    disabled?: boolean,
    title?: string,
  ) => {
    const busy = actions.isBusy(shot.id, action);
    return (
      <button
        type="button"
        className="mj-act-btn"
        onClick={onClick}
        disabled={busy || disabled}
        title={title ?? label}
      >
        <Icon
          name={busy ? "loading" : icon}
          size={12}
          className={busy ? "mj-spin" : undefined}
        />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <article className="mj-shot" data-draft={shot.draft ? "1" : "0"}>
      <div className="mj-shot-idx">
        <span className="mj-shot-idx-num">#{shot.idx}</span>
      </div>

      <div className="mj-shot-media">
        {shot.video_url ? (
          <video
            src={imageUrl(shot.video_url)}
            controls
            playsInline
            preload="metadata"
            className="mj-shot-video"
          />
        ) : shot.image_url ? (
          <img
            src={imageUrl(shot.image_url)}
            alt={desc}
            loading="lazy"
            className="mj-shot-img"
          />
        ) : (
          <div className="mj-shot-placeholder">
            <Icon name="image" size={22} strokeWidth={1.4} />
            <span>{shot.draft ? "草稿" : "未出图"}</span>
          </div>
        )}
      </div>

      <div className="mj-shot-body">
        <div className="mj-shot-head">
          <h4 className="mj-shot-scene" title={desc}>
            {desc}
          </h4>
          <span className={meta.badgeCls}>
            <Icon
              name={meta.icon}
              size={11}
              strokeWidth={1.9}
              className={meta.icon === "loading" ? "mj-spin" : undefined}
            />
            {meta.label}
          </span>
        </div>

        {shot.scene && shot.description && shot.scene !== shot.description && (
          <p className="mj-shot-scene-line">
            <Icon name="manju" size={11} strokeWidth={1.8} />
            {shot.scene}
          </p>
        )}

        {shot.dialogue && (
          <p className="mj-shot-dialogue">&ldquo;{shot.dialogue}&rdquo;</p>
        )}

        <div className="mj-shot-tags">
          {shot.camera && (
            <span className="mj-shot-tag mj-shot-tag-camera">
              <Icon name="video" size={10} />
              {shot.camera}
            </span>
          )}
          {shot.characters?.map((c) => (
            <span key={c} className="mj-shot-tag mj-shot-tag-char">
              {c}
            </span>
          ))}
          {shot.duration_sec > 0 && (
            <span className="mj-shot-tag mj-shot-tag-dur">{shot.duration_sec}s</span>
          )}
          {hasMedia && (
            <span className="mj-shot-tag mj-shot-tag-media">
              <Icon name={shot.video_url ? "video" : "image"} size={10} />
              {shot.video_url ? "视频" : "图像"}
            </span>
          )}
        </div>

        {/* ── 单镜操作 ── */}
        <div className="mj-shot-actions">
          {actBtn("出图", "image", "render", () => actions.onRender(shot), undefined, "单镜出图")}
          {actBtn(
            "保存",
            "download",
            "save",
            () => actions.onSave(shot),
            !hasMedia,
            "保存素材到项目",
          )}
          {actBtn(
            "配音",
            "audio",
            "voice",
            () => actions.onVoice(shot),
            !shot.dialogue,
            "AI 配音",
          )}
          {actBtn(
            "对口型",
            "video",
            "lipsync",
            () => actions.onLipsync(shot),
            !shot.video_url || !shot.voice_url,
            "需要视频 + 配音",
          )}
          {actBtn(
            "Ken Burns",
            "playing",
            "kenburns",
            () => actions.onKenburns(shot),
            !shot.image_url || !!shot.video_url,
            "静图运镜",
          )}
        </div>
      </div>
    </article>
  );
}

interface ManjuViewProps {
  /** 初始选中的项目 id（从外部创建后带入） */
  initialActiveId?: string;
}

// ── 主组件 ──
export function ManjuView({ initialActiveId }: ManjuViewProps) {
  const engineDraft = useMemo(() => consumeEngineDraft(), []);
  const [projects, setProjects] = useState<ManjuProjectSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ManjuProjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // 新建项目
  const [showNew, setShowNew] = useState(engineDraft?.target === "manju");
  const [newForm, setNewForm] = useState<ManjuProjectInput>({
    title: engineDraft?.target === "manju" ? engineDraft.prompt.slice(0, 80) : "",
    premise: engineDraft?.target === "manju" ? engineDraft.prompt : "",
    style: "",
    ckpt_name: "",
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 生成分镜
  const [showGen, setShowGen] = useState(false);
  const [genPremise, setGenPremise] = useState("");
  const [genNum, setGenNum] = useState<number>(8);
  const [genStyle, setGenStyle] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<StoryboardShot[]>([]);
  const [savingShots, setSavingShots] = useState(false);
  const [saveShotsError, setSaveShotsError] = useState<string | null>(null);

  // 底模列表
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // 项目编辑
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<ManjuProjectInput>({
    title: "",
    premise: "",
    style: "",
    ckpt_name: "",
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // 项目删除
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 单镜操作忙碌态: shotId -> action
  const [busyActions, setBusyActions] = useState<Record<string, string>>({});

  // 配音对话框
  const [voiceTarget, setVoiceTarget] = useState<ShotView | null>(null);
  const [voiceText, setVoiceText] = useState("");
  const [voiceEmo, setVoiceEmo] = useState("");
  const [voiceRefUrl, setVoiceRefUrl] = useState<string>("");
  const [voiceRefName, setVoiceRefName] = useState<string>("");
  const [voiceUploading, setVoiceUploading] = useState(false);
  const [voiceSynthing, setVoiceSynthing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceResult, setVoiceResult] = useState<ManjuVoiceResult | null>(null);
  const voiceFileRef = useRef<HTMLInputElement | null>(null);

  // 合成成片
  const [assembling, setAssembling] = useState(false);
  const [assembleResult, setAssembleResult] = useState<AssembleResult | null>(null);
  const [assembleError, setAssembleError] = useState<string | null>(null);

  // ── Toast:统一使用全局 ToastProvider,不再自实现 ──
  // show 函数在 Provider 内用 useCallback 稳定引用,可直接放进下游 useCallback 依赖
  const { show: showToast } = useToast();

  // ── 任务 5:跟踪所有 setTimeout,组件卸载时统一清理避免泄漏 ──
  // 跨 useCallback / JSX onClick 共用,集中管理所有 timer id
  const timersRef = useRef<Set<number>>(new Set());
  const safeSetTimeout = useCallback((fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  // 卸载时清理所有未触发的 timer,避免 setState on unmounted / 回调错位
  useEffect(() => {
    return () => {
      timersRef.current.forEach((id) => clearTimeout(id));
      timersRef.current.clear();
    };
  }, []);

  // ── 加载底模列表 + 平台默认底模 ──
  // 漫剧不暴露模型选择 UI,统一使用后端 modes.image.default
  useEffect(() => {
    setModelsLoading(true);
    listModels()
      .then((res: ModelsResponse) => {
        const ckpts = res.checkpoints ?? [];
        setModels(ckpts);
        // 读取平台默认底模,自动填充新建表单
        const def = res.modes?.image?.default ?? null;
        const defaultCkpt = def && ckpts.includes(def) ? def : ckpts[0] ?? "";
        if (defaultCkpt) {
          setNewForm((f) => ({ ...f, ckpt_name: f.ckpt_name || defaultCkpt }));
        }
      })
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, []);

  // 当前项目实际生效的底模:如果持久化的 ckpt_name 已不在 worker 可用列表,自动 fallback。
  const effectiveCkpt = useMemo(() => {
    const saved = detail?.ckpt_name?.trim();
    if (saved && models.includes(saved)) return saved;
    return models[0] ?? "";
  }, [detail?.ckpt_name, models]);

  // 检测到项目底模失效时提示用户,并把编辑表单同步到 fallback 值。
  useEffect(() => {
    if (!detail || modelsLoading || models.length === 0) return;
    const saved = detail.ckpt_name?.trim();
    if (saved && !models.includes(saved) && effectiveCkpt) {
      showToast(
        "info",
        `项目底模 "${saved}" 当前不可用,已自动切换为 "${effectiveCkpt}",保存项目后生效`,
      );
      setEditForm((f) => ({ ...f, ckpt_name: effectiveCkpt }));
    }
  }, [detail, models, modelsLoading, effectiveCkpt, showToast]);

  // ── 加载项目列表 ──
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listManjuProjects()
      .then((list) => {
        setProjects(list);
        // 优先使用外部传入的初始选中 id,其次保持当前选中,最后默认第一个
        setActiveId((prev) => {
          if (initialActiveId && list.some((p) => p.id === initialActiveId)) {
            return initialActiveId;
          }
          if (prev && list.some((p) => p.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载漫剧项目失败"),
      )
      .finally(() => setLoading(false));
  }, [initialActiveId]);

  useEffect(() => {
    load();
  }, [load]);

  // ── 加载项目详情 ──
  const openDetail = useCallback((pid: string) => {
    setActiveId(pid);
    setDetail(null);
    setDetailError(null);
    setDrafts([]);
    setShowGen(false);
    setGenError(null);
    setEditing(false);
    setEditError(null);
    setAssembleResult(null);
    setAssembleError(null);
    setBusyActions({});
    setDetailLoading(true);
    getManjuProject(pid)
      .then((d) => {
        setDetail(d);
        setGenPremise(d.premise ?? "");
        setGenStyle(d.style ?? "");
        setEditForm({
          title: d.title ?? "",
          premise: d.premise ?? "",
          style: d.style ?? "",
          ckpt_name: d.ckpt_name ?? "",
        });
      })
      .catch((err) =>
        setDetailError(
          err instanceof Error ? err.message : "加载项目详情失败",
        ),
      )
      .finally(() => setDetailLoading(false));
  }, []);

  useEffect(() => {
    if (activeId) openDetail(activeId);
  }, [activeId, openDetail]);

  // ── 新建项目 ──
  const handleCreate = useCallback(() => {
    if (!newForm.title?.trim()) {
      setCreateError("请填写标题");
      return;
    }
    setCreating(true);
    setCreateError(null);
    const body: ManjuProjectInput = {
      title: newForm.title.trim(),
      ...(newForm.premise?.trim() ? { premise: newForm.premise.trim() } : {}),
      ...(newForm.style?.trim() ? { style: newForm.style.trim() } : {}),
      ...(newForm.ckpt_name?.trim() ? { ckpt_name: newForm.ckpt_name.trim() } : {}),
    };
    createManjuProject(body)
      .then((p) => {
        setProjects((prev) => (prev ? [p, ...prev] : [p]));
        setShowNew(false);
        setNewForm({ title: "", premise: "", style: "", ckpt_name: "" });
        setActiveId(p.id);
        showToast("success", `项目「${p.title}」已创建`);
      })
      .catch((err) =>
        setCreateError(err instanceof Error ? err.message : "创建项目失败"),
      )
      .finally(() => setCreating(false));
  }, [newForm, showToast]);

  // ── 编辑项目 ──
  const handleUpdate = useCallback(() => {
    if (!activeId) return;
    if (!editForm.title?.trim()) {
      setEditError("标题不能为空");
      return;
    }
    setEditSaving(true);
    setEditError(null);
    const body: ManjuProjectInput = {
      title: editForm.title.trim(),
      ...(editForm.premise?.trim() ? { premise: editForm.premise.trim() } : {}),
      ...(editForm.style?.trim() ? { style: editForm.style.trim() } : {}),
      ...(editForm.ckpt_name?.trim() ? { ckpt_name: editForm.ckpt_name.trim() } : {}),
    };
    updateManjuProject(activeId, body)
      .then((updated) => {
        // 同步列表
        setProjects((prev) =>
          prev ? prev.map((p) => (p.id === activeId ? { ...p, ...updated } : p)) : prev,
        );
        // 同步详情
        setDetail((d) => (d ? { ...d, ...updated } : d));
        setEditing(false);
        showToast("success", "项目已更新");
      })
      .catch((err) =>
        setEditError(err instanceof Error ? err.message : "更新项目失败"),
      )
      .finally(() => setEditSaving(false));
  }, [activeId, editForm, showToast]);

  // ── 删除项目(二次确认)──
  const handleDelete = useCallback(
    (pid: string, title: string) => {
      setDeletingId(pid);
      deleteManjuProject(pid)
        .then(() => {
          setProjects((prev) => prev?.filter((p) => p.id !== pid) ?? null);
          // 切换选中
          setActiveId((cur) => {
            if (cur !== pid) return cur;
            const remaining = (projects ?? []).filter((p) => p.id !== pid);
            return remaining[0]?.id ?? null;
          });
          setDeleteConfirmId(null);
          showToast("success", `项目「${title}」已删除`);
        })
        .catch((err) =>
          showToast("error", err instanceof Error ? err.message : "删除项目失败"),
        )
        .finally(() => setDeletingId(null));
    },
    [projects, showToast],
  );

  // ── 生成分镜 ──
  const handleGenerate = useCallback(() => {
    if (!genPremise.trim()) {
      setGenError("请输入故事文本");
      return;
    }
    setGenerating(true);
    setGenError(null);
    generateStoryboard({
      premise: genPremise.trim(),
      num_shots: genNum > 0 ? genNum : undefined,
      ...(genStyle.trim() ? { style: genStyle.trim() } : {}),
    })
      .then((res) => {
        setDrafts(res?.shots ?? []);
        showToast("info", `已生成 ${res?.shots?.length ?? 0} 镜草稿`);
      })
      .catch((err) =>
        setGenError(err instanceof Error ? err.message : "分镜生成失败"),
      )
      .finally(() => setGenerating(false));
  }, [genPremise, genNum, genStyle, showToast]);

  // ── 保存草稿到项目(saveManjuShots)──
  const handleSaveShots = useCallback(() => {
    if (!activeId || drafts.length === 0) return;
    setSavingShots(true);
    setSaveShotsError(null);
    // idx 由后端按顺序排,这里仅传内容字段
    const shotsInput: ManjuShotInput[] = drafts.map((d) => ({
      scene: d.scene || undefined,
      prompt: d.description || undefined,
      characters: d.characters,
      camera: d.camera || undefined,
      dialogue: d.dialogue || undefined,
      duration_sec: d.duration_sec || undefined,
    }));
    saveManjuShots(activeId, shotsInput)
      .then((res) => {
        // 把草稿并入详情(替换),并清空草稿区
        setDetail((d) =>
          d ? { ...d, shots: res.shots ?? [] } : d,
        );
        setDrafts([]);
        showToast("success", `已保存 ${res.shots?.length ?? 0} 镜到项目`);
      })
      .catch((err) =>
        setSaveShotsError(err instanceof Error ? err.message : "保存分镜失败"),
      )
      .finally(() => setSavingShots(false));
  }, [activeId, drafts, showToast]);

  // ── 单镜操作:设置 busy ──
  const setBusy = useCallback((shotId: string, action: string | null) => {
    setBusyActions((prev) => {
      const next = { ...prev };
      if (action === null) delete next[shotId];
      else next[shotId] = action;
      return next;
    });
  }, []);

  const isBusy = useCallback(
    (shotId: string, action: string) => busyActions[shotId] === action,
    [busyActions],
  );

  // 刷新当前详情(异步任务后延迟拉取,看后端是否回填)
  const refreshDetail = useCallback(
    (delayMs = 0) => {
      if (!activeId) return;
      const doRefresh = () => {
        getManjuProject(activeId)
          .then((d) => setDetail(d))
          .catch(() => {
            /* 静默失败,不打扰用户 */
          });
      };
      if (delayMs > 0) {
        // 走 safeSetTimeout,卸载时自动清理
        safeSetTimeout(doRefresh, delayMs);
      } else {
        doRefresh();
      }
    },
    [activeId, safeSetTimeout],
  );

  // ── 单镜出图(renderManjuShot)──
  const handleRenderShot = useCallback(
    (shot: ShotView) => {
      if (!activeId || !detail) return;
      const positive = shot.description || shot.scene;
      if (!positive) {
        showToast("error", "该镜头没有可用的提示词");
        return;
      }
      setBusy(shot.id, "render");
      renderManjuShot({
        positive,
        ...(effectiveCkpt ? { ckptName: effectiveCkpt } : {}),
      })
        .then((res) => {
          showToast(
            "success",
            `出图任务已提交 (prompt: ${res.prompt_id.slice(0, 8)}…)`,
          );
          // 异步任务,8s 后刷新一次详情看是否回填
          refreshDetail(8000);
        })
        .catch((err) =>
          showToast("error", err instanceof Error ? err.message : "出图失败"),
        )
        .finally(() => setBusy(shot.id, null));
    },
    [activeId, detail, effectiveCkpt, showToast, setBusy, refreshDetail],
  );

  // ── 保存分镜素材到项目资产(saveManjuAssets)──
  const handleSaveAsset = useCallback(
    (shot: ShotView) => {
      if (!activeId) return;
      if (!shot.image_url && !shot.video_url) {
        showToast("error", "该镜头暂无素材可保存");
        return;
      }
      setBusy(shot.id, "save");
      const kind = shot.video_url ? "video" : "image";
      const assets: ManjuAssetInput[] = [
        {
          // 关联到具体镜头,便于后端把资产挂回原 shot
          shot_id: shot.id,
          kind,
          name: `分镜${shot.idx}_${shot.scene || "untitled"}`.slice(0, 60),
          description: shot.description || shot.scene || undefined,
          ...(shot.image_url ? { ref_image: shot.image_url } : {}),
          ...(shot.voice_url ? { ref_audio: shot.voice_url } : {}),
        },
      ];
      saveManjuAssets(activeId, assets)
        .then(() => {
          showToast("success", "素材已保存到项目资产");
          refreshDetail(500);
        })
        .catch((err) =>
          showToast("error", err instanceof Error ? err.message : "保存素材失败"),
        )
        .finally(() => setBusy(shot.id, null));
    },
    [activeId, showToast, setBusy, refreshDetail],
  );

  // ── 打开配音对话框 ──
  const openVoiceDialog = useCallback((shot: ShotView) => {
    setVoiceTarget(shot);
    setVoiceText(shot.dialogue ?? "");
    setVoiceEmo("");
    setVoiceRefUrl("");
    setVoiceRefName("");
    setVoiceError(null);
    setVoiceResult(null);
  }, []);

  const closeVoiceDialog = useCallback(() => {
    setVoiceTarget(null);
    setVoiceError(null);
    setVoiceResult(null);
  }, []);

  // Esc 关闭配音对话框(合成中不响应,避免误触丢失结果)
  useEffect(() => {
    if (!voiceTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !voiceSynthing) closeVoiceDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voiceTarget, voiceSynthing, closeVoiceDialog]);

  // ── 上传参考音色(uploadVoiceRef)──
  const handleUploadVoiceRef = useCallback(
    (file: File) => {
      setVoiceUploading(true);
      setVoiceError(null);
      uploadVoiceRef(file)
        .then((res) => {
          setVoiceRefUrl(res.url);
          setVoiceRefName(res.name);
          showToast("success", "参考音色已上传");
        })
        .catch((err) =>
          setVoiceError(err instanceof Error ? err.message : "音色上传失败"),
        )
        .finally(() => setVoiceUploading(false));
    },
    [showToast],
  );

  // ── 合成配音(synthManjuVoice)──
  const handleSynthVoice = useCallback(() => {
    if (!voiceTarget) return;
    if (!voiceText.trim()) {
      setVoiceError("请输入配音文本");
      return;
    }
    setVoiceSynthing(true);
    setVoiceError(null);
    synthManjuVoice({
      text: voiceText.trim(),
      ...(voiceEmo.trim() ? { emo_text: voiceEmo.trim() } : {}),
      ...(voiceRefUrl ? { ref_audio_url: voiceRefUrl } : {}),
    })
      .then((res) => {
        setVoiceResult(res);
        showToast("success", "配音已合成");
        // 若镜头已持久化,把 voice_url 回写到项目;必须带 shot_id 让后端定位目标镜头
        if (!voiceTarget.draft && activeId && detail) {
          saveManjuShots(activeId, [
            { shot_id: voiceTarget.id, voice_url: res.url },
          ])
            .then(() => refreshDetail(300))
            .catch(() => {
              /* 回写失败不影响主流程 */
            });
        }
      })
      .catch((err) =>
        setVoiceError(err instanceof Error ? err.message : "配音合成失败"),
      )
      .finally(() => setVoiceSynthing(false));
  }, [voiceTarget, voiceText, voiceEmo, voiceRefUrl, activeId, detail, showToast, refreshDetail]);

  // ── 对口型(lipsyncManjuShot)──
  const handleLipsync = useCallback(
    (shot: ShotView) => {
      if (!shot.video_url || !shot.voice_url) {
        showToast("error", "需要先有视频和配音");
        return;
      }
      setBusy(shot.id, "lipsync");
      lipsyncManjuShot({
        video_url: shot.video_url,
        voice_url: shot.voice_url,
      })
        .then((res) => {
          showToast(
            "success",
            `对口型任务已提交 (prompt: ${res.prompt_id.slice(0, 8)}…)`,
          );
          refreshDetail(10000);
        })
        .catch((err) =>
          showToast("error", err instanceof Error ? err.message : "对口型失败"),
        )
        .finally(() => setBusy(shot.id, null));
    },
    [showToast, setBusy, refreshDetail],
  );

  // ── Ken Burns 静图运镜(kenburnsManju)──
  const handleKenburns = useCallback(
    (shot: ShotView) => {
      if (!shot.image_url) {
        showToast("error", "该镜头没有图像");
        return;
      }
      setBusy(shot.id, "kenburns");
      // 时长用镜头 duration(兜底 3s),motion 用镜头 camera(兜底 "zoom_in")
      const duration = shot.duration_sec > 0 ? shot.duration_sec : 3;
      const motion = shot.camera || "zoom_in";
      // Ken Burns 输出尺寸(16:9,适配漫剧分镜)
      const KENBURNS_W = 1024;
      const KENBURNS_H = 576;
      kenburnsManju(shot.image_url, duration, motion, KENBURNS_W, KENBURNS_H)
        .then((res) => {
          showToast("success", "Ken Burns 片段已生成");
          // 把产物回写为该镜头的 video_url;必须带 shot_id 让后端定位目标镜头
          if (!shot.draft && activeId) {
            saveManjuShots(activeId, [
              { shot_id: shot.id, video_url: res.url },
            ])
              .then(() => refreshDetail(300))
              .catch(() => {
                /* 回写失败不影响主流程 */
              });
          }
        })
        .catch((err) =>
          showToast("error", err instanceof Error ? err.message : "Ken Burns 生成失败"),
        )
        .finally(() => setBusy(shot.id, null));
    },
    [activeId, showToast, setBusy, refreshDetail],
  );

  // ── 合成成片(assembleManju)──
  const handleAssemble = useCallback(() => {
    if (!activeId || !detail) return;
    const shots = detail.shots ?? [];
    const clips: string[] = [];
    const voiceUrls: string[] = [];
    const durations: number[] = [];
    for (const s of shots) {
      if (s.video_url) {
        clips.push(s.video_url);
        voiceUrls.push(s.voice_url ?? "");
        durations.push(s.duration_sec ?? 0);
      }
    }
    if (clips.length === 0) {
      setAssembleError("暂无可合成的视频片段(需先对各镜生成视频)");
      return;
    }
    setAssembling(true);
    setAssembleError(null);
    setAssembleResult(null);
    const subtitles = shots
      .filter((s) => s.video_url && s.dialogue)
      .map((s) => s.dialogue);
    const options: AssembleOptions = {
      transition: "crossfade",
      bgm_url: null,
      subtitles,
      fps: 24,
    };
    assembleManju(clips, options, voiceUrls, durations)
      .then((res) => {
        setAssembleResult(res);
        showToast("success", `成片已合成:${res.name}`);
      })
      .catch((err) =>
        setAssembleError(err instanceof Error ? err.message : "合成成片失败"),
      )
      .finally(() => setAssembling(false));
  }, [activeId, detail, showToast]);

  // ── 合并展示:草稿在前,持久化镜头在后 ──
  const shotsView = useMemo<ShotView[]>(() => {
    const draftViews = drafts.map((s, i) => shotFromDraft(s, i));
    const itemViews = (detail?.shots ?? []).map((s, i) => shotFromItem(s, i + 1));
    return [...draftViews, ...itemViews];
  }, [drafts, detail]);

  const shotActions: ShotActions = useMemo(
    () => ({
      onRender: handleRenderShot,
      onSave: handleSaveAsset,
      onVoice: openVoiceDialog,
      onLipsync: handleLipsync,
      onKenburns: handleKenburns,
      isBusy,
    }),
    [
      handleRenderShot,
      handleSaveAsset,
      openVoiceDialog,
      handleLipsync,
      handleKenburns,
      isBusy,
    ],
  );

  const activeProject = useMemo(
    () => projects?.find((p) => p.id === activeId) ?? null,
    [projects, activeId],
  );

  const isEmpty = !loading && !error && (projects?.length ?? 0) === 0;
  const count = projects?.length ?? 0;

  // 模型锁定:漫剧不暴露底模选择 UI,统一使用平台默认底模(只读展示)
  const ckptSelect = (
    value: string,
    _onChange: (v: string) => void,
    _placeholder: string,
  ) => (
    <div className="mj-ckpt-readonly">
      {modelsLoading ? (
        <span className="mj-ckpt-loading">加载底模…</span>
      ) : value ? (
        <span className="badge badge-accent" title="平台默认底模">
          {value}
        </span>
      ) : (
        <span className="mj-ckpt-empty">未配置</span>
      )}
    </div>
  );

  return (
    <div className="single-view manju-view">
      <header className="mj-header">
        <div className="mj-titles">
          <h1 className="mj-title">
            <Icon name="manju" size={20} strokeWidth={1.6} />
            漫剧工作室
          </h1>
          <span className="mj-subtitle">项目 · 分镜 · 创作</span>
        </div>
        <div className="mj-header-right">
          <span className="mj-count" aria-live="polite">
            {loading ? "加载中" : error ? "—" : `${count} 个项目`}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={load}
            disabled={loading}
          >
            <Icon
              name="refresh"
              size={14}
              className={loading ? "mj-spin" : undefined}
            />
            刷新
          </button>
        </div>
      </header>

      <div className="mj-layout">
        {/* ── 左侧:项目列表 ── */}
        <aside className="mj-sidebar">
          <div className="mj-side-head">
            <button
              type="button"
              className="btn btn-primary btn-sm mj-new-btn"
              onClick={() => setShowNew((v) => !v)}
              aria-expanded={showNew}
            >
              <Icon name="create" size={14} />
              {showNew ? "收起" : "新建项目"}
            </button>
          </div>

          {showNew && (
            <div className="mj-new-form card">
              <label className="mj-field">
                <span className="mj-field-label">标题</span>
                <input
                  className="input"
                  value={newForm.title}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, title: e.target.value }))
                  }
                  placeholder="给项目起个名字"
                  maxLength={80}
                />
              </label>
              <label className="mj-field">
                <span className="mj-field-label">故事大纲</span>
                <textarea
                  className="input"
                  value={newForm.premise}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, premise: e.target.value }))
                  }
                  placeholder="一句话描述故事"
                  rows={2}
                />
              </label>
              <div className="mj-field-row">
                <label className="mj-field">
                  <span className="mj-field-label">风格</span>
                  <input
                    className="input"
                    value={newForm.style}
                    onChange={(e) =>
                      setNewForm((f) => ({ ...f, style: e.target.value }))
                    }
                    placeholder="如:赛博朋克"
                  />
                </label>
                <label className="mj-field">
                  <span className="mj-field-label">底模</span>
                  {ckptSelect(
                    newForm.ckpt_name ?? "",
                    (v) => setNewForm((f) => ({ ...f, ckpt_name: v })),
                    "选择底模",
                  )}
                </label>
              </div>
              {createError && <div className="mj-error-inline">{createError}</div>}
              <div className="mj-form-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setShowNew(false);
                    setCreateError(null);
                  }}
                  disabled={creating}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleCreate}
                  disabled={creating}
                >
                  {creating ? (
                    <>
                      <Icon name="loading" size={13} className="mj-spin" />
                      创建中…
                    </>
                  ) : (
                    "创建"
                  )}
                </button>
              </div>
            </div>
          )}

          <div className="mj-proj-list">
            {loading && (
              <div className="loading-spinner mj-side-loading">
                <Icon name="loading" size={16} className="mj-spin" />
                <span>加载项目…</span>
              </div>
            )}

            {error && !loading && (
              <div className="mj-side-error">
                <Icon name="error" size={20} />
                <span>{error}</span>
                <button type="button" className="btn btn-sm" onClick={load}>
                  <Icon name="refresh" size={12} />
                  重试
                </button>
              </div>
            )}

            {isEmpty && (
              <div className="mj-side-empty">
                <Icon name="manju" size={28} strokeWidth={1.3} />
                <span>暂无项目</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowNew(true)}
                >
                  + 新建第一个
                </button>
              </div>
            )}

            {!loading && !error && projects && projects.length > 0 && (
              <ul className="mj-proj-ul">
                {projects.map((p) => {
                  const active = p.id === activeId;
                  const isConfirming = deleteConfirmId === p.id;
                  const isDeleting = deletingId === p.id;
                  return (
                    <li key={p.id} className="mj-proj-li">
                      <button
                        type="button"
                        className="mj-proj-item"
                        data-active={active ? "1" : "0"}
                        onClick={() => {
                          if (isConfirming) {
                            setDeleteConfirmId(null);
                            return;
                          }
                          setActiveId(p.id);
                        }}
                      >
                        <div className="mj-proj-title" title={p.title}>
                          {p.title || "未命名"}
                        </div>
                        {p.premise && (
                          <div className="mj-proj-premise">{p.premise}</div>
                        )}
                        <div className="mj-proj-foot">
                          {p.style && (
                            <span className="mj-proj-style">{p.style}</span>
                          )}
                          <span className="mj-proj-time">
                            {formatTime(p.updated_at || p.created_at)}
                          </span>
                        </div>
                      </button>

                      {/* 删除按钮:hover 显示,二次确认 */}
                      <button
                        type="button"
                        className={`mj-proj-del ${
                          isConfirming ? "mj-proj-del-confirm" : ""
                        }`}
                        title={isConfirming ? "再次点击确认删除" : "删除项目"}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isDeleting) return;
                          if (isConfirming) {
                            handleDelete(p.id, p.title || "未命名");
                          } else {
                            setDeleteConfirmId(p.id);
                            // 4s 未确认自动取消(走 safeSetTimeout,卸载时自动清理)
                            safeSetTimeout(() => {
                              setDeleteConfirmId((cur) =>
                                cur === p.id ? null : cur,
                              );
                            }, 4000);
                          }
                        }}
                        disabled={isDeleting}
                      >
                        <Icon
                          name={isDeleting ? "loading" : "delete"}
                          size={12}
                          className={isDeleting ? "mj-spin" : undefined}
                        />
                        {isConfirming ? "确认?" : ""}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* ── 右侧:项目详情 ── */}
        {/* 外层布局已有 <main id="main">,此处用 div 避免重复 main 地标(WCAG landmark-no-duplicate-main) */}
        <div className="mj-main">
          {!activeId && !isEmpty && (
            <div className="empty-state mj-main-empty">
              <div className="empty-state-icon">
                <Icon name="manju" size={48} strokeWidth={1.2} />
              </div>
              <div className="empty-state-title">选择一个项目</div>
              <div className="empty-state-desc">
                从左侧选择项目 · 或新建一个开始创作
              </div>
            </div>
          )}

          {activeId && (
            <div className="mj-detail">
              {/* 详情头部 */}
              <header className="mj-detail-head">
                {detailLoading && !detail ? (
                  <div className="loading-spinner mj-detail-loading">
                    <Icon name="loading" size={16} className="mj-spin" />
                    <span>加载项目…</span>
                  </div>
                ) : editing ? (
                  <div className="mj-edit-form">
                    <label className="mj-field">
                      <span className="mj-field-label">标题</span>
                      <input
                        className="input"
                        value={editForm.title ?? ""}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, title: e.target.value }))
                        }
                        maxLength={80}
                      />
                    </label>
                    <label className="mj-field">
                      <span className="mj-field-label">大纲</span>
                      <textarea
                        className="input"
                        value={editForm.premise ?? ""}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, premise: e.target.value }))
                        }
                        rows={2}
                      />
                    </label>
                    <div className="mj-field-row">
                      <label className="mj-field">
                        <span className="mj-field-label">风格</span>
                        <input
                          className="input"
                          value={editForm.style ?? ""}
                          onChange={(e) =>
                            setEditForm((f) => ({ ...f, style: e.target.value }))
                          }
                        />
                      </label>
                      <label className="mj-field">
                        <span className="mj-field-label">底模</span>
                        {ckptSelect(
                          editForm.ckpt_name ?? "",
                          (v) => setEditForm((f) => ({ ...f, ckpt_name: v })),
                          "选择底模",
                        )}
                      </label>
                    </div>
                    {editError && (
                      <div className="mj-error-inline">{editError}</div>
                    )}
                    <div className="mj-form-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setEditing(false);
                          setEditError(null);
                        }}
                        disabled={editSaving}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={handleUpdate}
                        disabled={editSaving}
                      >
                        {editSaving ? (
                          <>
                            <Icon name="loading" size={13} className="mj-spin" />
                            保存中…
                          </>
                        ) : (
                          <>
                            <Icon name="success" size={13} />
                            保存
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mj-detail-titles">
                      <h2 className="mj-detail-title">
                        {detail?.title ?? activeProject?.title ?? "项目详情"}
                      </h2>
                      {((detail?.premise || activeProject?.premise) && (
                        <p className="mj-detail-premise">
                          {detail?.premise ?? activeProject?.premise}
                        </p>
                      )) || null}
                      <div className="mj-detail-meta">
                        {(detail?.style || activeProject?.style) && (
                          <span className="badge badge-accent">
                            <Icon name="create" size={10} />
                            {detail?.style ?? activeProject?.style}
                          </span>
                        )}
                        {(detail?.ckpt_name || activeProject?.ckpt_name) && (
                          <span
                            className={`badge${
                              detail?.ckpt_name && !models.includes(detail.ckpt_name)
                                ? " badge-warning"
                                : ""
                            }`}
                            title={
                              detail?.ckpt_name && !models.includes(detail.ckpt_name)
                                ? `该底模当前不可用,已自动切换为 ${effectiveCkpt}`
                                : ""
                            }
                          >
                            <Icon name="models" size={10} />
                            {detail?.ckpt_name ?? activeProject?.ckpt_name}
                            {detail?.ckpt_name && !models.includes(detail.ckpt_name) && (
                              <span className="mj-ckpt-fallback">
                                → {effectiveCkpt}
                              </span>
                            )}
                          </span>
                        )}
                        <span className="mj-detail-time">
                          <Icon name="queued" size={11} />
                          {formatTime(
                            detail?.updated_at ?? activeProject?.updated_at ?? "",
                          )}
                        </span>
                      </div>
                    </div>

                    <div className="mj-detail-head-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setEditForm({
                            title: detail?.title ?? "",
                            premise: detail?.premise ?? "",
                            style: detail?.style ?? "",
                            ckpt_name: detail?.ckpt_name ?? "",
                          });
                          setEditError(null);
                          setEditing(true);
                        }}
                        disabled={!detail}
                        title="编辑项目信息"
                      >
                        <Icon name="create" size={13} />
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={handleAssemble}
                        disabled={!detail || assembling}
                        title="把所有镜视频拼成成片"
                      >
                        {assembling ? (
                          <>
                            <Icon name="loading" size={13} className="mj-spin" />
                            合成中…
                          </>
                        ) : (
                          <>
                            <Icon name="playing" size={13} />
                            合成成片
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setShowGen((v) => !v)}
                        disabled={!detail}
                        aria-expanded={showGen}
                      >
                        <Icon name="create" size={14} />
                        {showGen ? "收起" : "生成分镜"}
                      </button>
                    </div>
                  </>
                )}
              </header>

              {detailError && (
                <div className="mj-detail-error">
                  <Icon name="error" size={20} />
                  <span>{detailError}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => activeId && openDetail(activeId)}
                  >
                    <Icon name="refresh" size={12} />
                    重试
                  </button>
                </div>
              )}

              {/* 合成成片结果 */}
              {assembleError && (
                <div className="mj-error-inline">{assembleError}</div>
              )}
              {assembleResult && (
                <div className="mj-assemble-result">
                  <Icon name="success" size={14} />
                  <span>成片已合成:{assembleResult.name}</span>
                  <a
                    className="btn btn-sm btn-primary"
                    href={imageUrl(assembleResult.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="download" size={12} />
                    下载
                  </a>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setAssembleResult(null)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              )}

              {/* 生成分镜面板 */}
              {showGen && detail && (
                <section className="card mj-gen-panel">
                  <div className="mj-gen-panel-head">
                    <div className="mj-gen-panel-title">
                      <Icon name="create" size={15} />
                      生成分镜脚本
                    </div>
                    {drafts.length > 0 && (
                      <span className="badge badge-accent">
                        {drafts.length} 镜草稿
                      </span>
                    )}
                  </div>
                  <label className="mj-field">
                    <span className="mj-field-label">故事文本</span>
                    <textarea
                      className="input mj-gen-textarea"
                      value={genPremise}
                      onChange={(e) => setGenPremise(e.target.value)}
                      placeholder="输入故事梗概、情节走向或一段剧本…"
                      rows={5}
                    />
                  </label>
                  <div className="mj-gen-row">
                    <label className="mj-field mj-field-sm">
                      <span className="mj-field-label">镜头数</span>
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={48}
                        value={genNum}
                        onChange={(e) =>
                          setGenNum(
                            Math.max(1, Math.min(48, Number(e.target.value) || 8)),
                          )
                        }
                      />
                    </label>
                    <label className="mj-field mj-field-sm">
                      <span className="mj-field-label">风格</span>
                      <input
                        className="input"
                        value={genStyle}
                        onChange={(e) => setGenStyle(e.target.value)}
                        placeholder="如:水彩 / 赛博朋克"
                      />
                    </label>
                    <div className="mj-gen-actions">
                      {drafts.length > 0 && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setDrafts([])}
                          disabled={generating || savingShots}
                        >
                          <Icon name="delete" size={12} />
                          清除草稿
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleGenerate}
                        disabled={generating}
                      >
                        {generating ? (
                          <>
                            <Icon name="loading" size={14} className="mj-spin" />
                            生成中…
                          </>
                        ) : (
                          <>
                            <Icon name="create" size={14} />
                            生成
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                  {genError && (
                    <div className="mj-error-inline">{genError}</div>
                  )}
                  {drafts.length > 0 && !genError && (
                    <div className="mj-gen-hint">
                      <Icon name="success" size={12} />
                      已生成 {drafts.length} 镜草稿 · 草稿显示在分镜列表顶部
                    </div>
                  )}
                  {drafts.length > 0 && (
                    <div className="mj-gen-save">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={handleSaveShots}
                        disabled={savingShots}
                      >
                        {savingShots ? (
                          <>
                            <Icon name="loading" size={13} className="mj-spin" />
                            保存中…
                          </>
                        ) : (
                          <>
                            <Icon name="download" size={13} />
                            保存到项目
                          </>
                        )}
                      </button>
                      {saveShotsError && (
                        <span className="mj-error-inline">
                          {saveShotsError}
                        </span>
                      )}
                    </div>
                  )}
                </section>
              )}

              {/* 分镜列表 */}
              <section className="mj-shots-section">
                <div className="mj-section-head">
                  <span className="mj-section-title">分镜</span>
                  {shotsView.length > 0 && (
                    <span className="mj-section-count">{shotsView.length}</span>
                  )}
                </div>

                {detailLoading && !detail && (
                  <div className="loading-spinner mj-shots-loading">
                    <Icon name="loading" size={16} className="mj-spin" />
                    <span>加载分镜…</span>
                  </div>
                )}

                {!detailLoading &&
                  detail &&
                  shotsView.length === 0 && (
                    <div className="empty-state mj-shots-empty">
                      <div className="empty-state-icon">
                        <Icon name="create" size={36} strokeWidth={1.3} />
                      </div>
                      <div className="empty-state-title">暂无分镜</div>
                      <div className="empty-state-desc">
                        点击「生成分镜」 · 输入故事文本自动产出镜头脚本
                      </div>
                    </div>
                  )}

                {shotsView.length > 0 && (
                  <div className="mj-shots">
                    {shotsView.map((s) => (
                      <ShotCard
                        key={`${s.draft ? "d" : "p"}-${s.id}`}
                        shot={s}
                        actions={shotActions}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      {/* ── 配音对话框 ── */}
      {voiceTarget && (
        <div
          className="mj-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="配音设置"
          onClick={closeVoiceDialog}
        >
          <div className="mj-modal card" onClick={(e) => e.stopPropagation()}>
            <div className="mj-modal-head">
              <div className="mj-modal-title">
                <Icon name="audio" size={15} />
                配音 · 分镜 #{voiceTarget.idx}
              </div>
              <button
                type="button"
                className="mj-modal-close"
                onClick={closeVoiceDialog}
                aria-label="关闭"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <div className="mj-modal-body">
              <label className="mj-field">
                <div className="mj-field-label-row">
                  <span className="mj-field-label">配音文本</span>
                  <OptimizeButton
                    prompt={voiceText}
                    kind="audio"
                    onOptimized={(t) => setVoiceText(t)}
                    label="优化台词"
                  />
                </div>
                <textarea
                  className="input"
                  value={voiceText}
                  onChange={(e) => setVoiceText(e.target.value)}
                  rows={4}
                  placeholder="输入要朗读的台词…"
                />
              </label>
              <label className="mj-field">
                <span className="mj-field-label">情绪描述(可选)</span>
                <input
                  className="input"
                  value={voiceEmo}
                  onChange={(e) => setVoiceEmo(e.target.value)}
                  placeholder="如:激动 / 低沉 / 平静"
                />
              </label>
              <div className="mj-field">
                <span className="mj-field-label">参考音色(可选 · 克隆)</span>
                <div className="mj-voice-ref-row">
                  <input
                    ref={voiceFileRef}
                    type="file"
                    accept="audio/*"
                    className="mj-file-input"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUploadVoiceRef(f);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => voiceFileRef.current?.click()}
                    disabled={voiceUploading}
                  >
                    {voiceUploading ? (
                      <>
                        <Icon name="loading" size={12} className="mj-spin" />
                        上传中…
                      </>
                    ) : (
                      <>
                        <Icon name="upload" size={12} />
                        上传参考音
                      </>
                    )}
                  </button>
                  {voiceRefName && (
                    <span className="mj-voice-ref-name" title={voiceRefName}>
                      <Icon name="audio" size={11} />
                      {voiceRefName}
                    </span>
                  )}
                </div>
              </div>
              {voiceError && (
                <div className="mj-error-inline">{voiceError}</div>
              )}
              {voiceResult && (
                <div className="mj-voice-result">
                  <Icon name="success" size={13} />
                  <span>配音已合成({voiceResult.duration_sec.toFixed(1)}s)</span>
                  <audio
                    controls
                    src={imageUrl(voiceResult.url)}
                    className="mj-voice-audio"
                  />
                </div>
              )}
            </div>
            <div className="mj-modal-foot">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={closeVoiceDialog}
              >
                关闭
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleSynthVoice}
                disabled={voiceSynthing}
              >
                {voiceSynthing ? (
                  <>
                    <Icon name="loading" size={13} className="mj-spin" />
                    合成中…
                  </>
                ) : (
                  <>
                    <Icon name="audio" size={13} />
                    合成配音
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .manju-view {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }

        /* ── 顶部 ── */
        .mj-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: var(--space-4);
          flex-wrap: wrap;
          padding-bottom: var(--space-4);
          border-bottom: 1px solid var(--hairline);
        }
        .mj-titles {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          min-width: 0;
        }
        .mj-title {
          margin: 0;
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-family: var(--font-display);
          font-size: 1.5rem;
          font-weight: 500;
          letter-spacing: -0.02em;
          color: var(--ink);
          line-height: 1.2;
        }
        .mj-title :global(svg) {
          color: var(--accent);
          filter: drop-shadow(0 0 6px var(--accent-quiet));
        }
        .mj-subtitle {
          font-size: 0.72rem;
          color: var(--ink-faint);
          letter-spacing: 0.02em;
        }
        .mj-header-right {
          display: flex;
          align-items: center;
          gap: var(--space-3);
        }
        .mj-count {
          font-size: 0.78rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
        }

        /* ── 左右分栏(宽度用 var 回退,不修改 globals.css)── */
        .mj-layout {
          display: grid;
          grid-template-columns: var(--list-w, 300px) 1fr;
          gap: var(--space-4);
          align-items: start;
        }

        /* ── 左侧 ── */
        .mj-sidebar {
          position: sticky;
          top: var(--space-4);
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          max-height: calc(100vh - var(--topbar-h) - var(--space-7));
        }
        .mj-side-head {
          display: flex;
          gap: var(--space-2);
        }
        .mj-new-btn {
          flex: 1;
        }
        .mj-new-form {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          padding: 0.85rem;
          background: var(--bg-1);
          border: 1px solid var(--accent-line);
          box-shadow: 0 8px 32px -16px var(--accent-quiet);
        }
        .mj-field {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          min-width: 0;
        }
        .mj-field-label {
          font-size: 0.7rem;
          font-weight: 600;
          color: var(--ink-faint);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .mj-field-label-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .mj-field-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.5rem;
        }
        .mj-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: 0.4rem;
          margin-top: 0.2rem;
        }
        .mj-error-inline {
          padding: 0.4rem 0.55rem;
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          border-radius: var(--radius-xs);
          color: var(--danger);
          font-size: 0.78rem;
        }

        .mj-proj-list {
          flex: 1;
          overflow-y: auto;
          min-height: 120px;
          padding-right: 2px;
        }
        .mj-side-loading {
          padding: var(--space-4) var(--space-3);
          justify-content: center;
        }
        .mj-side-error {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          padding: var(--space-4);
          color: var(--ink-faint);
          font-size: 0.82rem;
          text-align: center;
        }
        .mj-side-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          padding: var(--space-5) var(--space-3);
          color: var(--ink-faint);
          font-size: 0.82rem;
          text-align: center;
        }
        .mj-proj-ul {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }
        .mj-proj-li {
          position: relative;
        }
        .mj-proj-item {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
          padding: 0.6rem 0.7rem;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink);
          text-align: left;
          cursor: pointer;
          transition: border-color var(--dur) var(--ease),
            background-color var(--dur) var(--ease),
            transform var(--dur) var(--ease);
        }
        .mj-proj-item:hover {
          border-color: var(--hairline-2);
          background: var(--bg-2);
        }
        .mj-proj-item:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .mj-proj-item[data-active="1"] {
          border-color: var(--accent-line);
          background: var(--accent-quiet);
          box-shadow: inset 2px 0 0 var(--accent);
        }
        .mj-proj-item[data-active="1"] .mj-proj-title {
          color: var(--accent);
        }
        .mj-proj-title {
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.3;
          letter-spacing: -0.01em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding-right: 1.4rem;
        }
        .mj-proj-premise {
          font-size: 0.74rem;
          color: var(--ink-faint);
          line-height: 1.4;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .mj-proj-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          margin-top: 0.2rem;
        }
        .mj-proj-style {
          font-size: 0.66rem;
          color: var(--accent);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          padding: 0.05rem 0.35rem;
          background: var(--accent-quiet);
          border-radius: var(--radius-xs);
        }
        .mj-proj-time {
          font-size: 0.66rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
        }

        /* 删除按钮:hover 显示,二次确认态变红 */
        .mj-proj-del {
          position: absolute;
          top: 6px;
          right: 6px;
          display: inline-flex;
          align-items: center;
          gap: 0.2rem;
          padding: 0.18rem 0.35rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-xs);
          color: var(--ink-faint);
          font-size: 0.66rem;
          opacity: 0;
          pointer-events: none;
          transition: opacity var(--dur) var(--ease),
            background-color var(--dur) var(--ease),
            color var(--dur) var(--ease),
            border-color var(--dur) var(--ease);
        }
        .mj-proj-li:hover .mj-proj-del {
          opacity: 1;
          pointer-events: auto;
        }
        .mj-proj-del:hover {
          color: var(--danger);
          border-color: var(--danger);
        }
        .mj-proj-del-confirm {
          opacity: 1;
          pointer-events: auto;
          background: var(--danger-quiet);
          border-color: var(--danger);
          color: var(--danger);
          font-weight: 600;
        }

        /* ── 右侧 ── */
        .mj-main {
          min-width: 0;
        }
        .mj-main-empty {
          padding: var(--space-7) var(--space-4);
          min-height: 320px;
        }
        .mj-detail {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }
        .mj-detail-loading {
          padding: var(--space-3) 0;
        }
        .mj-detail-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--space-3);
          flex-wrap: wrap;
          padding: var(--space-4);
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-bottom: 1px solid var(--hairline);
          border-radius: var(--radius);
          position: relative;
        }
        .mj-detail-titles {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          min-width: 0;
          flex: 1;
        }
        .mj-detail-title {
          margin: 0;
          font-family: var(--font-display);
          font-size: 1.3rem;
          font-weight: 500;
          letter-spacing: -0.02em;
          color: var(--ink);
          line-height: 1.25;
          word-break: break-word;
        }
        .mj-detail-premise {
          margin: 0;
          font-size: 0.84rem;
          color: var(--ink-soft);
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .mj-detail-meta {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          flex-wrap: wrap;
          margin-top: 0.2rem;
        }
        .mj-detail-time {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          font-size: 0.7rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
        }
        .mj-detail-head-actions {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          flex-wrap: wrap;
        }
        .mj-detail-error {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          padding: 0.7rem 0.85rem;
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          border-radius: var(--radius);
          color: var(--ink-soft);
          font-size: 0.84rem;
          flex-wrap: wrap;
        }
        .mj-detail-error :global(.btn) {
          margin-left: auto;
        }

        /* 编辑表单(内嵌在头部)── */
        .mj-edit-form {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          flex: 1;
          min-width: 0;
        }

        /* 合成成片结果 */
        .mj-assemble-result {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
          padding: 0.6rem 0.85rem;
          background: var(--success-quiet);
          border: 1px solid var(--success);
          border-radius: var(--radius);
          color: var(--ink-soft);
          font-size: 0.84rem;
        }
        .mj-assemble-result :global(svg) {
          color: var(--success);
        }
        .mj-assemble-result :global(a.btn) {
          margin-left: auto;
          text-decoration: none;
        }

        /* ── 生成分镜面板 ── */
        .mj-gen-panel {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          background: var(--bg-1);
          border-color: var(--accent-line);
          box-shadow: 0 8px 32px -16px var(--accent-quiet);
        }
        .mj-gen-panel-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .mj-gen-panel-title {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--ink);
          letter-spacing: -0.01em;
        }
        .mj-gen-panel-title :global(svg) {
          color: var(--accent);
        }
        .mj-gen-textarea {
          min-height: 110px;
          font-family: inherit;
          line-height: 1.55;
        }
        .mj-gen-row {
          display: grid;
          grid-template-columns: 120px 1fr auto;
          gap: 0.6rem;
          align-items: end;
        }
        .mj-field-sm .mj-field-label {
          font-size: 0.66rem;
        }
        .mj-gen-actions {
          display: flex;
          gap: 0.4rem;
          align-items: center;
        }
        .mj-gen-hint {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.4rem 0.55rem;
          background: var(--success-quiet);
          border: 1px solid var(--success);
          border-radius: var(--radius-xs);
          color: var(--success);
          font-size: 0.76rem;
        }
        .mj-gen-save {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
          padding-top: 0.4rem;
          border-top: 1px dashed var(--hairline-2);
        }

        /* ── 分镜列表 ── */
        .mj-shots-section {
          display: flex;
          flex-direction: column;
          gap: 0.7rem;
        }
        .mj-section-head {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .mj-section-title {
          font-size: 0.72rem;
          font-weight: 600;
          color: var(--ink-faint);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .mj-section-count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 20px;
          height: 18px;
          padding: 0 0.4rem;
          background: var(--bg-3);
          border-radius: var(--radius-full);
          font-size: 0.68rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
        }
        .mj-shots-loading {
          padding: var(--space-4) 0;
          justify-content: flex-start;
        }
        .mj-shots-empty {
          padding: var(--space-6) var(--space-4);
          background: var(--bg-1);
          border: 1px dashed var(--hairline-2);
          border-radius: var(--radius);
        }
        .mj-shots {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 0.7rem;
        }

        /* ── 单镜卡片 ── */
        .mj-shot {
          display: flex;
          flex-direction: column;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          overflow: hidden;
          transition: border-color var(--dur) var(--ease),
            transform var(--dur-2) var(--ease),
            box-shadow var(--dur-2) var(--ease);
        }
        .mj-shot:hover {
          border-color: var(--hairline-2);
          transform: translateY(-2px);
          box-shadow: 0 8px 24px -12px var(--bg-sunken);
        }
        /* 草稿态:克制 accent 提示 + 左侧 2px 标记 */
        .mj-shot[data-draft="1"] {
          border-color: var(--accent-line);
          border-left: 2px solid var(--accent);
          background: var(--accent-quiet);
        }
        .mj-shot[data-draft="1"]:hover {
          border-color: var(--accent);
          box-shadow: 0 8px 24px -12px var(--accent-quiet);
        }

        .mj-shot-idx {
          position: absolute;
          top: 6px;
          left: 6px;
          z-index: 2;
          padding: 0.1rem 0.4rem;
          background: var(--bg-sunken);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          border-radius: var(--radius-xs);
          font-size: 0.66rem;
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          color: var(--ink-soft);
        }
        .mj-shot-media {
          position: relative;
          aspect-ratio: 16 / 10;
          background: var(--bg-2);
          overflow: hidden;
        }
        .mj-shot-img,
        .mj-shot-video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .mj-shot-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.35rem;
          color: var(--ink-faint);
          font-size: 0.7rem;
          background: radial-gradient(
            circle at 50% 50%,
            var(--accent-wash),
            transparent 70%
          ),
          var(--bg-2);
        }
        .mj-shot[data-draft="1"] .mj-shot-placeholder {
          color: var(--accent);
        }

        .mj-shot-body {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          padding: 0.7rem 0.8rem 0.75rem;
          flex: 1;
        }
        .mj-shot-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .mj-shot-scene {
          margin: 0;
          font-size: 0.86rem;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.35;
          letter-spacing: -0.01em;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          flex: 1;
          min-width: 0;
        }
        .mj-shot-scene-line {
          margin: 0;
          font-size: 0.72rem;
          color: var(--ink-faint);
          line-height: 1.4;
          display: -webkit-box;
          -webkit-line-clamp: 1;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .mj-shot-scene-line :global(svg) {
          color: var(--accent);
          vertical-align: -0.15em;
          margin-right: 0.2rem;
        }
        .mj-shot-dialogue {
          margin: 0;
          font-size: 0.76rem;
          color: var(--ink-soft);
          font-style: italic;
          line-height: 1.45;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          padding-left: 0.5rem;
          border-left: 2px solid var(--accent-line);
        }
        .mj-shot-tags {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          flex-wrap: wrap;
          margin-top: auto;
          padding-top: 0.2rem;
        }
        .mj-shot-tag {
          display: inline-flex;
          align-items: center;
          gap: 0.2rem;
          padding: 0.08rem 0.4rem;
          background: var(--bg-3);
          border-radius: var(--radius-xs);
          font-size: 0.66rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
        }
        .mj-shot-tag-camera {
          color: var(--accent);
          background: var(--accent-quiet);
        }
        .mj-shot-tag-char {
          color: var(--ink-soft);
          background: var(--bg-2);
          border: 1px solid var(--hairline);
        }
        .mj-shot-tag-dur {
          color: var(--ink-faint);
        }
        .mj-shot-tag-media {
          color: var(--accent);
        }

        /* 单镜操作按钮 */
        .mj-shot-actions {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          flex-wrap: wrap;
          padding-top: 0.4rem;
          margin-top: 0.2rem;
          border-top: 1px dashed var(--hairline);
        }
        .mj-act-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.22rem 0.5rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-xs);
          color: var(--ink-soft);
          font-size: 0.7rem;
          line-height: 1;
          cursor: pointer;
          transition: background-color var(--dur) var(--ease),
            color var(--dur) var(--ease),
            border-color var(--dur) var(--ease);
        }
        .mj-act-btn:hover:not(:disabled) {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent);
        }
        .mj-act-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        /* ── 配音对话框 ── */
        .mj-modal-overlay {
          position: fixed;
          inset: 0;
          z-index: 90;
          display: flex;
          align-items: center;
          justify-content: center;
          background: oklch(3% 0.004 265 / 0.6);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          padding: var(--space-4);
        }
        .mj-modal {
          width: min(560px, 100%);
          max-height: 88vh;
          overflow: auto;
          background: var(--bg-1);
          border: 1px solid var(--accent-line);
          border-radius: var(--radius);
          box-shadow: var(--shadow-lg);
          display: flex;
          flex-direction: column;
        }
        .mj-modal-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          padding: 0.85rem 1rem;
          border-bottom: 1px solid var(--hairline);
        }
        .mj-modal-title {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.92rem;
          font-weight: 600;
          color: var(--ink);
        }
        .mj-modal-title :global(svg) {
          color: var(--accent);
        }
        .mj-modal-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          background: transparent;
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          color: var(--ink-faint);
          cursor: pointer;
        }
        .mj-modal-close:hover {
          color: var(--ink);
          border-color: var(--hairline-2);
        }
        .mj-modal-body {
          display: flex;
          flex-direction: column;
          gap: 0.7rem;
          padding: 1rem;
        }
        .mj-modal-foot {
          display: flex;
          justify-content: flex-end;
          gap: 0.4rem;
          padding: 0.7rem 1rem;
          border-top: 1px solid var(--hairline);
        }
        .mj-voice-ref-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .mj-file-input {
          display: none;
        }
        .mj-voice-ref-name {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          font-size: 0.74rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
          max-width: 220px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .mj-voice-ref-name :global(svg) {
          color: var(--accent);
        }
        .mj-voice-result {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          padding: 0.6rem 0.7rem;
          background: var(--success-quiet);
          border: 1px solid var(--success);
          border-radius: var(--radius-xs);
          color: var(--success);
          font-size: 0.78rem;
        }
        .mj-voice-result :global(svg) {
          color: var(--success);
        }
        .mj-voice-audio {
          width: 100%;
          height: 32px;
        }

        /* ── 旋转动画 ── */
        .mj-spin {
          animation: mj-spin 1s linear infinite;
        }
        @keyframes mj-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .mj-spin {
            animation: none;
          }
        }

        /* ── 滚动条 ── */
        .mj-proj-list::-webkit-scrollbar {
          width: 6px;
        }
        .mj-proj-list::-webkit-scrollbar-thumb {
          background: var(--hairline-2);
          border-radius: 3px;
        }
        .mj-proj-list::-webkit-scrollbar-track {
          background: transparent;
        }

        /* ── 移动端 ── */
        @media (max-width: 880px) {
          .mj-layout {
            grid-template-columns: 1fr;
          }
          .mj-sidebar {
            position: static;
            max-height: none;
          }
          .mj-proj-list {
            max-height: 320px;
          }
          .mj-gen-row {
            grid-template-columns: 1fr;
          }
          .mj-gen-actions {
            justify-content: flex-end;
          }
        }
        @media (max-width: 560px) {
          .mj-header {
            flex-direction: column;
            align-items: stretch;
            gap: var(--space-3);
          }
          .mj-header-right {
            justify-content: space-between;
          }
          .mj-shots {
            grid-template-columns: 1fr;
          }
          .mj-field-row {
            grid-template-columns: 1fr;
          }
          .mj-detail-head-actions {
            width: 100%;
          }
        }
      `}</style>
    </div>
  );
}

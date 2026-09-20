"use client";

/**
 * BoardStoryboard:分镜板 v2/v3(M1+M2,2026-09-21)——画板的分镜视图。
 * 每行 = 镜号 + 缩略图(挂载作品,点击开灯箱) + 分镜文本(失焦保存) + 状态 chip +
 * 操作(挂作品/换作品·生成/重生成·用作参考·上移下移·移出);底部「+ 添加分镜行」追加占位行。
 * 顶部工具行(M2):生成引擎段控(角色锁定/H3 多参考/H3 快速,localStorage 记忆)+
 * 角色条(聚合各行 shot_meta 角色,定妆照缩略图/无定妆照徽标,点击跳主体库)。
 * 整组写全部走 PUT /api/boards/{id}/items(rowsToPutPayload 回带 note/shot_text/shot_meta),
 * 乐观更新+失败回滚;重生成双路径——canRerun 作业走 rerun 端点,其余走 generate 端点
 * (按 shot_meta+角色定妆照提交引擎),轮询新作业 done 后整组换回行内。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import {
  apiFetch,
  authHeaders,
  generateBoardShot,
  imageThumbUrl,
  imageUrl,
  invalidateJobs,
  listEntities,
  lookupJob,
  putBoardItems,
  rerunJob,
  type BoardItemOut,
  type EntityItem,
} from "@/lib/api";
import { canRerun, isVideoKind, kindLabel } from "@/lib/libraryQuery";
import {
  GEN_ENGINES,
  GEN_ENGINE_KEY,
  collectBoardCharacters,
  moveRow,
  parseShotMeta,
  readGenEngine,
  rowsToPutPayload,
  type GenEngineId,
} from "@/lib/storyboard";
import type { JobItem } from "@/lib/types";

interface BoardStoryboardProps {
  boardId: string;
  items: BoardItemOut[];
  onItemsChange: (next: BoardItemOut[]) => void;
  /** 板 item_count 变动同步父级(增删行) */
  onCountChange: (n: number) => void;
  onOpenJob: (jobs: JobItem[], index: number) => void;
  onUseAsInput: (job: JobItem) => void;
  /** 角色条点击 → 跳主体库补定妆照/音色(M2) */
  onOpenEntities?: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  held: "挂起",
  running: "生成中",
  done: "已完成",
  error: "失败",
  canceled: "已取消",
};

export function BoardStoryboard({
  boardId,
  items,
  onItemsChange,
  onCountChange,
  onOpenJob,
  onUseAsInput,
  onOpenEntities,
}: BoardStoryboardProps) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [regenIds, setRegenIds] = useState<Set<number>>(new Set());
  const [pickerRow, setPickerRow] = useState<number | null>(null);
  const [pickerJobs, setPickerJobs] = useState<JobItem[] | null>(null);
  const [engine, setEngine] = useState<GenEngineId>(() => readGenEngine());
  const [castEntities, setCastEntities] = useState<EntityItem[] | null>(null);

  // 角色条:板内角色名/entity_ids → 主体库定妆照映射(挂载拉一次,主体库编辑后重进刷新)
  useEffect(() => {
    let alive = true;
    listEntities("character")
      .then((list) => { if (alive) setCastEntities(list); })
      .catch(() => { /* 主体库拉取失败不阻断分镜编辑 */ });
    return () => { alive = false; };
  }, []);

  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const regenTimers = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map());
  useEffect(() => {
    const timers = regenTimers.current;
    return () => timers.forEach((t) => clearInterval(t));
  }, []);

  /** 整组写:乐观更新 + 失败回滚。返回是否成功。 */
  const commit = useCallback(
    async (next: BoardItemOut[], errMsg: string): Promise<boolean> => {
      const prev = itemsRef.current;
      onItemsChange(next);
      try {
        await putBoardItems(boardId, rowsToPutPayload(next));
        onCountChange(next.length);
        return true;
      } catch (err) {
        onItemsChange(prev);
        toast.error(err instanceof Error ? err.message : errMsg);
        return false;
      }
    },
    [boardId, onCountChange, onItemsChange, toast],
  );

  // ── 分镜文本:失焦保存 ──
  const saveShotText = useCallback(
    async (row: BoardItemOut) => {
      const draft = drafts[row.id];
      if (draft === undefined || draft === row.shot_text) return;
      setSavingId(row.id);
      const next = itemsRef.current.map((it) =>
        it.id === row.id ? { ...it, shot_text: draft } : it,
      );
      await commit(next, "分镜文本保存失败");
      setDrafts((prev) => {
        const cp = { ...prev };
        delete cp[row.id];
        return cp;
      });
      setSavingId(null);
    },
    [commit, drafts],
  );

  // ── 重生成:rerun random 换 seed 重抽 → done 后整组换回行内 ──
  const pollRegen = useCallback(
    (rowId: number, promptId: string) => {
      const tick = async () => {
        try {
          const job = await lookupJob(promptId);
          if (!job || job.status === "queued" || job.status === "running" || job.status === "held") return;
          const timer = regenTimers.current.get(rowId);
          if (timer) clearInterval(timer);
          regenTimers.current.delete(rowId);
          setRegenIds((prev) => {
            const next = new Set(prev);
            next.delete(rowId);
            return next;
          });
          if (job.status === "done") {
            const next = itemsRef.current.map((it) => (it.id === rowId ? { ...it, job } : it));
            onItemsChange(next);
            try {
              await putBoardItems(boardId, rowsToPutPayload(next));
              invalidateJobs();
              toast.success("重生成完成,新作品已挂回分镜行");
            } catch {
              toast.error("重生成成功但挂回画板失败,请手动换作品");
            }
          } else {
            toast.error(job.error || "重生成失败,可再次尝试");
          }
        } catch {
          /* 网络抖动下一拍再试 */
        }
      };
      void tick();
      regenTimers.current.set(rowId, setInterval(() => void tick(), 4000));
    },
    [boardId, onItemsChange, toast],
  );

  const handleRegen = useCallback(
    async (row: BoardItemOut) => {
      if (!row.job || !canRerun(row.job)) return;
      setRegenIds((prev) => new Set(prev).add(row.id));
      try {
        const r = await rerunJob(row.job.id, { seed_mode: "random" });
        pollRegen(row.id, r.prompt_id);
      } catch (err) {
        setRegenIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
        toast.error(err instanceof Error ? err.message : "重生成提交失败");
      }
    },
    [pollRegen, toast],
  );

  // 分镜生成(M2):占位行/非白名单作业行——按 shot_meta+角色定妆照走 generate 端点
  const handleGenerate = useCallback(
    async (row: BoardItemOut) => {
      setRegenIds((prev) => new Set(prev).add(row.id));
      try {
        const r = await generateBoardShot(boardId, row.id, { engine });
        pollRegen(row.id, r.prompt_id);
      } catch (err) {
        setRegenIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
        toast.error(err instanceof Error ? err.message : "分镜生成提交失败");
      }
    },
    [boardId, engine, pollRegen, toast],
  );

  // ── 挂作品:选择器拉最近完成作品 ──
  const openPicker = useCallback(
    async (rowId: number) => {
      setPickerRow(rowId);
      setPickerJobs(null);
      try {
        const res = await apiFetch("/api/jobs?status=done&limit=60", { headers: authHeaders() });
        if (!res.ok) throw new Error(`拉取作品失败 (${res.status})`);
        const body = (await res.json()) as JobItem[] | { jobs?: JobItem[] };
        setPickerJobs(Array.isArray(body) ? body : (body.jobs ?? []));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "拉取作品失败");
        setPickerJobs([]);
      }
    },
    [toast],
  );

  const attachJob = useCallback(
    async (job: JobItem) => {
      if (pickerRow === null) return;
      const next = itemsRef.current.map((it) => (it.id === pickerRow ? { ...it, job } : it));
      setPickerRow(null);
      await commit(next, "挂作品失败");
    },
    [commit, pickerRow],
  );

  const addRow = useCallback(async () => {
    const cur = itemsRef.current;
    const row: BoardItemOut = {
      id: -Date.now(), // 服务器真 id 在下次拉取时替换;PUT 载荷不带 id,临时负 id 可安全乐观渲染
      sort_order: cur.length,
      note: "",
      shot_text: "",
      shot_meta: "",
      job: null,
    };
    await commit([...cur, row], "添加分镜行失败");
  }, [commit]);

  const lightboxJobs = items.filter((it) => it.job !== null).map((it) => it.job as JobItem);
  const openRowLightbox = useCallback(
    (row: BoardItemOut) => {
      if (!row.job) return;
      const idx = lightboxJobs.findIndex((j) => j.id === (row.job as JobItem).id);
      if (idx >= 0) onOpenJob(lightboxJobs, idx);
    },
    [lightboxJobs, onOpenJob],
  );

  const boardChars = collectBoardCharacters(items);

  return (
    <div className="lib-shot-list">
      <div className="lib-shot-toolbar">
        <div className="lib-seg lib-shot-engine" role="tablist" aria-label="生成引擎">
          {GEN_ENGINES.map((e) => (
            <button
              key={e.id}
              type="button"
              title={e.blurb}
              className={`lib-seg-btn${engine === e.id ? " is-active" : ""}`}
              onClick={() => {
                setEngine(e.id);
                try {
                  localStorage.setItem(GEN_ENGINE_KEY, e.id);
                } catch {
                  /* 隐私模式忽略 */
                }
              }}
            >
              {e.label}
            </button>
          ))}
        </div>
        {boardChars.length > 0 && (
          <div className="lib-cast-strip" aria-label="板内角色">
            {boardChars.map((ch) => {
              const ent = ch.entity_id
                ? castEntities?.find((e) => e.id === ch.entity_id)
                : castEntities?.find((e) => e.name === ch.name);
              const hasImage = !!(
                ent && (ent.reference_front || ent.ref_image || ent.reference_side || ent.reference_back)
              );
              const slot = ent?.reference_front ? "front" : "ref";
              return (
                <button
                  key={ch.key}
                  type="button"
                  className="lib-cast-chip"
                  aria-label={`角色: ${ch.name}${ent && hasImage ? "" : "(无定妆照)"}`}
                  title={
                    ent
                      ? hasImage
                        ? `${ch.name}:点击打开主体库`
                        : `${ch.name}:无定妆照,点击去主体库补图`
                      : `${ch.name}:点击打开主体库`
                  }
                  onClick={() => onOpenEntities?.()}
                >
                  {ent && hasImage ? (
                    <img
                      className="lib-cast-chip-img"
                      src={imageUrl(`/api/entities/${ent.id}/images/${slot}`)}
                      alt={ch.name}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <span className="lib-cast-chip-img lib-cast-chip-img--empty">
                      <Icon name="user" size={13} />
                    </span>
                  )}
                  <span className="lib-cast-chip-name">{ch.name}</span>
                  {(!ent || !hasImage) && <span className="lib-cast-chip-noimg">无定妆照</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {items.map((row, idx) => {
        const job = row.job;
        const meta = parseShotMeta(row.shot_meta);
        const hasResult = !!job && job.status === "done" && job.results?.length > 0;
        const regenerating = regenIds.has(row.id);
        const editing = drafts[row.id] ?? row.shot_text;
        const dirty = drafts[row.id] !== undefined && drafts[row.id] !== row.shot_text;
        return (
          <article key={row.id} className={`lib-shot-row${regenerating ? " is-regenerating" : ""}`}>
            <div className="lib-shot-idx" aria-hidden="true">
              {String(idx + 1).padStart(2, "0")}
            </div>

            <div className="lib-shot-thumb">
              {job && hasResult ? (
                <button
                  type="button"
                  className="lib-shot-thumb-hit"
                  aria-label={`预览第 ${idx + 1} 镜作品`}
                  onClick={() => openRowLightbox(row)}
                >
                  {isVideoKind(job.kind) ? (
                    <video src={imageUrl(job.results[0])} muted playsInline preload="metadata" />
                  ) : (
                    <img src={imageThumbUrl(job.results[0])} alt={job.prompt} loading="lazy" decoding="async" />
                  )}
                </button>
              ) : (
                <span className="lib-shot-thumb-empty">
                  <Icon name={job ? "loading" : "film"} size={22} strokeWidth={1.4} />
                </span>
              )}
            </div>

            <div className="lib-shot-body">
              <textarea
                className="lib-shot-text"
                value={editing}
                placeholder="分镜文本(场景/台词/运镜)…"
                aria-label={`分镜文本: 第 ${idx + 1} 镜`}
                rows={3}
                maxLength={2000}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                onBlur={() => void saveShotText(row)}
              />
              <div className="lib-shot-meta-line">
                {meta?.duration_sec ? <span className="lib-shot-chip">约 {meta.duration_sec}s</span> : null}
                {meta?.characters?.length ? (
                  <span className="lib-shot-chip">{meta.characters.join(" · ")}</span>
                ) : null}
                {job ? <span className="lib-shot-chip">{kindLabel(job.kind)}</span> : null}
                {savingId === row.id ? <span className="lib-shot-saving">保存中…</span> : null}
                {dirty ? <span className="lib-shot-saving">未保存</span> : null}
              </div>
            </div>

            <div className="lib-shot-side">
              <span className={`lib-shot-status is-${job?.status ?? "empty"}`}>
                {regenerating ? "重生成中…" : job ? (STATUS_LABEL[job.status] ?? job.status) : "待挂作品"}
              </span>
              <div className="lib-shot-ops">
                <button
                  type="button"
                  className="lib-shot-op"
                  title={job ? "换作品(从作品库选择)" : "挂作品(从作品库选择)"}
                  aria-label={`${job ? "换作品" : "挂作品"}: 第 ${idx + 1} 镜`}
                  onClick={() => void openPicker(row.id)}
                >
                  <Icon name="upload" size={14} />
                </button>
                {job && canRerun(job) ? (
                  <button
                    type="button"
                    className="lib-shot-op"
                    title="重生成(rerun 换 seed 重抽)"
                    aria-label={`重生成: 第 ${idx + 1} 镜`}
                    disabled={regenerating}
                    onClick={() => void handleRegen(row)}
                  >
                    <Icon name="refresh" size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="lib-shot-op"
                    title={
                      meta?.prompt?.trim() || row.shot_text.trim()
                        ? `${job ? "重生成" : "生成"}(${GEN_ENGINES.find((e) => e.id === engine)?.label ?? engine})`
                        : "先填分镜文本再生成"
                    }
                    aria-label={job ? `重生成: 第 ${idx + 1} 镜` : `生成分镜: 第 ${idx + 1} 镜`}
                    disabled={regenerating || !(meta?.prompt?.trim() || row.shot_text.trim())}
                    onClick={() => void handleGenerate(row)}
                  >
                    <Icon name="refresh" size={14} />
                  </button>
                )}
                {job && hasResult ? (
                  <button
                    type="button"
                    className="lib-shot-op"
                    title="用作参考(生成台自动填入媒体槽)"
                    aria-label={`用作输入: 第 ${idx + 1} 镜`}
                    onClick={() => onUseAsInput(job)}
                  >
                    <Icon name="send" size={14} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="lib-shot-op"
                  title="上移"
                  aria-label={`上移: 第 ${idx + 1} 镜`}
                  disabled={idx === 0}
                  onClick={() => void commit(moveRow(itemsRef.current, idx, idx - 1), "排序保存失败")}
                >
                  <Icon name="chevron-up" size={14} />
                </button>
                <button
                  type="button"
                  className="lib-shot-op"
                  title="下移"
                  aria-label={`下移: 第 ${idx + 1} 镜`}
                  disabled={idx === items.length - 1}
                  onClick={() => void commit(moveRow(itemsRef.current, idx, idx + 1), "排序保存失败")}
                >
                  <Icon name="chevron-down" size={14} />
                </button>
                <button
                  type="button"
                  className="lib-shot-op lib-shot-op--danger"
                  title="移出画板(作品保留在作品库)"
                  aria-label={`移出分镜: 第 ${idx + 1} 镜`}
                  onClick={() =>
                    void commit(itemsRef.current.filter((it) => it.id !== row.id), "移出失败")
                  }
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          </article>
        );
      })}

      <div className="lib-shot-add-row">
        <Button variant="secondary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => void addRow()}>
          添加分镜行
        </Button>
      </div>

      {pickerRow !== null ? (
        <div className="lib-source-scrim" onClick={() => setPickerRow(null)}>
          <div
            className="lib-source-pop lib-shot-picker"
            role="dialog"
            aria-label="选择作品"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lib-shot-picker-title">选择要挂上的作品</div>
            {pickerJobs === null ? (
              <div className="lib-board-empty">加载中…</div>
            ) : pickerJobs.length === 0 ? (
              <div className="lib-board-empty">作品库还没有已完成的作品</div>
            ) : (
              <div className="lib-shot-picker-grid">
                {pickerJobs.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    className="lib-shot-picker-item"
                    aria-label={`选择作品: ${(j.prompt || "无提示词").slice(0, 30)}`}
                    onClick={() => void attachJob(j)}
                  >
                    {j.results?.length ? (
                      isVideoKind(j.kind) ? (
                        <video src={imageUrl(j.results[0])} muted playsInline preload="metadata" />
                      ) : (
                        <img src={imageThumbUrl(j.results[0])} alt={j.prompt} loading="lazy" decoding="async" />
                      )
                    ) : (
                      <span className="lib-shot-thumb-empty"><Icon name="image" size={20} strokeWidth={1.4} /></span>
                    )}
                    <span className="lib-shot-picker-prompt">{j.prompt || "(无提示词)"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

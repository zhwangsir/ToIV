"use client";

/**
 * BoardsView:手动主题板(2026-09-21 用户拍板,纯本地组织工具)。
 *
 * 两个视图态:板列表(封面卡+hover 删除+新建+剧本拆镜) ↔ 板详情(网格/分镜双模式)。
 * 网格模式:成员卡复用作品卡视觉,动作=用作参考(assetPick)/打开灯箱/移除;
 * 分镜模式(M1):BoardStoryboard 行编辑(分镜文本/挂作品/单镜重生成/排序)。
 * 新建/删除/改名走二次确认 Modal 既有范式(删除=danger 基座,明示不删成员作品);
 * 板卡与详情页共用同一 handleDeleteBoard 执行函数;详情面包屑带「导出 drama_studio」JSON 下载。
 */
import { useCallback, useEffect, useState } from "react";

import { BoardStoryboard } from "@/components/library/BoardStoryboard";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  createBoard,
  createBoardFromScript,
  deleteBoard,
  exportBoard,
  fetchBoardItems,
  fetchBoards,
  imageThumbUrl,
  putBoardItems,
  type BoardItemOut,
  type BoardOut,
} from "@/lib/api";
import { triggerDownload } from "@/lib/storyboard";
import type { JobItem } from "@/lib/types";

interface BoardsViewProps {
  onBack: () => void;
  /** 打开成员作品灯箱(父级把板成员设为灯箱 scope) */
  onOpenJob: (jobs: JobItem[], index: number) => void;
  /** 板内作品直引为生成台媒体槽(复用作品库 assetPick) */
  onUseAsInput: (job: JobItem) => void;
  /** 分镜角色条点击 → 跳主体库(M2) */
  onOpenEntities?: () => void;
}

export function BoardsView({ onBack, onOpenJob, onUseAsInput, onOpenEntities }: BoardsViewProps) {
  const toast = useToast();
  const [boards, setBoards] = useState<BoardOut[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openBoard, setOpenBoard] = useState<BoardOut | null>(null);
  const [items, setItems] = useState<BoardItemOut[] | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmDeleteBoard, setConfirmDeleteBoard] = useState<BoardOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "story">("grid");
  const [exporting, setExporting] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [scriptText, setScriptText] = useState("");
  const [scriptShots, setScriptShots] = useState(8);
  const [scriptStyle, setScriptStyle] = useState("");
  const [scriptBusy, setScriptBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchBoards()
      .then(setBoards)
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const loadItems = useCallback((boardId: string) => {
    fetchBoardItems(boardId)
      .then(setItems)
      .catch((err) => toast.error(err instanceof Error ? err.message : "加载成员失败"));
  }, [toast]);

  const openDetail = useCallback(
    (b: BoardOut, mode: "grid" | "story" = "grid") => {
      setOpenBoard(b);
      setViewMode(mode);
      setItems(null);
      loadItems(b.id);
    },
    [loadItems],
  );

  // 剧本拆镜(M1):LLM 拆剧本 → 建板+占位分镜行 → 直接进分镜模式
  const handleFromScript = useCallback(async () => {
    const script = scriptText.trim();
    if (!script) return;
    setScriptBusy(true);
    try {
      const { board, item_count } = await createBoardFromScript({
        script,
        num_shots: scriptShots,
        style: scriptStyle.trim(),
      });
      setBoards((prev) => [board, ...(prev ?? [])]);
      setShowScript(false);
      setScriptText("");
      setScriptStyle("");
      toast.success(`拆镜完成:「${board.name}」已建 ${item_count} 个分镜行`);
      openDetail(board, "story");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "剧本拆镜失败");
    } finally {
      setScriptBusy(false);
    }
  }, [scriptText, scriptShots, scriptStyle, openDetail, toast]);

  // 整板导出 drama_studio 格式 JSON 下载
  const handleExport = useCallback(async () => {
    if (!openBoard) return;
    setExporting(true);
    try {
      const doc = await exportBoard(openBoard.id);
      triggerDownload(`${openBoard.name}.drama_studio.json`, doc);
      toast.success("已导出 drama_studio 格式 JSON");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }, [openBoard, toast]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const b = await createBoard(name);
      setBoards((prev) => [b, ...(prev ?? [])]);
      setNewName("");
      toast.success(`画板「${name}」已创建`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败");
    } finally {
      setCreating(false);
    }
  }, [newName, toast]);

  const handleDeleteBoard = useCallback(async () => {
    if (!confirmDeleteBoard) return;
    setBusy(true);
    try {
      await deleteBoard(confirmDeleteBoard.id);
      setBoards((prev) => (prev ?? []).filter((b) => b.id !== confirmDeleteBoard.id));
      if (openBoard?.id === confirmDeleteBoard.id) setOpenBoard(null);
      toast.success(`画板「${confirmDeleteBoard.name}」已删除(作品保留在作品库)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
      setConfirmDeleteBoard(null);
    }
  }, [confirmDeleteBoard, openBoard, toast]);

  const removeItem = useCallback(
    async (item: BoardItemOut) => {
      if (!openBoard || !items) return;
      const next = items.filter((it) => it.id !== item.id);
      setItems(next); // 乐观更新,失败回滚
      try {
        await putBoardItems(
          openBoard.id,
          next.map((it) => ({
            job_id: it.job?.id ?? "",
            note: it.note,
            shot_text: it.shot_text,
            shot_meta: it.shot_meta,
          })),
        );
        setBoards((prev) =>
          (prev ?? []).map((b) =>
            b.id === openBoard.id ? { ...b, item_count: next.length } : b,
          ),
        );
      } catch (err) {
        setItems(items);
        toast.error(err instanceof Error ? err.message : "移除失败");
      }
    },
    [items, openBoard, toast],
  );

  // 灯箱 scope 只含有作品的成员(占位分镜行无 job)
  const memberJobs = (items ?? []).filter((it) => it.job !== null).map((it) => it.job as JobItem);

  // ── 板详情 ──
  if (openBoard) {
    return (
      <div className="lib-boards">
        <nav className="lib-breadcrumb" aria-label="位置">
          <button type="button" className="lib-breadcrumb-back" onClick={() => setOpenBoard(null)}>
            <Icon name="chevron-left" size={14} />
            全部画板
          </button>
          <span className="lib-breadcrumb-sep" aria-hidden="true">/</span>
          <span className="lib-breadcrumb-current">{openBoard.name}</span>
          <span className="lib-board-count">{items?.length ?? openBoard.item_count} 件</span>
          <span className="lib-board-spacer" />
          <div className="lib-seg lib-board-viewseg" role="tablist" aria-label="画板视图">
            <button
              type="button"
              className={`lib-seg-btn${viewMode === "grid" ? " is-active" : ""}`}
              onClick={() => setViewMode("grid")}
            >
              网格
            </button>
            <button
              type="button"
              className={`lib-seg-btn${viewMode === "story" ? " is-active" : ""}`}
              onClick={() => setViewMode("story")}
            >
              分镜
            </button>
          </div>
          <Button
            size="sm" variant="secondary" icon={<Icon name="download" size={14} />}
            loading={exporting}
            onClick={() => void handleExport()}
          >
            导出 drama_studio
          </Button>
          <Button
            size="sm" variant="ghost" icon={<Icon name="delete" size={14} />}
            onClick={() => setConfirmDeleteBoard(openBoard)}
          >
            删除画板
          </Button>
          <Button size="sm" variant="secondary" icon={<Icon name="chevron-left" size={14} />} onClick={onBack}>
            返回作品库
          </Button>
        </nav>

        {items === null ? (
          <div className="lib-board-empty">加载中…</div>
        ) : viewMode === "story" ? (
          <BoardStoryboard
            boardId={openBoard.id}
            items={items}
            onItemsChange={setItems}
            onCountChange={(n) =>
              setBoards((prev) =>
                (prev ?? []).map((b) => (b.id === openBoard.id ? { ...b, item_count: n } : b)),
              )
            }
            onOpenJob={onOpenJob}
            onUseAsInput={onUseAsInput}
            onOpenEntities={onOpenEntities}
            onRefreshItems={() => loadItems(openBoard.id)}
            onRemixed={(b) => {
              load();
              openDetail(b, "story");
            }}
          />
        ) : items.length === 0 ? (
          <div className="lib-board-empty">
            <Icon name="layers" size={28} strokeWidth={1.4} />
            <p>这个画板还没有作品</p>
            <p className="lib-board-empty-hint">回到作品库,把作品「移入画板」即可聚合到这里</p>
          </div>
        ) : (
          <div className="lib-grid">
            {items.map((it) => {
              const job = it.job;
              if (!job) {
                // 占位分镜行:网格模式显示文本卡(编辑请切分镜模式)
                return (
                  <article key={it.id} className="lib-card lib-board-item-card">
                    <div className="lib-thumb">
                      <span className="lib-thumb-placeholder-icon"><Icon name="film" size={26} strokeWidth={1.4} /></span>
                      <div className="lib-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button" className="lib-action-btn lib-action-btn--danger"
                          title="移出画板"
                          aria-label="移出画板"
                          onClick={() => void removeItem(it)}
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                    </div>
                    <div className="lib-foot">
                      <div className="lib-card-title" title={it.shot_text}>{it.shot_text || "(空分镜行)"}</div>
                    </div>
                  </article>
                );
              }
              const hasResult = job.status === "done" && job.results?.length > 0;
              const lbIdx = memberJobs.findIndex((j) => j.id === job.id);
              return (
                <article key={it.id} className="lib-card lib-board-item-card">
                  <div className="lib-thumb">
                    <button
                      type="button"
                      className="lib-thumb-hit"
                      aria-label={`预览作品: ${job.prompt || "无提示词"}`}
                      onClick={() => lbIdx >= 0 && onOpenJob(memberJobs, lbIdx)}
                    >
                      {hasResult ? (
                        <img src={imageThumbUrl(job.results[0])} alt={job.prompt} loading="lazy" decoding="async" />
                      ) : (
                        <span className="lib-thumb-placeholder-icon"><Icon name="image" size={26} strokeWidth={1.4} /></span>
                      )}
                    </button>
                    <div className="lib-actions" onClick={(e) => e.stopPropagation()}>
                      {hasResult && (
                        <button
                          type="button" className="lib-action-btn"
                          title="用作参考(生成台自动填入媒体槽)"
                          aria-label={`用作输入: ${job.prompt || "无提示词"}`}
                          onClick={() => onUseAsInput(job)}
                        >
                          <Icon name="send" size={14} />
                        </button>
                      )}
                      <button
                        type="button" className="lib-action-btn lib-action-btn--danger"
                        title="移出画板(作品保留在作品库)"
                        aria-label="移出画板"
                        onClick={() => void removeItem(it)}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="lib-foot">
                    <div className="lib-card-title" title={job.prompt}>{job.prompt || "(无提示词)"}</div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── 板列表 ──
  return (
    <div className="lib-boards">
      <nav className="lib-breadcrumb" aria-label="位置">
        <button type="button" className="lib-breadcrumb-back" onClick={onBack}>
          <Icon name="chevron-left" size={14} />
          作品库
        </button>
        <span className="lib-breadcrumb-sep" aria-hidden="true">/</span>
        <span className="lib-breadcrumb-current">画板</span>
        <span className="lib-board-count">{boards?.length ?? 0} 个</span>
      </nav>

      <div className="lib-board-new">
        <input
          className="lib-board-new-input"
          value={newName}
          placeholder="新建画板(如:电商套图 / 漫剧分镜 / 灵感)…"
          aria-label="新建画板名称"
          maxLength={64}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
        />
        <Button variant="primary" size="sm" loading={creating} disabled={!newName.trim()} onClick={() => void handleCreate()}>
          新建
        </Button>
        <Button
          variant="secondary" size="sm" icon={<Icon name="wand" size={14} />}
          onClick={() => setShowScript(true)}
        >
          剧本拆镜
        </Button>
      </div>

      {error ? (
        <div className="lib-board-empty">{error}</div>
      ) : loading ? (
        <div className="lib-board-empty">加载中…</div>
      ) : (boards ?? []).length === 0 ? (
        <div className="lib-board-empty">
          <Icon name="layers" size={28} strokeWidth={1.4} />
          <p>还没有画板</p>
          <p className="lib-board-empty-hint">画板是把作品聚成主题集的手动组织工具(如电商套图、漫剧分镜、风格灵感)</p>
        </div>
      ) : (
        <div className="lib-grid">
          {(boards ?? []).map((b) => (
            <article key={b.id} className="lib-card lib-board-card">
              <div className="lib-thumb">
                <button
                  type="button"
                  className="lib-thumb-hit"
                  aria-label={`打开画板: ${b.name}`}
                  onClick={() => openDetail(b)}
                >
                  {b.cover_url ? (
                    <img src={imageThumbUrl(b.cover_url)} alt={b.name} loading="lazy" decoding="async" />
                  ) : (
                    <span className="lib-thumb-placeholder-icon"><Icon name="layers" size={26} strokeWidth={1.4} /></span>
                  )}
                </button>
                <span className="lib-stack-badge" aria-hidden="true">
                  <Icon name="library" size={11} />
                  {b.item_count} 件
                </span>
                <div className="lib-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button" className="lib-action-btn lib-action-btn--danger"
                    title="删除画板(不删成员作品)"
                    aria-label={`删除画板: ${b.name}`}
                    onClick={() => setConfirmDeleteBoard(b)}
                  >
                    <Icon name="delete" size={13} />
                  </button>
                </div>
              </div>
              <div className="lib-foot">
                <div className="lib-card-title" title={b.name}>{b.name}</div>
                {b.description && <div className="lib-card-sub" title={b.description}>{b.description}</div>}
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={!!confirmDeleteBoard}
        onClose={() => setConfirmDeleteBoard(null)}
        title={`删除画板「${confirmDeleteBoard?.name ?? ""}」?`}
        danger
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDeleteBoard(null)}>取消</Button>
            <Button variant="danger" loading={busy} onClick={() => void handleDeleteBoard()}>删除画板</Button>
          </>
        }
      >
        画板仅删除组织,不删成员作品:板内作品只解除聚合关系,保留在作品库。
      </Modal>

      <Modal
        open={showScript}
        onClose={() => !scriptBusy && setShowScript(false)}
        title="剧本拆镜(LLM 自动分镜)"
        footer={
          <>
            <Button variant="ghost" disabled={scriptBusy} onClick={() => setShowScript(false)}>取消</Button>
            <Button
              variant="primary"
              loading={scriptBusy}
              disabled={!scriptText.trim()}
              onClick={() => void handleFromScript()}
            >
              开始拆镜
            </Button>
          </>
        }
      >
        <div className="lib-script-form">
          <textarea
            className="lib-script-textarea"
            value={scriptText}
            placeholder="粘贴剧本或剧情大纲,LLM 自动拆成 N 个分镜行(约 20-30 秒)…"
            aria-label="剧本文本"
            rows={8}
            maxLength={20000}
            disabled={scriptBusy}
            onChange={(e) => setScriptText(e.target.value)}
          />
          <div className="lib-script-fields">
            <label className="lib-script-field">
              镜头数
              <input
                type="number"
                min={1}
                max={50}
                value={scriptShots}
                aria-label="镜头数"
                disabled={scriptBusy}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setScriptShots(Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 8);
                }}
              />
            </label>
            <label className="lib-script-field lib-script-field--grow">
              风格(可选)
              <input
                type="text"
                value={scriptStyle}
                placeholder="如: cinematic / 日系动画 / 写实胶片"
                aria-label="风格(可选)"
                maxLength={2000}
                disabled={scriptBusy}
                onChange={(e) => setScriptStyle(e.target.value)}
              />
            </label>
          </div>
          <p className="lib-script-hint">拆镜结果建成新画板并进入分镜模式;占位行可逐镜挂作品、重生成。</p>
        </div>
      </Modal>
    </div>
  );
}

"use client";

/**
 * BoardsView:手动主题板(2026-09-21 用户拍板,纯本地组织工具)。
 *
 * 两个视图态:板列表(封面卡+新建) ↔ 板详情(成员网格)。
 * 详情内成员卡复用作品卡视觉,动作=用作参考(assetPick,父级 handleUseAsInput 喂引擎)/
 * 打开灯箱(父级 lightbox-scope)/移除(整组 PUT 重排);新建/删除/改名走二次确认 Modal 既有范式。
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  createBoard,
  deleteBoard,
  fetchBoardItems,
  fetchBoards,
  imageThumbUrl,
  putBoardItems,
  type BoardItemOut,
  type BoardOut,
} from "@/lib/api";
import type { JobItem } from "@/lib/types";

interface BoardsViewProps {
  onBack: () => void;
  /** 打开成员作品灯箱(父级把板成员设为灯箱 scope) */
  onOpenJob: (jobs: JobItem[], index: number) => void;
  /** 板内作品直引为生成台媒体槽(复用作品库 assetPick) */
  onUseAsInput: (job: JobItem) => void;
}

export function BoardsView({ onBack, onOpenJob, onUseAsInput }: BoardsViewProps) {
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
    (b: BoardOut) => {
      setOpenBoard(b);
      setItems(null);
      loadItems(b.id);
    },
    [loadItems],
  );

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
          next.map((it) => ({ job_id: it.job.id, note: it.note, shot_text: it.shot_text })),
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

  const memberJobs = (items ?? []).map((it) => it.job);

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
        ) : items.length === 0 ? (
          <div className="lib-board-empty">
            <Icon name="layers" size={28} strokeWidth={1.4} />
            <p>这个画板还没有作品</p>
            <p className="lib-board-empty-hint">回到作品库,把作品「移入画板」即可聚合到这里</p>
          </div>
        ) : (
          <div className="lib-grid">
            {items.map((it, idx) => {
              const job = it.job;
              const hasResult = job.status === "done" && job.results?.length > 0;
              return (
                <article key={it.id} className="lib-card lib-board-item-card">
                  <div className="lib-thumb">
                    <button
                      type="button"
                      className="lib-thumb-hit"
                      aria-label={`预览作品: ${job.prompt || "无提示词"}`}
                      onClick={() => onOpenJob(memberJobs, idx)}
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
        板内作品只解除聚合关系,保留在作品库,不会删除。
      </Modal>
    </div>
  );
}

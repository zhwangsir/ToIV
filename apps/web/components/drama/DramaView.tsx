"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useAutoResize } from "@/hooks/useAutoResize";
import { useDramaProject } from "@/hooks/useDramaProject";
import { DramaWorkbench } from "@/components/drama/workbench/DramaWorkbench";
import { useR18Mode } from "@/lib/r18";
import {
  listDramaProjects,
  createDramaProject,
  deleteDramaProject,
  type DramaProjectSummary,
} from "@/lib/api";

/**
 * 主站「短剧」视图(M9:NSFW 整合主站,自 /nsfw 专区 NsfwDramaView 迁移)。
 *
 * 不再是专区 tab,而是主站一级视图,仅 R18 模式可见(page.tsx 导航项与 URL
 * 双重门控);drama 旧管线(非 M4 studio)的紧凑工作台,覆盖核心创作流:
 *   项目 → 剧本 → AI 拆分镜 → 单镜/批量视频生成(v2 模型选择)→ 末帧续写
 *   → 配音 → 对口型 → 合成成片。
 * nsfw 打标跟随全局 R18 模式:useDramaProject({ nsfw: r18 }) 使
 * generate-video(v1/v2)/continue-video 请求体带 nsfw 标记(视图仅 R18 模式可达,
 * 实践中恒 true,但保持动态跟随);X-NSFW 头由 lib/r18 的 setNsfwIntent 全局注入,
 * 产物 Job 打标 nsfw,仅 R18 模式下的作品库可见。
 */
export function DramaView() {
  const { show: showToast } = useToast();
  const [projects, setProjects] = useState<DramaProjectSummary[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPremise, setNewPremise] = useState("");
  // 新建项目梗概自动增高;侧栏在 100vh 定高链内(.nsfw-drama-root overflow:hidden),
  // 留 40vh 宽松封顶避免超长梗概把项目列表挤出可视区
  const newPremiseRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(newPremiseRef, newPremise, { maxVh: 40 });

  // ── 项目列表 ──
  // 批 D:失败不再只 toast —— 列表区给持久错误态 + 重试(假空态通病 P1-8 同类)
  const [listError, setListError] = useState<string | null>(null);
  const reloadProjects = useCallback(() => {
    setListError(null);
    listDramaProjects()
      .then((list) => setProjects(list))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : "加载项目失败";
        setListError(msg);
        showToast("error", msg);
      });
  }, [showToast]);

  useEffect(() => {
    reloadProjects();
  }, [reloadProjects]);

  // hook 内状态变化(拆分镜/合成等)同步回项目列表摘要
  const handleSummaryChange = useCallback(
    (id: string, patch: Partial<DramaProjectSummary>) => {
      setProjects((prev) =>
        prev ? prev.map((p) => (p.id === id ? { ...p, ...patch } : p)) : prev,
      );
    },
    [],
  );

  // nsfw 打标跟随全局 R18 模式(本视图仅 R18 模式可达,实践中恒 true)
  const [r18] = useR18Mode();
  const dp = useDramaProject(activeId, handleSummaryChange, { nsfw: r18 });

  // ── 新建项目 ──
  const handleCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const p = await createDramaProject({
        title,
        premise: newPremise.trim() || undefined,
      });
      setNewTitle("");
      setNewPremise("");
      reloadProjects();
      setActiveId(p.id);
      showToast("success", `项目「${p.title}」已创建`);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "创建项目失败");
    } finally {
      setCreating(false);
    }
  }, [newTitle, newPremise, creating, reloadProjects, showToast]);

  // ── 删除项目 ──
  const [confirmDelete, setConfirmDelete] = useState<DramaProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback((p: DramaProjectSummary) => {
    setConfirmDelete(p);
  }, []);

  const doDelete = useCallback(async () => {
    if (!confirmDelete || deleting) return;
    setDeleting(true);
    try {
      await deleteDramaProject(confirmDelete.id);
      if (activeId === confirmDelete.id) setActiveId(null);
      reloadProjects();
      showToast("success", `项目「${confirmDelete.title}」已删除`);
      setConfirmDelete(null);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "删除项目失败");
    } finally {
      setDeleting(false);
    }
  }, [confirmDelete, deleting, activeId, reloadProjects, showToast]);

  const wbOpen = Boolean(activeId && dp.current);

  return (
    <div className={`nsfw-drama-root${wbOpen ? " wb-open" : ""}`}>
      {/* ── 统一页头(批 D 收编为 PageHeader 组件);工作台打开时让位全高 ── */}
      {!wbOpen && (
        <PageHeader
          title="短剧工作台"
          desc="剧本 → 分镜 → 视频 → 配音 → 成片,一站式短剧管线;产物按全局内容模式打标"
        />
      )}

      <div className="nsfw-drama">
      {/* ── 左侧:项目列表 + 新建;工作台打开时收成窄轨(LibTV 单栏让位)── */}
      {wbOpen ? (
        <aside className="nsfw-drama-side nsfw-drama-rail">
          <button
            type="button"
            className="nsfw-drama-rail-btn"
            title="返回项目列表"
            onClick={() => setActiveId(null)}
          >
            <Icon name="clapperboard" size={16} />
          </button>
          <button
            type="button"
            className="nsfw-drama-rail-btn"
            /* 批 D 修正误导 title:按钮并不直接建项目,而是回列表页(新建表单在列表页) */
            title="回列表页新建项目"
            onClick={() => setActiveId(null)}
          >
            <Icon name="plus" size={16} />
          </button>
        </aside>
      ) : (
      <aside className="nsfw-drama-side">
        <div className="nsfw-drama-side-head">
          <Icon name="clapperboard" size={16} />
          <span>短剧项目</span>
        </div>
        <div className="nsfw-drama-create">
          <input
            className="nsfw-drama-input"
            placeholder="项目标题"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            maxLength={60}
          />
          <textarea
            ref={newPremiseRef}
            className="nsfw-drama-input nsfw-drama-textarea"
            placeholder="故事梗概(可选)"
            value={newPremise}
            onChange={(e) => setNewPremise(e.target.value)}
            rows={2}
          />
          <button
            type="button"
            className="btn btn-primary nsfw-drama-create-btn"
            disabled={!newTitle.trim() || creating}
            onClick={handleCreate}
          >
            <Icon name="plus" size={14} />
            {creating ? "创建中…" : "新建项目"}
          </button>
        </div>
        <div className="nsfw-drama-list">
          {projects === null && !listError && <LoadingBlock variant="line" count={3} />}
          {/* 列表加载失败:持久错误条 + 重试(复用既有 .nsfw-drama-error 样式),
              toast 仍有(工作台打开时列表不可见,需瞬时信号) */}
          {listError && (
            <div className="nsfw-drama-error" role="alert">
              <span>{listError}</span>
              <button type="button" onClick={reloadProjects}>
                重试
              </button>
            </div>
          )}
          {!listError && projects !== null && projects.length === 0 && (
            <div className="nsfw-drama-hint">暂无项目,先新建一个</div>
          )}
          {projects?.map((p) => (
            <div
              key={p.id}
              className={`nsfw-drama-item${p.id === activeId ? " is-active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => setActiveId(p.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveId(p.id);
              }}
            >
              <div className="nsfw-drama-item-main">
                <div className="nsfw-drama-item-title">{p.title}</div>
                <div className="nsfw-drama-item-sub">
                  {p.status}
                  {p.video_url ? " · 已出片" : ""}
                </div>
              </div>
              <button
                type="button"
                className="nsfw-drama-item-del"
                title="删除项目"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(p);
                }}
              >
                <Icon name="delete" size={13} />
              </button>
            </div>
          ))}
        </div>
      </aside>
      )}

      {/* ── 右侧:项目工作台 ── */}
      <section className="nsfw-drama-main">
        {!activeId && (
          <div className="empty-state nsfw-drama-empty">
            <div className="empty-state-icon">
              <Icon name="clapperboard" size={48} strokeWidth={1.1} />
            </div>
            <div className="empty-state-title">选择或新建一个短剧项目</div>
            <div className="empty-state-desc">
              从左侧选择已有项目继续创作,或先新建一个项目
            </div>
          </div>
        )}
        {activeId && dp.loading && <LoadingBlock variant="line" count={4} />}
        {activeId && dp.error && (
          <ErrorBar message={dp.error} onClose={() => dp.reload()} />
        )}
        {activeId && dp.current && <DramaWorkbench key={dp.current.id} dp={dp} />}
        {/* 兜底:非加载中/无错误但详情缺失(老数据/竞态)——给可见提示而非静默空白 */}
        {activeId && !dp.loading && !dp.error && !dp.current && (
          <div className="nsfw-drama-hint">
            项目详情为空或未加载,
            <button type="button" onClick={() => dp.reload()}>
              点击重新加载
            </button>
          </div>
        )}
      </section>
      </div>

      {/* 删除项目确认(替代原生 window.confirm) */}
      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="删除项目"
        danger
        preventClose={deleting}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={deleting}
              onClick={() => setConfirmDelete(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              icon={<Icon name="delete" size={14} />}
              onClick={() => void doDelete()}
            >
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          删除项目「{confirmDelete?.title}」?该操作不可恢复。
        </p>
      </Modal>

      <style jsx>{`
        .nsfw-drama-root {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          background: var(--bg-canvas);
          /* 定高约束(壳层 .app-main padding-top:56px 让位 CornerNav;.view-root
             非 flex 父级,flex:1 拿不到高度):整条链定高 → 工作台内部区域各自
             滚动,短片阶段底部胶片条恒在视口内钉底 */
          height: calc(100vh - 56px);
          height: calc(100dvh - 56px);
          overflow: hidden;
        }
        /* 统一页头在双栏布局内的落位:与内容左右对齐,不参与滚动 */
        .nsfw-drama-root > .page-header {
          flex-shrink: 0;
          /* 2026-08-24 排版统一:水平槽 --page-gutter,页头下距 --section-gap */
          padding: var(--space-3) var(--page-gutter) 0;
          margin-bottom: var(--section-gap);
        }
        .nsfw-drama {
          flex: 1;
          min-height: 0;
          display: flex;
          background: var(--bg-canvas);
        }
        .nsfw-drama-side {
          width: 300px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          border-right: 1px solid var(--border-subtle);
          background: var(--bg-surface-1);
          min-height: 0;
        }
        /* 工作台打开:外层页头隐藏(顶高还给工作台),侧栏收成 52px 窄轨 */
        .nsfw-drama-root.wb-open > .nsfw-drama > .nsfw-drama-rail {
          width: 52px;
          align-items: center;
          padding-top: var(--space-3);
          gap: var(--space-2);
        }
        .nsfw-drama-rail-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
          transition: color var(--duration-base) var(--ease-standard),
            border-color var(--duration-base) var(--ease-standard);
        }
        .nsfw-drama-rail-btn:hover {
          color: var(--text-primary);
          border-color: var(--border-strong);
        }
        .nsfw-drama-side-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-4) var(--space-5);
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          line-height: 1.4;
          color: var(--text-primary);
        }
        /* 新建表单:浮动卡片,与列表拉开层级 */
        .nsfw-drama-create {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          margin: 0 var(--space-3) var(--space-3);
          padding: var(--space-4);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
        }
        .nsfw-drama-input {
          width: 100%;
          padding: var(--space-3);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-body);
          line-height: 1.5;
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .nsfw-drama-input::placeholder {
          color: var(--text-muted);
        }
        .nsfw-drama-input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .nsfw-drama-input:hover:not(:focus) {
          border-color: var(--border-strong);
        }
        .nsfw-drama-textarea {
          resize: vertical;
          font-family: inherit;
        }
        .nsfw-drama-create-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-1);
        }
        .nsfw-drama-list {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: var(--space-3);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .nsfw-drama-item {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-3);
          border-radius: var(--radius-control);
          cursor: pointer;
          border: 1px solid var(--border-subtle);
          background: var(--bg-surface-1);
          transition: background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard);
        }
        .nsfw-drama-item:hover {
          background: var(--bg-surface-2);
          border-color: var(--border-strong);
          box-shadow: var(--shadow-sm);
          transform: translateY(-1px);
        }
        .nsfw-drama-item.is-active {
          background: var(--accent-soft);
          border-color: var(--accent);
          box-shadow: none;
          transform: none;
        }
        .nsfw-drama-item-main {
          flex: 1;
          min-width: 0;
        }
        .nsfw-drama-item-title {
          font-size: var(--text-body);
          font-weight: var(--font-semibold);
          line-height: 1.4;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nsfw-drama-item-sub {
          margin-top: 2px;
          font-size: var(--text-label);
          line-height: 1.4;
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nsfw-drama-item-del {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          padding: var(--space-1);
          background: transparent;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          border-radius: var(--radius-badge);
          transition: color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .nsfw-drama-item-del:hover {
          color: var(--err);
          background: var(--bg-surface-3);
        }
        .nsfw-drama-main {
          flex: 1;
          min-width: 0;
          min-height: 0;
          overflow-y: auto;
          padding: var(--space-2) var(--space-6) var(--space-8);
        }
        /* 空态:大号图标底盘 + 更舒展的留白 */
        .nsfw-drama-empty {
          padding: var(--space-12) var(--space-6);
        }
        .nsfw-drama-empty .empty-state-icon {
          width: 72px;
          height: 72px;
          margin: 0 auto var(--space-4);
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: var(--accent-soft);
          color: var(--accent);
        }
        .nsfw-drama-hint {
          padding: var(--space-6);
          color: var(--text-muted);
          font-size: var(--text-aux);
          line-height: 1.6;
          text-align: center;
        }
        .nsfw-drama-hint button {
          padding: 2px var(--space-2);
          background: var(--bg-surface-3);
          color: var(--text-primary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          cursor: pointer;
        }
        .nsfw-drama-error {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          background: color-mix(in oklch, var(--err) 6%, var(--bg-surface-1));
          border: 1px solid color-mix(in oklch, var(--err) 24%, var(--bg-surface-1));
          border-radius: var(--radius-control);
          color: var(--err);
          font-size: var(--text-aux);
          line-height: 1.5;
        }
        .nsfw-drama-error button {
          padding: 2px var(--space-2);
          background: var(--err);
          color: var(--text-on-accent);
          border: none;
          border-radius: var(--radius-badge);
          cursor: pointer;
          flex-shrink: 0;
        }
        @media (max-width: 1023px) {
          /* 窄屏壳层 padding-top 归零、底部导航占位:定高改减 bottomnav */
          .nsfw-drama-root {
            height: calc(100vh - var(--bottomnav-h));
            height: calc(100dvh - var(--bottomnav-h));
          }
          .nsfw-drama-side {
            width: 260px;
          }
          .nsfw-drama-main {
            padding: var(--space-2) var(--space-4) var(--space-6);
          }
        }
        @media (max-width: 767px) {
          .nsfw-drama-root > .page-header {
            padding: var(--space-3) var(--page-gutter) 0;
            margin-bottom: var(--section-gap);
          }
          .nsfw-drama {
            flex-direction: column;
            overflow-y: auto;
          }
          .nsfw-drama-side {
            width: 100%;
            border-right: none;
            border-bottom: 1px solid var(--border-subtle);
          }
          .nsfw-drama-main {
            overflow-y: visible;
          }
          /* 移动端触控目标 ≥44px */
          .nsfw-drama-create-btn {
            min-height: 44px;
          }
          .nsfw-drama-item {
            min-height: 44px;
          }
          .nsfw-drama-item-del {
            min-width: 44px;
            min-height: 44px;
          }
        }
      `}</style>
    </div>
  );
}

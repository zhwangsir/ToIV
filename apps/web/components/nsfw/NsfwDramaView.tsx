"use client";

import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { useDramaProject } from "@/hooks/useDramaProject";
import {
  listDramaProjects,
  createDramaProject,
  deleteDramaProject,
  imageUrl,
  type DramaProjectSummary,
  type DramaShotItem,
  type DramaShotCandidate,
  type DramaAssetKind,
} from "@/lib/api";

/**
 * NSFW 专区「短剧」tab:scoped 短剧工作台(drama 管线,非 M4 studio)。
 *
 * 背景:主站旧 DramaStudioView 已退役(2cd0b7f),drama API + useDramaProject
 * 仍在;本视图是专区专用的紧凑工作台,覆盖核心创作流:
 *   项目 → 剧本 → AI 拆分镜 → 单镜/批量视频生成(v2 模型选择)→ 末帧续写
 *   → 配音 → 对口型 → 合成成片。
 * nsfw 隔离:useDramaProject({ nsfw: true }) 使 generate-video(v1/v2)/continue-video
 * 请求体带 nsfw:true;X-NSFW 头由 NsfwView 的 setNsfwIntent 全局注入,
 * 产物 Job 打标 nsfw,只出现在专区作品库。
 */
export function NsfwDramaView() {
  const { show: showToast } = useToast();
  const [projects, setProjects] = useState<DramaProjectSummary[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPremise, setNewPremise] = useState("");

  // ── 项目列表 ──
  const reloadProjects = useCallback(() => {
    listDramaProjects()
      .then((list) => setProjects(list))
      .catch((err) =>
        showToast("error", err instanceof Error ? err.message : "加载项目失败"),
      );
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

  const dp = useDramaProject(activeId, handleSummaryChange, { nsfw: true });

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
  const handleDelete = useCallback(
    async (p: DramaProjectSummary) => {
      if (!window.confirm(`删除项目「${p.title}」?该操作不可恢复。`)) return;
      try {
        await deleteDramaProject(p.id);
        if (activeId === p.id) setActiveId(null);
        reloadProjects();
        showToast("success", `项目「${p.title}」已删除`);
      } catch (err) {
        showToast("error", err instanceof Error ? err.message : "删除项目失败");
      }
    },
    [activeId, reloadProjects, showToast],
  );

  return (
    <div className="nsfw-drama">
      {/* ── 左侧:项目列表 + 新建 ── */}
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
          {projects === null && <div className="nsfw-drama-hint">加载中…</div>}
          {projects !== null && projects.length === 0 && (
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
                <Icon name="error" size={13} />
              </button>
            </div>
          ))}
        </div>
        {activeId && dp.current && <TaskLogPanel dp={dp} />}
      </aside>

      {/* ── 右侧:项目工作台 ── */}
      <section className="nsfw-drama-main">
        {!activeId && (
          <div className="empty-state nsfw-drama-empty">
            <div className="empty-state-icon">
              <Icon name="clapperboard" size={48} strokeWidth={1.1} />
            </div>
            <div className="empty-state-title">选择或新建一个短剧项目</div>
            <div className="empty-state-desc">
              剧本 → 分镜 → 视频 → 配音 → 成片;R18 产物仅出现在专区作品库
            </div>
          </div>
        )}
        {activeId && dp.loading && (
          <div className="nsfw-drama-hint">加载项目详情…</div>
        )}
        {activeId && dp.error && (
          <div className="nsfw-drama-error">
            <Icon name="error" size={14} />
            <span>{dp.error}</span>
            <button type="button" onClick={() => dp.reload()}>
              重试
            </button>
          </div>
        )}
        {activeId && dp.current && <DramaDetail dp={dp} />}
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

      <style jsx>{`
        .nsfw-drama {
          flex: 1;
          min-height: 0;
          display: flex;
          background: var(--bg-canvas);
        }
        .nsfw-drama-side {
          width: 260px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          border-right: 1px solid var(--border-subtle);
          background: var(--bg-surface-1);
          min-height: 0;
        }
        .nsfw-drama-side-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          font-size: var(--text-body);
          font-weight: 600;
          color: var(--text-primary);
          border-bottom: 1px solid var(--border-subtle);
        }
        .nsfw-drama-create {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-3);
          border-bottom: 1px solid var(--border-subtle);
        }
        .nsfw-drama-input {
          width: 100%;
          padding: var(--space-2) var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-aux);
        }
        .nsfw-drama-input:focus {
          outline: none;
          border-color: var(--accent);
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
          padding: var(--space-2);
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .nsfw-drama-item {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-control);
          cursor: pointer;
          border: 1px solid transparent;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .nsfw-drama-item:hover {
          background: var(--bg-surface-2);
        }
        .nsfw-drama-item.is-active {
          background: var(--bg-surface-3);
          border-color: var(--border-strong);
        }
        .nsfw-drama-item-main {
          flex: 1;
          min-width: 0;
        }
        .nsfw-drama-item-title {
          font-size: var(--text-aux);
          font-weight: 600;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nsfw-drama-item-sub {
          font-size: var(--text-label);
          color: var(--text-muted);
        }
        .nsfw-drama-item-del {
          display: inline-flex;
          padding: var(--space-1);
          background: transparent;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          border-radius: var(--radius-badge);
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
          padding: var(--space-4);
        }
        .nsfw-drama-empty {
          padding: var(--space-6);
        }
        .nsfw-drama-hint {
          padding: var(--space-4);
          color: var(--text-muted);
          font-size: var(--text-aux);
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
          padding: var(--space-3);
          color: var(--err);
          font-size: var(--text-aux);
        }
        .nsfw-drama-error button {
          padding: 2px var(--space-2);
          background: var(--err);
          color: var(--text-on-accent);
          border: none;
          border-radius: var(--radius-badge);
          cursor: pointer;
        }
        @media (max-width: 720px) {
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
        }
      `}</style>
    </div>
  );
}

/** UseDramaProjectReturn 的视图别名,避免组件 props 引入 hooks 类型路径 */
type DramaProjectApi = ReturnType<typeof useDramaProject>;

/** 项目工作台:剧本 → 角色 → 分镜 → 合成。 */
function DramaDetail({ dp }: { dp: DramaProjectApi }) {
  const { show: showToast } = useToast();
  const project = dp.current!;
  const [script, setScript] = useState(project.script ?? "");
  const [charName, setCharName] = useState("");
  const [charDesc, setCharDesc] = useState("");
  // 资产库面板
  const [assetsOpen, setAssetsOpen] = useState(false);
  // 宫格预览块本地隐藏(清除后再次生成会重新显示)
  const [gridHidden, setGridHidden] = useState(false);
  // 导演台 L2:剧本 AI 润色结果(采纳/放弃由用户决定)
  const [polishBusy, setPolishBusy] = useState(false);
  const [polishResult, setPolishResult] = useState<{
    original: string;
    refined: string;
  } | null>(null);

  // 切换项目时同步剧本草稿
  useEffect(() => {
    setScript(project.script ?? "");
    setPolishResult(null);
    setGridHidden(false);
    setAssetsOpen(false);
  }, [project.id, project.script]);

  const saveScript = useCallback(async () => {
    try {
      await dp.patchProject({ script });
      showToast("success", "剧本已保存");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "保存剧本失败");
    }
  }, [dp, script, showToast]);

  const addCharacter = useCallback(async () => {
    const name = charName.trim();
    if (!name) return;
    try {
      await dp.createCharacter({ name, description: charDesc.trim() });
      setCharName("");
      setCharDesc("");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "添加角色失败");
    }
  }, [dp, charName, charDesc, showToast]);

  const availableGenerators = dp.videoGenerators.filter((g) => g.available);

  // ── 剧本 AI 润色(L2 refine,同步)──
  const handlePolish = useCallback(async () => {
    const text = script.trim();
    if (!text || polishBusy) return;
    setPolishBusy(true);
    try {
      const r = await dp.refineScript(text);
      setPolishResult(r);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "AI 润色失败");
    } finally {
      setPolishBusy(false);
    }
  }, [dp, script, polishBusy, showToast]);

  // ── 宫格图点击定位:按格子行列映射到分镜序号并滚动到卡片 ──
  const handleGridClick = useCallback(
    (e: ReactMouseEvent<HTMLImageElement>) => {
      const shots = dp.shots;
      if (shots.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const cols = shots.length <= 9 ? 3 : 5;
      const rows = Math.ceil(shots.length / cols);
      const col = Math.min(cols - 1, Math.max(0, Math.floor(fx * cols)));
      const row = Math.min(rows - 1, Math.max(0, Math.floor(fy * rows)));
      const shot = shots[row * cols + col];
      if (!shot) return;
      dp.setSelectedShotId(shot.id);
      document
        .getElementById(`nsfw-shot-${shot.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [dp],
  );

  return (
    <div className="nsfw-dd">
      {/* ── 头部:标题 + 批量操作 ── */}
      <div className="nsfw-dd-head">
        <div className="nsfw-dd-title-wrap">
          <h2 className="nsfw-dd-title">{project.title}</h2>
          <span className="nsfw-dd-status">{project.status}</span>
          {dp.activeTaskCount > 0 && (
            <span className="nsfw-dd-tasks">
              <Icon name="refresh" size={12} />
              {dp.activeTaskLabel}
            </span>
          )}
        </div>
        <div className="nsfw-dd-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setAssetsOpen(true)}
            title="跨项目角色/场景/道具/风格资产库"
          >
            <Icon name="box" size={14} />
            资产库
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={dp.shots.length === 0 || dp.pendingCount === 0}
            onClick={() => dp.generateAllShots()}
          >
            <Icon name="video" size={14} />
            生成全部({dp.pendingCount})
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={dp.shots.length === 0}
            onClick={() => dp.generateAllVoices()}
          >
            <Icon name="mic" size={14} />
            配音全部
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={dp.doneCount === 0 || dp.assembling}
            onClick={() => void dp.assemble()}
          >
            <Icon name="film" size={14} />
            {dp.assembling ? "合成中…" : `合成成片(${dp.doneCount}/${dp.shots.length})`}
          </button>
        </div>
      </div>

      {/* ── 剧本 ── */}
      <section className="nsfw-dd-sec">
        <div className="nsfw-dd-sec-head">
          <Icon name="filevideo" size={15} />
          <span>剧本</span>
        </div>
        <textarea
          className="nsfw-dd-script"
          placeholder="粘贴/编写剧本,然后 AI 拆分镜"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={6}
        />
        <div className="nsfw-dd-sec-foot">
          <button type="button" className="btn btn-ghost" onClick={saveScript}>
            保存剧本
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={polishBusy || !script.trim()}
            onClick={() => void handlePolish()}
            title="L2 模型对当前剧本做关键场景润色(不覆盖原文,采纳后需手动保存)"
          >
            <Icon name="wand" size={14} />
            {polishBusy ? "润色中…" : "AI 润色"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={dp.storyboarding || !(project.script || script).trim()}
            onClick={() => void dp.storyboard(6)}
            title="按剧本 AI 拆 6 个分镜(会清掉旧分镜)"
          >
            <Icon name="wand" size={14} />
            {dp.storyboarding ? "拆解中…" : "AI 拆分镜(6 镜)"}
          </button>
        </div>
        {polishResult && (
          <div className="nsfw-dd-polish">
            <div className="nsfw-dd-polish-head">
              <Icon name="sparkles" size={13} />
              <span>润色结果(未保存,采纳后请再点「保存剧本」)</span>
            </div>
            <div className="nsfw-dd-polish-body">
              <div className="nsfw-dd-polish-col">
                <div className="nsfw-dd-polish-label">原文</div>
                <pre className="nsfw-dd-polish-text">{polishResult.original}</pre>
              </div>
              <div className="nsfw-dd-polish-col">
                <div className="nsfw-dd-polish-label">润色后</div>
                <pre className="nsfw-dd-polish-text">{polishResult.refined}</pre>
              </div>
            </div>
            <div className="nsfw-dd-polish-ops">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setScript(polishResult.refined);
                  setPolishResult(null);
                }}
              >
                <Icon name="check" size={13} />
                采纳
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setPolishResult(null)}
              >
                放弃
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── 角色 ── */}
      <section className="nsfw-dd-sec">
        <div className="nsfw-dd-sec-head">
          <Icon name="sparkles" size={15} />
          <span>角色({dp.characters.length})</span>
        </div>
        <div className="nsfw-dd-chars">
          {dp.characters.map((c) => (
            <div key={c.id} className="nsfw-dd-char">
              {c.reference_front && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="nsfw-dd-char-img"
                  src={imageUrl(c.reference_front)}
                  alt={c.name}
                />
              )}
              <span className="nsfw-dd-char-name">{c.name}</span>
              <button
                type="button"
                className="nsfw-dd-char-op"
                disabled={dp.busyRef === c.id}
                title="生成三视图(正/侧/背)锁定一致性"
                onClick={() => void dp.generateReference(c.id, c.name)}
              >
                {dp.busyRef === c.id ? "生成中…" : "三视图"}
              </button>
              <button
                type="button"
                className="nsfw-dd-char-op is-danger"
                onClick={() => void dp.deleteCharacter(c.id, c.name)}
              >
                删除
              </button>
            </div>
          ))}
          <div className="nsfw-dd-char-add">
            <input
              className="nsfw-dd-input"
              placeholder="角色名"
              value={charName}
              onChange={(e) => setCharName(e.target.value)}
              maxLength={30}
            />
            <input
              className="nsfw-dd-input"
              placeholder="外观描述(可选)"
              value={charDesc}
              onChange={(e) => setCharDesc(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!charName.trim()}
              onClick={addCharacter}
            >
              <Icon name="plus" size={13} />
              添加
            </button>
          </div>
        </div>
      </section>

      {/* ── 分镜 ── */}
      <section className="nsfw-dd-sec">
        <div className="nsfw-dd-sec-head">
          <Icon name="video" size={15} />
          <span>分镜({dp.shots.length})</span>
          <button
            type="button"
            className="nsfw-dd-grid-btn"
            disabled={dp.gridBusy || !script.trim()}
            title="按剧本一次性生成 9/25 张分镜并拼宫格预览图(会清掉旧分镜)"
            onClick={() => dp.setShowGridPicker(!dp.showGridPicker)}
          >
            <Icon name="grid" size={13} />
            {dp.gridBusy ? "宫格生成中…" : "宫格分镜"}
          </button>
          {availableGenerators.length > 0 && (
            <select
              className="nsfw-dd-model"
              aria-label="视频生成模型"
              value={dp.videoModel}
              onChange={(e) => dp.setVideoModel(e.target.value)}
            >
              {availableGenerators.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.display_name || g.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {dp.showGridPicker && !dp.gridBusy && (
          <div className="nsfw-dd-gridpicker">
            <span className="nsfw-dd-gridpicker-hint">选择宫格规格:</span>
            <button
              type="button"
              className="nsfw-shot-btn"
              onClick={() => void dp.gridStoryboard(9)}
            >
              9 宫格(3×3)
            </button>
            <button
              type="button"
              className="nsfw-shot-btn"
              onClick={() => void dp.gridStoryboard(25)}
            >
              25 宫格(5×5)
            </button>
          </div>
        )}
        {dp.gridBusy && (
          <div className="nsfw-drama-hint">宫格分镜生成中(整图生成,约 1-3 分钟)…</div>
        )}
        {dp.gridError && (
          <div className="nsfw-dd-asm-err">
            <Icon name="error" size={13} />
            {dp.gridError}
          </div>
        )}
        {dp.gridImage && !gridHidden && !dp.gridBusy && (
          <div className="nsfw-dd-grid">
            <div className="nsfw-dd-grid-head">
              <span>宫格预览(点击格子定位到分镜卡片)</span>
              <div className="nsfw-dd-grid-ops">
                <button
                  type="button"
                  title="查看大图"
                  onClick={() =>
                    dp.setRefPreview({ url: dp.gridImage, label: "宫格分镜预览" })
                  }
                >
                  <Icon name="maximize" size={13} />
                </button>
                <button
                  type="button"
                  title="收起宫格预览"
                  onClick={() => {
                    setGridHidden(true);
                    dp.clearGridResult();
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="nsfw-dd-grid-img"
              src={imageUrl(dp.gridImage)}
              alt="宫格分镜预览"
              onClick={handleGridClick}
            />
          </div>
        )}
        {dp.shots.length === 0 && (
          <div className="nsfw-drama-hint">还没有分镜,先保存剧本并 AI 拆分镜</div>
        )}
        <div className="nsfw-dd-shots">
          {dp.shots.map((s) => (
            <ShotCard
              key={s.id}
              shot={s}
              selected={dp.selectedShotId === s.id}
              busyVideo={dp.busyShot === s.id}
              busyVoice={dp.busyVoice === s.id}
              busyLipsync={dp.busyLipsync === s.id}
              busyContinue={dp.busyContinue === s.id}
              candidates={dp.candidatesByShot[s.id] ?? []}
              onGenerate={() =>
                dp.generateVideoV2(s.id, {
                  model: dp.videoModel,
                  steps: 20,
                  cfg: 1.0,
                })
              }
              onGacha={(n) => dp.generateShotCandidates(s.id, n)}
              onPickCandidate={(cid) => void dp.pickCandidate(s.id, cid)}
              onDeleteCandidate={(cid) => void dp.deleteCandidate(s.id, cid)}
              onContinue={() => dp.continueVideo(s)}
              onVoice={() => dp.generateVoice(s)}
              onLipsync={() => void dp.generateLipsync(s.id)}
            />
          ))}
        </div>
      </section>

      {/* ── 成片 ── */}
      {(project.video_url || dp.assembleResult || dp.assembleError) && (
        <section className="nsfw-dd-sec">
          <div className="nsfw-dd-sec-head">
            <Icon name="film" size={15} />
            <span>成片</span>
          </div>
          {dp.assembleError && (
            <div className="nsfw-dd-asm-err">
              <Icon name="error" size={13} />
              {dp.assembleError}
            </div>
          )}
          {(dp.assembleResult?.url || project.video_url) && (
            <video
              className="nsfw-dd-final"
              controls
              src={imageUrl(dp.assembleResult?.url || project.video_url)}
            />
          )}
        </section>
      )}

      {/* ── 宫格/参考图大图预览 overlay ── */}
      {dp.refPreview && (
        <div
          className="nsfw-dd-overlay"
          role="button"
          tabIndex={-1}
          onClick={() => dp.setRefPreview(null)}
        >
          <div
            className="nsfw-dd-overlay-body"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="nsfw-dd-overlay-head">
              <span>{dp.refPreview.label}</span>
              <button type="button" onClick={() => dp.setRefPreview(null)}>
                <Icon name="close" size={14} />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="nsfw-dd-overlay-img"
              src={imageUrl(dp.refPreview.url)}
              alt={dp.refPreview.label}
            />
          </div>
        </div>
      )}

      {/* ── 资产库面板 ── */}
      {assetsOpen && <AssetPanel dp={dp} onClose={() => setAssetsOpen(false)} />}

      <style jsx>{`
        .nsfw-dd {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          max-width: 960px;
        }
        .nsfw-dd-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          flex-wrap: wrap;
        }
        .nsfw-dd-title-wrap {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          min-width: 0;
        }
        .nsfw-dd-title {
          margin: 0;
          font-size: var(--text-title);
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nsfw-dd-status {
          font-size: var(--text-label);
          color: var(--accent);
          background: var(--accent-soft);
          border-radius: var(--radius-badge);
          padding: 2px var(--space-2);
          flex-shrink: 0;
        }
        .nsfw-dd-tasks {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-label);
          color: var(--text-secondary);
          flex-shrink: 0;
        }
        .nsfw-dd-actions {
          display: flex;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .nsfw-dd-sec {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-3);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
        }
        .nsfw-dd-sec-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--text-body);
          font-weight: 600;
          color: var(--text-primary);
        }
        .nsfw-dd-script {
          width: 100%;
          padding: var(--space-2) var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-aux);
          font-family: inherit;
          resize: vertical;
        }
        .nsfw-dd-script:focus {
          outline: none;
          border-color: var(--accent);
        }
        .nsfw-dd-sec-foot {
          display: flex;
          justify-content: flex-end;
          gap: var(--space-2);
        }
        .nsfw-dd-chars {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .nsfw-dd-char {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2);
          background: var(--bg-surface-2);
          border-radius: var(--radius-control);
        }
        .nsfw-dd-char-img {
          width: 40px;
          height: 40px;
          object-fit: cover;
          border-radius: var(--radius-badge);
        }
        .nsfw-dd-char-name {
          flex: 1;
          font-size: var(--text-aux);
          font-weight: 600;
          color: var(--text-primary);
        }
        .nsfw-dd-char-op {
          padding: 2px var(--space-2);
          background: var(--bg-surface-3);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          font-size: var(--text-label);
          cursor: pointer;
        }
        .nsfw-dd-char-op:hover:not(:disabled) {
          border-color: var(--border-strong);
        }
        .nsfw-dd-char-op.is-danger:hover {
          color: var(--err);
        }
        .nsfw-dd-char-op:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .nsfw-dd-char-add {
          display: flex;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .nsfw-dd-input {
          flex: 1;
          min-width: 120px;
          padding: var(--space-1) var(--space-2);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-aux);
        }
        .nsfw-dd-input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .nsfw-dd-model {
          margin-left: auto;
          padding: var(--space-1) var(--space-2);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-aux);
        }
        .nsfw-dd-shots {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .nsfw-dd-final {
          width: 100%;
          max-height: 480px;
          border-radius: var(--radius-control);
          background: #000;
        }
        .nsfw-dd-asm-err {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          color: var(--err);
          font-size: var(--text-aux);
        }
        .nsfw-dd-grid-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) var(--space-2);
          background: var(--bg-surface-2);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          font-size: var(--text-label);
          cursor: pointer;
        }
        .nsfw-dd-grid-btn:hover:not(:disabled) {
          border-color: var(--border-strong);
          color: var(--text-primary);
        }
        .nsfw-dd-grid-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .nsfw-dd-gridpicker {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
          padding: var(--space-2);
          background: var(--bg-surface-2);
          border-radius: var(--radius-control);
        }
        .nsfw-dd-gridpicker-hint {
          font-size: var(--text-label);
          color: var(--text-muted);
        }
        .nsfw-dd-grid {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .nsfw-dd-grid-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: var(--text-label);
          color: var(--text-muted);
        }
        .nsfw-dd-grid-ops {
          display: flex;
          gap: var(--space-1);
        }
        .nsfw-dd-grid-ops button {
          display: inline-flex;
          padding: var(--space-1);
          background: var(--bg-surface-3);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          cursor: pointer;
        }
        .nsfw-dd-grid-ops button:hover {
          color: var(--text-primary);
          border-color: var(--border-strong);
        }
        .nsfw-dd-grid-img {
          width: 100%;
          max-height: 480px;
          object-fit: contain;
          background: #000;
          border-radius: var(--radius-control);
          cursor: crosshair;
        }
        .nsfw-dd-polish {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-2);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .nsfw-dd-polish-head {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-label);
          color: var(--text-muted);
        }
        .nsfw-dd-polish-body {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--space-2);
        }
        .nsfw-dd-polish-label {
          font-size: var(--text-label);
          color: var(--text-secondary);
          margin-bottom: var(--space-1);
        }
        .nsfw-dd-polish-text {
          margin: 0;
          padding: var(--space-2);
          max-height: 220px;
          overflow-y: auto;
          background: var(--bg-surface-3);
          border-radius: var(--radius-badge);
          color: var(--text-primary);
          font-size: var(--text-aux);
          font-family: inherit;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .nsfw-dd-polish-ops {
          display: flex;
          justify-content: flex-end;
          gap: var(--space-2);
        }
        .nsfw-dd-overlay {
          position: fixed;
          inset: 0;
          z-index: 60;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.72);
          padding: var(--space-4);
        }
        .nsfw-dd-overlay-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          max-width: 90vw;
          max-height: 90vh;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          padding: var(--space-3);
        }
        .nsfw-dd-overlay-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: var(--text-aux);
          font-weight: 600;
          color: var(--text-primary);
        }
        .nsfw-dd-overlay-head button {
          display: inline-flex;
          padding: var(--space-1);
          background: var(--bg-surface-3);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          cursor: pointer;
        }
        .nsfw-dd-overlay-img {
          max-width: 86vw;
          max-height: 78vh;
          object-fit: contain;
          border-radius: var(--radius-control);
          background: #000;
        }
        @media (max-width: 720px) {
          .nsfw-dd-polish-body {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}

/** 单分镜卡片:提示词/台词 + 视频预览 + 生成/抽卡/续写/配音/对口型操作 + 候选网格。 */
function ShotCard({
  shot,
  selected,
  busyVideo,
  busyVoice,
  busyLipsync,
  busyContinue,
  candidates,
  onGenerate,
  onGacha,
  onPickCandidate,
  onDeleteCandidate,
  onContinue,
  onVoice,
  onLipsync,
}: {
  shot: DramaShotItem;
  selected: boolean;
  busyVideo: boolean;
  busyVoice: boolean;
  busyLipsync: boolean;
  busyContinue: boolean;
  candidates: DramaShotCandidate[];
  onGenerate: () => void;
  onGacha: (n: number) => void;
  onPickCandidate: (cid: string) => void;
  onDeleteCandidate: (cid: string) => void;
  onContinue: () => void;
  onVoice: () => void;
  onLipsync: () => void;
}) {
  const [gachaN, setGachaN] = useState(2);
  const videoSrc = shot.continue_concat_url || shot.lipsync_video_url || shot.video_url;
  const videoDone = (shot.video_status || "").toLowerCase() === "done";
  const voiceDone = (shot.voice_status || "").toLowerCase() === "done";
  const lipsyncDone = (shot.lipsync_status || "").toLowerCase() === "done";
  const continueDone = (shot.continue_status || "").toLowerCase() === "done";

  return (
    <div
      id={`nsfw-shot-${shot.id}`}
      className={`nsfw-shot${selected ? " is-selected" : ""}`}
    >
      <div className="nsfw-shot-top">
        <div className="nsfw-shot-info">
        <div className="nsfw-shot-head">
          <span className="nsfw-shot-idx">#{shot.idx}</span>
          {shot.scene && <span className="nsfw-shot-scene">{shot.scene}</span>}
          <StatusBadge label="视频" status={shot.video_status} />
          {!!shot.dialogue && <StatusBadge label="配音" status={shot.voice_status} />}
          {lipsyncDone && <StatusBadge label="口型" status={shot.lipsync_status} />}
          {continueDone && <StatusBadge label="续写" status={shot.continue_status} />}
        </div>
        <div className="nsfw-shot-prompt" title={shot.prompt}>
          {shot.prompt}
        </div>
        {!!shot.dialogue && (
          <div className="nsfw-shot-dialogue">
            {shot.speaker ? `${shot.speaker}:` : ""}
            {shot.dialogue}
          </div>
        )}
        {shot.error && (
          <div className="nsfw-shot-err">
            <Icon name="error" size={12} />
            {shot.error}
          </div>
        )}
        <div className="nsfw-shot-ops">
          <button
            type="button"
            className="nsfw-shot-btn is-primary"
            disabled={busyVideo}
            onClick={onGenerate}
          >
            <Icon name="video" size={13} />
            {busyVideo ? "生成中…" : videoDone ? "重新生成" : "生成视频"}
          </button>
          <select
            className="nsfw-shot-gacha-n"
            aria-label="抽卡候选数"
            value={gachaN}
            onChange={(e) => setGachaN(Number(e.target.value))}
          >
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>
                ×{n}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="nsfw-shot-btn"
            disabled={busyVideo}
            title="一次生成 N 个候选视频,挑选其一回填分镜"
            onClick={() => onGacha(gachaN)}
          >
            <Icon name="zap" size={13} />
            {busyVideo ? "生成中…" : "抽卡"}
          </button>
          <button
            type="button"
            className="nsfw-shot-btn"
            disabled={!videoDone || busyContinue}
            title="抽当前视频末帧 i2v 续写 1 段并自动拼接"
            onClick={onContinue}
          >
            <Icon name="replay" size={13} />
            {busyContinue ? "续写中…" : "末帧续写"}
          </button>
          <button
            type="button"
            className="nsfw-shot-btn"
            disabled={!shot.dialogue || busyVoice}
            onClick={onVoice}
          >
            <Icon name="mic" size={13} />
            {busyVoice ? "配音中…" : voiceDone ? "重新配音" : "配音"}
          </button>
          <button
            type="button"
            className="nsfw-shot-btn"
            disabled={!videoDone || !voiceDone || busyLipsync}
            title="源视频 + 配音 → 口型同步"
            onClick={onLipsync}
          >
            <Icon name="sparkles" size={13} />
            {busyLipsync ? "对口型…" : lipsyncDone ? "重新对口型" : "对口型"}
          </button>
        </div>
        </div>
        {!!videoSrc && (
          <video className="nsfw-shot-video" controls preload="metadata" src={imageUrl(videoSrc)} />
        )}
      </div>
      {candidates.length > 0 && (
        <CandidateGrid
          candidates={candidates}
          onPick={onPickCandidate}
          onDelete={onDeleteCandidate}
        />
      )}

      <style jsx>{`
        .nsfw-shot {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .nsfw-shot.is-selected {
          border-color: var(--accent);
          box-shadow: 0 0 0 1px var(--accent);
        }
        .nsfw-shot-top {
          display: flex;
          gap: var(--space-3);
        }
        .nsfw-shot-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .nsfw-shot-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .nsfw-shot-idx {
          font-size: var(--text-aux);
          font-weight: 700;
          color: var(--text-primary);
          font-family: var(--font-mono);
        }
        .nsfw-shot-scene {
          font-size: var(--text-label);
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nsfw-shot-prompt {
          font-size: var(--text-aux);
          color: var(--text-primary);
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .nsfw-shot-dialogue {
          font-size: var(--text-aux);
          color: var(--text-secondary);
        }
        .nsfw-shot-err {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          font-size: var(--text-label);
          color: var(--err);
        }
        .nsfw-shot-ops {
          display: flex;
          gap: var(--space-2);
          flex-wrap: wrap;
          margin-top: auto;
        }
        .nsfw-shot-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) var(--space-3);
          background: var(--bg-surface-3);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          font-size: var(--text-label);
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .nsfw-shot-btn:hover:not(:disabled) {
          border-color: var(--border-strong);
          color: var(--text-primary);
        }
        .nsfw-shot-btn.is-primary {
          background: var(--accent);
          color: var(--text-on-accent);
          border-color: transparent;
        }
        .nsfw-shot-btn.is-primary:hover:not(:disabled) {
          background: var(--accent-hover);
        }
        .nsfw-shot-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .nsfw-shot-gacha-n {
          padding: var(--space-1);
          background: var(--bg-surface-3);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          font-size: var(--text-label);
        }
        .nsfw-shot-video {
          width: 220px;
          flex-shrink: 0;
          border-radius: var(--radius-control);
          background: #000;
          align-self: flex-start;
        }
        @media (max-width: 720px) {
          .nsfw-shot-top {
            flex-direction: column;
          }
          .nsfw-shot-video {
            width: 100%;
          }
        }
      `}</style>
    </div>
  );
}

/** 抽卡候选网格:视频可播,挑选回填分镜 / 弃选删除。 */
function CandidateGrid({
  candidates,
  onPick,
  onDelete,
}: {
  candidates: DramaShotCandidate[];
  onPick: (cid: string) => void;
  onDelete: (cid: string) => void;
}) {
  return (
    <div className="nsfw-cand">
      {candidates.map((c) => {
        const st = (c.status || "").toLowerCase();
        const isDone = st === "done";
        return (
          <div
            key={c.id}
            className={`nsfw-cand-item${c.is_picked ? " is-picked" : ""}`}
          >
            <div className="nsfw-cand-media">
              {isDone && c.url ? (
                <video
                  className="nsfw-cand-video"
                  controls
                  preload="metadata"
                  src={imageUrl(c.url)}
                />
              ) : st === "error" ? (
                <div className="nsfw-cand-ph is-err" title={c.error}>
                  <Icon name="error" size={14} />
                  失败
                </div>
              ) : (
                <div className="nsfw-cand-ph">
                  <Icon name="refresh" size={14} />
                  生成中…
                </div>
              )}
            </div>
            <div className="nsfw-cand-meta">
              <span>seed {c.seed}</span>
              <span>{c.video_model}</span>
              {c.is_picked && <span className="nsfw-cand-picked">已选</span>}
            </div>
            <div className="nsfw-cand-ops">
              <button
                type="button"
                className="nsfw-cand-btn is-primary"
                disabled={!isDone || c.is_picked}
                title="将该候选回填为当前分镜视频"
                onClick={() => onPick(c.id)}
              >
                <Icon name="check" size={12} />
                挑选
              </button>
              <button
                type="button"
                className="nsfw-cand-btn is-danger"
                onClick={() => onDelete(c.id)}
              >
                弃选
              </button>
            </div>
          </div>
        );
      })}

      <style jsx>{`
        .nsfw-cand {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: var(--space-2);
        }
        .nsfw-cand-item {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          padding: var(--space-2);
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
        }
        .nsfw-cand-item.is-picked {
          border-color: var(--ok, #16a34a);
        }
        .nsfw-cand-media {
          aspect-ratio: 16 / 9;
          border-radius: var(--radius-badge);
          overflow: hidden;
          background: #000;
        }
        .nsfw-cand-video {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
        .nsfw-cand-ph {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-1);
          color: var(--text-muted);
          font-size: var(--text-label);
        }
        .nsfw-cand-ph.is-err {
          color: var(--err);
        }
        .nsfw-cand-meta {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--text-label);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .nsfw-cand-picked {
          margin-left: auto;
          color: var(--ok, #16a34a);
          font-weight: 600;
        }
        .nsfw-cand-ops {
          display: flex;
          gap: var(--space-2);
        }
        .nsfw-cand-btn {
          flex: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-1);
          padding: 2px var(--space-2);
          background: var(--bg-surface-2);
          color: var(--text-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          font-size: var(--text-label);
          cursor: pointer;
        }
        .nsfw-cand-btn.is-primary {
          background: var(--accent);
          color: var(--text-on-accent);
          border-color: transparent;
        }
        .nsfw-cand-btn.is-danger:hover {
          color: var(--err);
        }
        .nsfw-cand-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}

/** 任务日志面板(侧栏底部):进行中任务实时耗时 + 最近完成记录。 */
function TaskLogPanel({ dp }: { dp: DramaProjectApi }) {
  const [now, setNow] = useState(() => Date.now());
  const running = dp.taskLog.filter((e) => e.status === "running");
  const recent = dp.taskLog.filter((e) => e.status !== "running").slice(0, 8);

  // 有进行中任务时每秒刷新耗时显示
  useEffect(() => {
    if (running.length === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running.length]);

  const shotTag = (detail?: string) => {
    if (!detail) return "";
    const shot = dp.shots.find((s) => s.id === detail);
    return shot ? ` #${shot.idx}` : "";
  };

  return (
    <div className="nsfw-tlog">
      <div className="nsfw-tlog-head">
        <Icon name="history" size={13} />
        <span>任务日志</span>
        {running.length > 0 && (
          <span className="nsfw-tlog-count">{running.length} 进行中</span>
        )}
      </div>
      <div className="nsfw-tlog-list">
        {running.length === 0 && recent.length === 0 && (
          <div className="nsfw-tlog-empty">暂无任务记录</div>
        )}
        {running.map((e) => (
          <div key={e.key} className="nsfw-tlog-item is-running">
            <span className="nsfw-tlog-dot" />
            <span className="nsfw-tlog-label">
              {e.label}
              {shotTag(e.detail)}
            </span>
            <span className="nsfw-tlog-dur">{fmtDur(now - e.startedAt)}</span>
          </div>
        ))}
        {recent.map((e) => (
          <div key={`${e.key}-${e.endedAt ?? e.startedAt}`} className="nsfw-tlog-item">
            <Icon name="check" size={11} />
            <span className="nsfw-tlog-label">
              {e.label}
              {shotTag(e.detail)}
            </span>
            <span className="nsfw-tlog-dur">
              {e.endedAt ? fmtDur(e.endedAt - e.startedAt) : ""}
            </span>
          </div>
        ))}
      </div>

      <style jsx>{`
        .nsfw-tlog {
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          border-top: 1px solid var(--border-subtle);
          max-height: 220px;
          min-height: 0;
        }
        .nsfw-tlog-head {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-2) var(--space-3);
          font-size: var(--text-label);
          font-weight: 600;
          color: var(--text-primary);
        }
        .nsfw-tlog-count {
          margin-left: auto;
          color: var(--accent);
          font-weight: 400;
        }
        .nsfw-tlog-list {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 0 var(--space-2) var(--space-2);
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .nsfw-tlog-empty {
          padding: var(--space-2);
          color: var(--text-muted);
          font-size: var(--text-label);
          text-align: center;
        }
        .nsfw-tlog-item {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          padding: 2px var(--space-1);
          font-size: var(--text-label);
          color: var(--text-secondary);
        }
        .nsfw-tlog-item.is-running {
          color: var(--text-primary);
        }
        .nsfw-tlog-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent);
          flex-shrink: 0;
          animation: nsfw-tlog-pulse 1.2s ease-in-out infinite;
        }
        @keyframes nsfw-tlog-pulse {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.3;
          }
        }
        .nsfw-tlog-label {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nsfw-tlog-dur {
          font-family: var(--font-mono);
          color: var(--text-muted);
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}

/** 耗时格式化:<60s 显示秒,否则 Xm Ys。 */
function fmtDur(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

const ASSET_KINDS: { key: "all" | DramaAssetKind; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "character", label: "角色" },
  { key: "scene", label: "场景" },
  { key: "prop", label: "道具" },
  { key: "style", label: "风格" },
];

/** 资产库面板:跨项目资产网格,角色类可应用到当前项目,均可删除。 */
function AssetPanel({ dp, onClose }: { dp: DramaProjectApi; onClose: () => void }) {
  const { loadAssets } = dp;
  const [kind, setKind] = useState<"all" | DramaAssetKind>("all");
  const [busyApply, setBusyApply] = useState<string | null>(null);

  useEffect(() => {
    void loadAssets(kind === "all" ? undefined : kind);
  }, [kind, loadAssets]);

  const assets = dp.assets;

  return (
    <div className="nsfw-asset-mask" role="button" tabIndex={-1} onClick={onClose}>
      <div className="nsfw-asset" onClick={(e) => e.stopPropagation()}>
        <div className="nsfw-asset-head">
          <Icon name="box" size={15} />
          <span>资产库</span>
          <div className="nsfw-asset-kinds">
            {ASSET_KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                className={`nsfw-asset-kind${kind === k.key ? " is-active" : ""}`}
                onClick={() => setKind(k.key)}
              >
                {k.label}
              </button>
            ))}
          </div>
          <button type="button" className="nsfw-asset-close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="nsfw-asset-body">
          {dp.assetsLoading && <div className="nsfw-drama-hint">加载资产…</div>}
          {!dp.assetsLoading && assets !== null && assets.length === 0 && (
            <div className="nsfw-drama-hint">暂无资产</div>
          )}
          <div className="nsfw-asset-grid">
            {assets?.map((a) => {
              const thumb = a.reference_front || a.ref_image;
              return (
                <div key={a.id} className="nsfw-asset-item">
                  <div className="nsfw-asset-thumb">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imageUrl(thumb)} alt={a.name} />
                    ) : (
                      <div className="nsfw-asset-nothumb">
                        <Icon name="box" size={20} strokeWidth={1.2} />
                      </div>
                    )}
                  </div>
                  <div className="nsfw-asset-name" title={a.name}>
                    {a.name}
                  </div>
                  <div className="nsfw-asset-sub">
                    {ASSET_KINDS.find((k) => k.key === a.kind)?.label ?? a.kind}
                  </div>
                  <div className="nsfw-asset-ops">
                    {a.kind === "character" && (
                      <button
                        type="button"
                        className="nsfw-asset-btn is-primary"
                        disabled={busyApply === a.id}
                        title="作为角色应用到当前项目"
                        onClick={() => {
                          setBusyApply(a.id);
                          void dp.applyAsset(a.id, a.name).finally(() =>
                            setBusyApply(null),
                          );
                        }}
                      >
                        {busyApply === a.id ? "应用中…" : "应用到项目"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="nsfw-asset-btn is-danger"
                      onClick={() => {
                        if (window.confirm(`删除资产「${a.name}」?`)) {
                          void dp.deleteAsset(a.id, a.name);
                        }
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <style jsx>{`
          .nsfw-asset-mask {
            position: fixed;
            inset: 0;
            z-index: 60;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.6);
            padding: var(--space-4);
          }
          .nsfw-asset {
            display: flex;
            flex-direction: column;
            width: min(860px, 92vw);
            max-height: 86vh;
            min-height: 0;
            background: var(--bg-surface-1);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-panel);
          }
          .nsfw-asset-head {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            padding: var(--space-3);
            border-bottom: 1px solid var(--border-subtle);
            font-size: var(--text-body);
            font-weight: 600;
            color: var(--text-primary);
          }
          .nsfw-asset-kinds {
            display: flex;
            gap: var(--space-1);
            margin-left: var(--space-2);
          }
          .nsfw-asset-kind {
            padding: 2px var(--space-2);
            background: var(--bg-surface-2);
            color: var(--text-secondary);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-badge);
            font-size: var(--text-label);
            cursor: pointer;
          }
          .nsfw-asset-kind.is-active {
            background: var(--accent-soft);
            color: var(--accent);
            border-color: var(--accent);
          }
          .nsfw-asset-close {
            margin-left: auto;
            display: inline-flex;
            padding: var(--space-1);
            background: var(--bg-surface-3);
            color: var(--text-secondary);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-badge);
            cursor: pointer;
          }
          .nsfw-asset-body {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: var(--space-3);
          }
          .nsfw-asset-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
            gap: var(--space-2);
          }
          .nsfw-asset-item {
            display: flex;
            flex-direction: column;
            gap: var(--space-1);
            padding: var(--space-2);
            background: var(--bg-surface-2);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-control);
          }
          .nsfw-asset-thumb {
            aspect-ratio: 1;
            border-radius: var(--radius-badge);
            overflow: hidden;
            background: var(--bg-surface-3);
          }
          .nsfw-asset-thumb img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          .nsfw-asset-nothumb {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-muted);
          }
          .nsfw-asset-name {
            font-size: var(--text-aux);
            font-weight: 600;
            color: var(--text-primary);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .nsfw-asset-sub {
            font-size: var(--text-label);
            color: var(--text-muted);
          }
          .nsfw-asset-ops {
            display: flex;
            gap: var(--space-1);
            margin-top: auto;
          }
          .nsfw-asset-btn {
            flex: 1;
            padding: 2px var(--space-1);
            background: var(--bg-surface-3);
            color: var(--text-secondary);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-badge);
            font-size: var(--text-label);
            cursor: pointer;
          }
          .nsfw-asset-btn.is-primary {
            background: var(--accent);
            color: var(--text-on-accent);
            border-color: transparent;
          }
          .nsfw-asset-btn.is-danger:hover {
            color: var(--err);
          }
          .nsfw-asset-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
        `}</style>
      </div>
    </div>
  );
}

/** 状态徽标:done=绿,generating/continuing=进行中,error/failed=红,其余灰。 */
function StatusBadge({ label, status }: { label: string; status?: string }) {
  const st = (status || "draft").toLowerCase();
  const cls =
    st === "done" || st === "ready" || st === "completed"
      ? "is-done"
      : st === "error" || st === "failed"
        ? "is-err"
        : st === "generating" || st === "continuing" || st === "pending" || st === "running"
          ? "is-running"
          : "";
  return (
    <span className={`nsfw-badge-st ${cls}`}>
      {label}·{st}
      <style jsx>{`
        .nsfw-badge-st {
          font-size: var(--text-label);
          padding: 1px var(--space-1);
          border-radius: var(--radius-badge);
          background: var(--bg-surface-3);
          color: var(--text-muted);
        }
        .nsfw-badge-st.is-done {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .nsfw-badge-st.is-running {
          background: var(--bg-surface-3);
          color: var(--text-secondary);
        }
        .nsfw-badge-st.is-err {
          background: color-mix(in oklch, var(--err) 12%, var(--bg-surface-3));
          color: var(--err);
        }
      `}</style>
    </span>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";

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

  // 切换项目时同步剧本草稿
  useEffect(() => {
    setScript(project.script ?? "");
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
            className="btn btn-primary"
            disabled={dp.storyboarding || !(project.script || script).trim()}
            onClick={() => void dp.storyboard(6)}
            title="按剧本 AI 拆 6 个分镜(会清掉旧分镜)"
          >
            <Icon name="wand" size={14} />
            {dp.storyboarding ? "拆解中…" : "AI 拆分镜(6 镜)"}
          </button>
        </div>
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
        {dp.shots.length === 0 && (
          <div className="nsfw-drama-hint">还没有分镜,先保存剧本并 AI 拆分镜</div>
        )}
        <div className="nsfw-dd-shots">
          {dp.shots.map((s) => (
            <ShotCard
              key={s.id}
              shot={s}
              busyVideo={dp.busyShot === s.id}
              busyVoice={dp.busyVoice === s.id}
              busyLipsync={dp.busyLipsync === s.id}
              busyContinue={dp.busyContinue === s.id}
              onGenerate={() =>
                dp.generateVideoV2(s.id, {
                  model: dp.videoModel,
                  steps: 20,
                  cfg: 1.0,
                })
              }
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
      `}</style>
    </div>
  );
}

/** 单分镜卡片:提示词/台词 + 视频预览 + 生成/续写/配音/对口型操作。 */
function ShotCard({
  shot,
  busyVideo,
  busyVoice,
  busyLipsync,
  busyContinue,
  onGenerate,
  onContinue,
  onVoice,
  onLipsync,
}: {
  shot: DramaShotItem;
  busyVideo: boolean;
  busyVoice: boolean;
  busyLipsync: boolean;
  busyContinue: boolean;
  onGenerate: () => void;
  onContinue: () => void;
  onVoice: () => void;
  onLipsync: () => void;
}) {
  const videoSrc = shot.continue_concat_url || shot.lipsync_video_url || shot.video_url;
  const videoDone = (shot.video_status || "").toLowerCase() === "done";
  const voiceDone = (shot.voice_status || "").toLowerCase() === "done";
  const lipsyncDone = (shot.lipsync_status || "").toLowerCase() === "done";
  const continueDone = (shot.continue_status || "").toLowerCase() === "done";

  return (
    <div className="nsfw-shot">
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

      <style jsx>{`
        .nsfw-shot {
          display: flex;
          gap: var(--space-3);
          padding: var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
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
        .nsfw-shot-video {
          width: 220px;
          flex-shrink: 0;
          border-radius: var(--radius-control);
          background: #000;
          align-self: flex-start;
        }
        @media (max-width: 720px) {
          .nsfw-shot {
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

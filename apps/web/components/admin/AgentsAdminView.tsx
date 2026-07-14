"use client";

import { useCallback, useEffect, useState } from "react";

import {
  createAgent,
  deleteAgent,
  listAgents,
  optimizeWithAgent,
  updateAgent,
  type Agent,
} from "@/lib/agents";
import { Icon, type IconName } from "@/components/ui/Icon";

/** 已知的智能体图标键(与 Icon.tsx 的 ICON_MAP 对齐)。 */
const ICON_OPTIONS: IconName[] = [
  "sparkles",
  "camera",
  "palette",
  "film",
  "brush",
  "cpu",
  "minus",
  "package",
  "mic",
  "database",
];

/** applies_to 可选值;含 "all" 表示适用所有 kind。 */
const KIND_OPTIONS = [
  "all",
  "image",
  "image_edit",
  "video",
  "audio",
  "train",
] as const;

interface AgentFormData {
  id: string;
  name: string;
  description: string;
  icon: string;
  applies_to: string[];
  system_prompt: string;
  is_nsfw: boolean;
  llm_model_override: string | null;
  sort: number;
}

const EMPTY_FORM: AgentFormData = {
  id: "",
  name: "",
  description: "",
  icon: "sparkles",
  applies_to: ["all"],
  system_prompt: "",
  is_nsfw: false,
  llm_model_override: null,
  sort: 100,
};

interface EditState {
  mode: "create" | "edit";
  original?: Agent;
  form: AgentFormData;
}

interface TestState {
  agentId: string;
  prompt: string;
  kind: string;
  loading: boolean;
  result: string | null;
  negative: string | null;
  error: string | null;
}

function agentIconName(icon: string): IconName {
  return ICON_OPTIONS.includes(icon as IconName) ? (icon as IconName) : "sparkles";
}

function formFromAgent(a: Agent): AgentFormData {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    icon: a.icon,
    applies_to: a.applies_to?.length ? [...a.applies_to] : ["all"],
    system_prompt: a.system_prompt,
    is_nsfw: a.is_nsfw,
    llm_model_override: a.llm_model_override,
    sort: a.sort,
  };
}

/** 编辑表单:把 applies_to 数组在 "all" 与具体 kind 之间互斥切换。
 *  选 "all" → 清空其他;选具体 kind → 移除 "all"。 */
function toggleAppliesTo(list: string[], kind: string): string[] {
  if (kind === "all") return ["all"];
  const set = new Set(list.filter((k) => k !== "all"));
  if (set.has(kind)) set.delete(kind);
  else set.add(kind);
  return Array.from(set);
}

export function AgentsAdminView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editState, setEditState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 测试面板:同一时刻只展开一个 agent 的测试面板
  const [testState, setTestState] = useState<TestState | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // 不传 kind → 后端按用户 R18 状态返回全部可见智能体(admin 默认可见 NSFW)
    listAgents()
      .then((list) => {
        const sorted = [...list].sort(
          (a, b) => a.sort - b.sort || a.id.localeCompare(b.id),
        );
        setAgents(sorted);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "加载智能体失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Esc 关闭编辑/创建弹窗
  useEffect(() => {
    if (!editState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) setEditState(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editState, saving]);

  const openCreate = () => {
    setSaveError(null);
    setEditState({ mode: "create", form: { ...EMPTY_FORM } });
  };

  const openEdit = (a: Agent) => {
    setSaveError(null);
    setEditState({ mode: "edit", original: a, form: formFromAgent(a) });
  };

  const closeEdit = () => {
    if (saving) return;
    setEditState(null);
    setSaveError(null);
  };

  const patchForm = (patch: Partial<AgentFormData>) => {
    setEditState((s) => (s ? { ...s, form: { ...s.form, ...patch } } : s));
  };

  const handleSave = async () => {
    if (!editState) return;
    const { form, mode, original } = editState;
    if (!form.name.trim()) {
      setSaveError("请填写名称");
      return;
    }
    if (!form.system_prompt.trim()) {
      setSaveError("请填写 system prompt");
      return;
    }
    if (mode === "create" && !form.id.trim()) {
      setSaveError("请填写智能体 ID(英文短名,如 my_agent)");
      return;
    }
    if (mode === "create" && !/^[a-z0-9_]+$/.test(form.id.trim())) {
      setSaveError("ID 只能包含小写字母 / 数字 / 下划线");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const payload: Partial<Agent> = {
        name: form.name.trim(),
        description: form.description.trim(),
        icon: form.icon,
        applies_to: form.applies_to.length ? form.applies_to : ["all"],
        system_prompt: form.system_prompt,
        is_nsfw: form.is_nsfw,
        llm_model_override: form.llm_model_override?.trim()
          ? form.llm_model_override.trim()
          : null,
        sort: Number.isFinite(form.sort) ? form.sort : 100,
      };
      if (mode === "create") {
        payload.id = form.id.trim();
        const created = await createAgent(payload);
        setAgents((prev) =>
          [...prev, created].sort(
            (a, b) => a.sort - b.sort || a.id.localeCompare(b.id),
          ),
        );
        setEditState(null);
      } else if (original) {
        // 内置的 is_builtin / id 不变;system_prompt 可改
        const updated = await updateAgent(original.id, payload);
        setAgents((prev) =>
          prev
            .map((a) => (a.id === original.id ? updated : a))
            .sort(
              (a, b) => a.sort - b.sort || a.id.localeCompare(b.id),
            ),
        );
        setEditState(null);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (a: Agent) => {
    if (a.is_builtin) return;
    setDeletingId(a.id);
    setDeleteError(null);
    try {
      await deleteAgent(a.id);
      setAgents((prev) => prev.filter((x) => x.id !== a.id));
      // 关闭可能展开的测试面板
      setTestState((t) => (t && t.agentId === a.id ? null : t));
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  // 测试面板:输入 prompt + 选 kind → 调 /api/optimize 看输出
  const openTest = (a: Agent) => {
    setTestState({
      agentId: a.id,
      prompt: "",
      // 默认取该智能体 applies_to 中第一个非 all 的 kind,否则 all → image
      kind:
        a.applies_to.find((k) => k !== "all") ??
        (a.applies_to.includes("all") ? "image" : a.applies_to[0] ?? "image"),
      loading: false,
      result: null,
      negative: null,
      error: null,
    });
  };

  const closeTest = () => setTestState(null);

  const patchTest = (patch: Partial<TestState>) => {
    setTestState((t) => (t ? { ...t, ...patch } : t));
  };

  const runTest = async () => {
    if (!testState) return;
    const { agentId, prompt, kind } = testState;
    if (!prompt.trim()) {
      patchTest({ error: "请输入示例 prompt" });
      return;
    }
    patchTest({ loading: true, error: null, result: null, negative: null });
    try {
      const r = await optimizeWithAgent({
        prompt,
        kind,
        agentId,
      });
      patchTest({
        loading: false,
        result: r.optimized,
        negative: r.negative,
      });
    } catch (e) {
      patchTest({
        loading: false,
        error: e instanceof Error ? e.message : "测试失败",
      });
    }
  };

  const isEmpty = !loading && !error && agents.length === 0;

  return (
    <div className="agents-admin">
      <header className="aa-header">
        <div className="aa-header-left">
          <h2 className="aa-title">
            <Icon name="sparkles" size={18} />
            智能体管理
          </h2>
          <span className="aa-subtitle">
            内置 + 自定义 · 提示词优化方向的源
          </span>
        </div>
        <div className="aa-header-right">
          <span className="aa-count">
            {loading ? "加载中…" : `${agents.length} 个智能体`}
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
              className={loading ? "aa-spin" : undefined}
            />
            刷新
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={openCreate}
          >
            <Icon name="create" size={14} />
            新建智能体
          </button>
        </div>
      </header>

      {error && !loading && (
        <div className="aa-error">
          <Icon name="error" size={20} />
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={load}>
            重试
          </button>
        </div>
      )}

      {loading && (
        <div className="loading-spinner aa-loading">
          <Icon name="loading" size={16} className="aa-spin" />
          加载智能体…
        </div>
      )}

      {isEmpty && (
        <div className="empty-state aa-empty">
          <div className="empty-state-icon">
            <Icon name="sparkles" size={48} strokeWidth={1.2} />
          </div>
          <div className="empty-state-title">还没有智能体</div>
          <div className="empty-state-desc">
            内置智能体由后端播种 · 也可点击右上角「新建智能体」创建自定义
          </div>
        </div>
      )}

      {!error && !loading && agents.length > 0 && (
        <div className="aa-list">
          {agents.map((a) => {
            const isTestOpen = testState?.agentId === a.id;
            return (
              <article key={a.id} className="aa-card">
                <div className="aa-card-head">
                  <div className="aa-icon-box">
                    <Icon name={agentIconName(a.icon)} size={18} />
                  </div>
                  <div className="aa-card-meta">
                    <div className="aa-card-title-row">
                      <h3 className="aa-card-title" title={a.name}>
                        {a.name}
                      </h3>
                      {a.is_builtin && (
                        <span className="badge aa-tag aa-tag-builtin">
                          内置
                        </span>
                      )}
                      {a.is_nsfw && (
                        <span className="badge aa-tag aa-tag-nsfw">NSFW</span>
                      )}
                    </div>
                    <div className="aa-card-id">{a.id}</div>
                  </div>
                  <div className="aa-card-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openTest(a)}
                      title="测试此智能体"
                    >
                      <Icon name="playing" size={13} />
                      测试
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openEdit(a)}
                      title="编辑智能体"
                    >
                      <Icon name="create" size={13} />
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost btn-danger aa-delete-btn"
                      onClick={() => void handleDelete(a)}
                      disabled={a.is_builtin || deletingId === a.id}
                      title={
                        a.is_builtin
                          ? "内置智能体不可删除"
                          : "删除智能体"
                      }
                    >
                      <Icon
                        name={deletingId === a.id ? "loading" : "delete"}
                        size={13}
                        className={deletingId === a.id ? "aa-spin" : undefined}
                      />
                    </button>
                  </div>
                </div>

                {a.description && (
                  <p className="aa-card-desc">{a.description}</p>
                )}

                <div className="aa-card-tags">
                  {a.applies_to.map((k) => (
                    <span key={k} className="badge aa-tag aa-tag-kind">
                      {k}
                    </span>
                  ))}
                  {a.llm_model_override && (
                    <span
                      className="badge aa-tag aa-tag-llm"
                      title="绑定的 LLM 模型"
                    >
                      <Icon name="models" size={10} />
                      {a.llm_model_override}
                    </span>
                  )}
                  <span className="aa-sort" title="排序权重">
                    sort · {a.sort}
                  </span>
                </div>

                {deleteError && deletingId === null && (
                  <div className="aa-error-inline">{deleteError}</div>
                )}

                {/* 测试面板(展开式) */}
                {isTestOpen && testState && (
                  <div className="aa-test-panel">
                    <div className="aa-test-head">
                      <span className="aa-test-title">
                        <Icon name="playing" size={13} />
                        测试智能体 · {a.name}
                      </span>
                      <button
                        type="button"
                        className="aa-test-close"
                        onClick={closeTest}
                        aria-label="关闭测试"
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    <div className="aa-test-grid">
                      <label className="aa-field">
                        <span className="aa-field-label">kind</span>
                        <select
                          className="input aa-select"
                          value={testState.kind}
                          onChange={(e) =>
                            patchTest({ kind: e.target.value })
                          }
                          disabled={testState.loading}
                        >
                          {KIND_OPTIONS.map((k) => (
                            <option key={k} value={k}>
                              {k}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="aa-field aa-field-wide">
                        <span className="aa-field-label">示例 prompt</span>
                        <textarea
                          className="input aa-test-textarea"
                          value={testState.prompt}
                          onChange={(e) =>
                            patchTest({ prompt: e.target.value })
                          }
                          rows={3}
                          placeholder="输入测试用提示词…"
                          disabled={testState.loading}
                        />
                      </label>
                    </div>
                    <div className="aa-test-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void runTest()}
                        disabled={testState.loading}
                      >
                        <Icon
                          name={testState.loading ? "loading" : "sparkles"}
                          size={13}
                          className={testState.loading ? "aa-spin" : undefined}
                        />
                        {testState.loading ? "优化中…" : "运行测试"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={closeTest}
                        disabled={testState.loading}
                      >
                        关闭
                      </button>
                    </div>
                    {testState.error && (
                      <div className="aa-error-inline">{testState.error}</div>
                    )}
                    {testState.result && (
                      <div className="aa-test-result">
                        <div className="aa-test-result-label">
                          <Icon name="success" size={12} />
                          优化结果
                        </div>
                        <pre className="aa-test-result-text">
                          {testState.result}
                        </pre>
                        {testState.negative && (
                          <div className="aa-test-result-neg">
                            <span className="badge">负向</span>
                            <pre className="aa-test-result-text">
                              {testState.negative}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* 编辑 / 新建弹窗 */}
      {editState && (
        <div
          className="aa-modal"
          role="dialog"
          aria-modal="true"
          aria-label={editState.mode === "create" ? "新建智能体" : "编辑智能体"}
          onClick={() => !saving && closeEdit()}
        >
          <div
            className="aa-modal-body"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="aa-modal-head">
              <div>
                <div className="aa-modal-title">
                  {editState.mode === "create" ? "新建自定义智能体" : "编辑智能体"}
                </div>
                <div className="aa-modal-sub">
                  {editState.mode === "create"
                    ? "自定义智能体可改可删"
                    : editState.original?.is_builtin
                      ? "内置智能体:可改不可删 · id 与 is_builtin 不可改"
                      : "自定义智能体:可改可删"}
                </div>
              </div>
              <button
                type="button"
                className="aa-modal-close"
                aria-label="关闭"
                onClick={closeEdit}
                disabled={saving}
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="aa-form">
              <label className="aa-field">
                <span className="aa-field-label">
                  ID
                  {editState.mode === "edit" && (
                    <em className="aa-field-hint-inline"> · 不可改</em>
                  )}
                </span>
                <input
                  className="input"
                  value={editState.form.id}
                  onChange={(e) => patchForm({ id: e.target.value })}
                  placeholder="如:my_agent"
                  disabled={
                    editState.mode === "edit" || saving
                  }
                />
              </label>

              <label className="aa-field">
                <span className="aa-field-label">名称</span>
                <input
                  className="input"
                  value={editState.form.name}
                  onChange={(e) => patchForm({ name: e.target.value })}
                  placeholder="如:写实摄影师"
                  disabled={saving}
                  autoFocus={editState.mode === "create"}
                />
              </label>

              <label className="aa-field">
                <span className="aa-field-label">一句话描述</span>
                <input
                  className="input"
                  value={editState.form.description}
                  onChange={(e) => patchForm({ description: e.target.value })}
                  placeholder="一句话简介"
                  disabled={saving}
                />
              </label>

              <div className="aa-form-row">
                <label className="aa-field">
                  <span className="aa-field-label">图标</span>
                  <select
                    className="input aa-select"
                    value={editState.form.icon}
                    onChange={(e) => patchForm({ icon: e.target.value })}
                    disabled={saving}
                  >
                    {ICON_OPTIONS.map((ic) => (
                      <option key={ic} value={ic}>
                        {ic}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="aa-field">
                  <span className="aa-field-label">排序(sort)</span>
                  <input
                    className="input"
                    type="number"
                    value={editState.form.sort}
                    onChange={(e) =>
                      patchForm({
                        sort: parseInt(e.target.value, 10) || 100,
                      })
                    }
                    disabled={saving}
                  />
                </label>
              </div>

              <div className="aa-field">
                <span className="aa-field-label">
                  适用类型 (applies_to)
                </span>
                <div className="aa-checkbox-grid">
                  {KIND_OPTIONS.map((k) => {
                    const checked = editState.form.applies_to.includes(k);
                    return (
                      <label
                        key={k}
                        className={`aa-checkbox${checked ? " is-on" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            patchForm({
                              applies_to: toggleAppliesTo(
                                editState.form.applies_to,
                                k,
                              ),
                            })
                          }
                          disabled={saving}
                        />
                        <span>{k}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <label className="aa-field">
                <span className="aa-field-label">LLM 模型覆盖(可选)</span>
                <input
                  className="input"
                  value={editState.form.llm_model_override ?? ""}
                  onChange={(e) =>
                    patchForm({
                      llm_model_override: e.target.value || null,
                    })
                  }
                  placeholder="留空 = 走全局 LLM"
                  disabled={saving}
                />
              </label>

              <label className="aa-field">
                <span className="aa-field-label">System Prompt</span>
                <textarea
                  className="input aa-textarea"
                  value={editState.form.system_prompt}
                  onChange={(e) =>
                    patchForm({ system_prompt: e.target.value })
                  }
                  rows={10}
                  placeholder="智能体主人格 system prompt…"
                  disabled={saving}
                />
              </label>

              <label className="aa-checkbox aa-checkbox-nsfw">
                <input
                  type="checkbox"
                  checked={editState.form.is_nsfw}
                  onChange={(e) =>
                    patchForm({ is_nsfw: e.target.checked })
                  }
                  disabled={saving}
                />
                <span>
                  NSFW 智能体
                  <em className="aa-field-hint-inline">
                    {" "}
                    · 仅 R18 鉴权用户可见
                  </em>
                </span>
              </label>

              {saveError && (
                <div className="aa-error-inline">{saveError}</div>
              )}

              <div className="aa-form-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={closeEdit}
                  disabled={saving}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleSave()}
                  disabled={saving}
                >
                  <Icon
                    name={saving ? "loading" : "success"}
                    size={14}
                    className={saving ? "aa-spin" : undefined}
                  />
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .agents-admin {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }

        /* ── Header ── */
        .aa-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: var(--space-4);
          flex-wrap: wrap;
          padding-bottom: var(--space-4);
          border-bottom: 1px solid var(--hairline);
        }
        .aa-header-left {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
          min-width: 0;
        }
        .aa-title {
          margin: 0;
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-family: var(--font-display);
          font-size: 1.4rem;
          font-weight: 500;
          letter-spacing: -0.02em;
          color: var(--ink);
          line-height: 1.2;
        }
        .aa-title :global(svg) {
          color: var(--accent);
        }
        .aa-subtitle {
          font-size: 0.74rem;
          color: var(--ink-faint);
        }
        .aa-header-right {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-wrap: wrap;
        }
        .aa-count {
          font-size: 0.78rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
        }

        /* ── Loading / Empty / Error ── */
        .aa-loading {
          padding: var(--space-6) var(--space-4);
          justify-content: center;
        }
        .aa-empty {
          padding: var(--space-7) var(--space-4);
        }
        .aa-error {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          padding: 0.7rem 0.9rem;
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          border-radius: var(--radius);
          color: var(--danger);
          font-size: 0.86rem;
          flex-wrap: wrap;
        }
        .aa-error :global(.btn) {
          margin-left: auto;
        }
        .aa-error-inline {
          padding: 0.5rem 0.7rem;
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          border-radius: var(--radius-xs);
          color: var(--danger);
          font-size: 0.78rem;
          line-height: 1.45;
          margin-top: 0.5rem;
        }

        /* ── 列表 ── */
        .aa-list {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .aa-card {
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
          padding: var(--space-4);
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          transition: border-color var(--dur) var(--ease);
        }
        .aa-card:hover {
          border-color: var(--hairline-2);
        }
        .aa-card-head {
          display: flex;
          align-items: flex-start;
          gap: var(--space-3);
        }
        .aa-icon-box {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          background: var(--accent-quiet);
          border: 1px solid var(--accent-line);
          border-radius: var(--radius-sm);
          color: var(--accent-soft);
          flex-shrink: 0;
        }
        .aa-card-meta {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
        }
        .aa-card-title-row {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          flex-wrap: wrap;
        }
        .aa-card-title {
          margin: 0;
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.3;
          letter-spacing: -0.01em;
        }
        .aa-card-id {
          font-size: 0.7rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
        }
        .aa-card-actions {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          flex-shrink: 0;
        }
        .aa-delete-btn {
          opacity: 0.7;
        }
        .aa-delete-btn:hover:not(:disabled) {
          opacity: 1;
        }
        .aa-delete-btn:disabled {
          cursor: not-allowed;
          opacity: 0.4;
        }

        .aa-card-desc {
          margin: 0;
          font-size: 0.82rem;
          color: var(--ink-soft);
          line-height: 1.5;
        }

        .aa-card-tags {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          flex-wrap: wrap;
        }
        .aa-tag {
          font-size: 0.68rem;
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          padding: 0.1rem 0.4rem;
        }
        .aa-tag-builtin {
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          color: var(--ink-soft);
        }
        .aa-tag-nsfw {
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          color: var(--danger);
          font-weight: 600;
        }
        .aa-tag-kind {
          background: var(--accent-quiet);
          border: 1px solid var(--accent-line);
          color: var(--accent-soft);
        }
        .aa-tag-llm {
          display: inline-flex;
          align-items: center;
          gap: 0.2rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          color: var(--ink-soft);
        }
        .aa-sort {
          font-size: 0.68rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          margin-left: auto;
        }

        /* ── 测试面板(展开式) ── */
        .aa-test-panel {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          padding: 0.85rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-sm);
          margin-top: 0.2rem;
        }
        .aa-test-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .aa-test-title {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.84rem;
          font-weight: 600;
          color: var(--ink);
        }
        .aa-test-title :global(svg) {
          color: var(--accent);
        }
        .aa-test-close {
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
        .aa-test-close:hover {
          color: var(--ink);
          border-color: var(--hairline-2);
        }
        .aa-test-grid {
          display: grid;
          grid-template-columns: 180px 1fr;
          gap: 0.6rem;
          align-items: end;
        }
        @media (max-width: 720px) {
          .aa-test-grid {
            grid-template-columns: 1fr;
          }
        }
        .aa-field {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
        }
        .aa-field-wide {
          grid-column: 1 / -1;
        }
        .aa-field-label {
          font-size: 0.72rem;
          color: var(--ink-soft);
          font-weight: 500;
        }
        .aa-field-hint-inline {
          font-size: 0.7rem;
          color: var(--ink-faint);
          font-weight: 400;
          font-style: normal;
        }
        .aa-select {
          appearance: none;
          -webkit-appearance: none;
          background-image: linear-gradient(
              45deg,
              transparent 50%,
              var(--ink-faint) 50%
            ),
            linear-gradient(135deg, var(--ink-faint) 50%, transparent 50%);
          background-position:
            calc(100% - 16px) 50%,
            calc(100% - 11px) 50%;
          background-size: 5px 5px, 5px 5px;
          background-repeat: no-repeat;
          padding-right: 2rem;
          cursor: pointer;
        }
        .aa-test-textarea {
          font-family: inherit;
          line-height: 1.55;
          min-height: 80px;
        }
        .aa-test-actions {
          display: flex;
          align-items: center;
          gap: 0.4rem;
        }
        .aa-test-result {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          padding: 0.7rem;
          background: var(--success-quiet);
          border: 1px solid var(--success);
          border-radius: var(--radius-xs);
        }
        .aa-test-result-label {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          font-size: 0.74rem;
          color: var(--success);
          font-weight: 600;
        }
        .aa-test-result-text {
          margin: 0;
          padding: 0.5rem 0.6rem;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          font-family: var(--font-mono);
          font-size: 0.78rem;
          color: var(--ink);
          line-height: 1.5;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 220px;
          overflow-y: auto;
        }
        .aa-test-result-neg {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          margin-top: 0.3rem;
        }

        /* ── 编辑/新建弹窗 ── */
        .aa-modal {
          position: fixed;
          inset: 0;
          z-index: 100;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-4);
          background: oklch(3% 0.004 265 / 0.7);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          animation: aa-fade var(--dur-2) var(--ease);
        }
        @keyframes aa-fade {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .aa-modal {
            animation: none;
          }
        }
        .aa-modal-body {
          width: 100%;
          max-width: 560px;
          max-height: 88vh;
          overflow-y: auto;
          background: var(--bg-1);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-lg);
          animation: aa-pop var(--dur-2) var(--ease);
        }
        @keyframes aa-pop {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .aa-modal-body {
            animation: none;
          }
        }
        .aa-modal-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-4) var(--space-4) var(--space-3);
          border-bottom: 1px solid var(--hairline);
        }
        .aa-modal-title {
          font-family: var(--font-display);
          font-size: 1.1rem;
          font-weight: 500;
          color: var(--ink);
          letter-spacing: -0.01em;
          line-height: 1.3;
        }
        .aa-modal-sub {
          margin-top: 0.2rem;
          font-size: 0.74rem;
          color: var(--ink-faint);
          line-height: 1.45;
        }
        .aa-modal-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 0;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-xs);
          color: var(--ink-faint);
          cursor: pointer;
          transition: background-color var(--dur) var(--ease),
            color var(--dur) var(--ease);
        }
        .aa-modal-close:hover {
          background: var(--bg-2);
          color: var(--ink);
        }
        .aa-modal-close:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }

        .aa-form {
          display: flex;
          flex-direction: column;
          gap: 0.7rem;
          padding: var(--space-4);
        }
        .aa-form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.6rem;
        }
        .aa-textarea {
          font-family: var(--font-mono);
          font-size: 0.8rem;
          line-height: 1.55;
          min-height: 180px;
        }
        .aa-checkbox-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem;
        }
        .aa-checkbox {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.3rem 0.55rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          font-size: 0.78rem;
          color: var(--ink-soft);
          cursor: pointer;
          transition: all var(--dur) var(--ease);
        }
        .aa-checkbox input {
          width: 14px;
          height: 14px;
          accent-color: var(--accent);
          cursor: pointer;
        }
        .aa-checkbox.is-on {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .aa-checkbox-nsfw {
          align-self: flex-start;
        }
        .aa-checkbox-nsfw.is-on {
          background: var(--danger-quiet);
          border-color: var(--danger);
          color: var(--danger);
        }
        .aa-form-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: var(--space-2);
          margin-top: 0.3rem;
        }

        /* ── 旋转动画 ── */
        .aa-spin {
          animation: aa-spin 1s linear infinite;
        }
        @keyframes aa-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .aa-spin {
            animation: none;
          }
        }

        /* ── 移动端 ── */
        @media (max-width: 720px) {
          .aa-header {
            flex-direction: column;
            align-items: stretch;
          }
          .aa-header-right {
            justify-content: space-between;
          }
          .aa-card-actions {
            flex-wrap: wrap;
          }
          .aa-form-row {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}

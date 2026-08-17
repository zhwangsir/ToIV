"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import {
  deleteAgent,
  importSkill,
  listAgents,
  serializeSkillShare,
  updateAgent,
  type Agent,
  type SkillSharePayload,
} from "@/lib/agents";

/**
 * Skill 市场(2026-08-18,替代「Agent 团队」导航位):
 * 内置技能 / 公共技能 / 我的技能 三区;支持 粘贴 JSON 或手填表单导入个人技能,
 * 个人技能属主可改可删;任意技能可「分享」复制 JSON 给他人导入。
 */

const APPLIES_OPTIONS = ["all", "image", "video", "audio", "image,video"] as const;

const EMPTY_FORM: SkillSharePayload = {
  name: "",
  description: "",
  icon: "sparkles",
  applies_to: "all",
  system_prompt: "",
  is_nsfw: false,
  llm_model_override: null,
};

function iconOf(a: Agent): IconName {
  const n = a.icon as IconName;
  // Icon 组件对未知名会 warn 并渲染占位,这里收敛到已知安全名
  const known: IconName[] = ["sparkles", "camera", "palette", "film", "brush", "cpu", "package", "mic", "database"];
  return known.includes(n) ? n : "sparkles";
}

export function SkillMarketView() {
  const toast = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const list = await listAgents();
    // listAgents 失败静默返回 [],与优化按钮的优雅降级一致;此处网络错误与空列表难区分,给空态即可
    setAgents(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mine = useMemo(() => agents.filter((a) => a.is_mine), [agents]);
  const builtin = useMemo(() => agents.filter((a) => a.is_builtin && !a.is_mine), [agents]);
  const pub = useMemo(() => agents.filter((a) => a.is_public_custom), [agents]);

  // ── 导入 / 编辑 弹窗 ──
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null); // 非 null = 编辑我的技能
  const [form, setForm] = useState<SkillSharePayload>(EMPTY_FORM);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const openImport = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setJsonText("");
    setFormError(null);
    setImportOpen(true);
  };

  const openEdit = (a: Agent) => {
    setEditing(a);
    setForm({
      name: a.name,
      description: a.description,
      icon: a.icon,
      applies_to: a.applies_to.join(","),
      system_prompt: a.system_prompt,
      is_nsfw: a.is_nsfw,
      llm_model_override: a.llm_model_override,
    });
    setFormError(null);
    setImportOpen(true);
  };

  async function submitImport() {
    setFormError(null);
    setSubmitting(true);
    try {
      if (jsonMode && !editing) {
        // JSON 粘贴导入:解析 → 合法性粗检 → importSkill
        let payload: SkillSharePayload;
        try {
          payload = JSON.parse(jsonText) as SkillSharePayload;
        } catch {
          throw new Error("JSON 解析失败,请检查格式");
        }
        if (!payload?.name || !payload?.system_prompt) {
          throw new Error("JSON 缺少必填字段 name / system_prompt");
        }
        const a = await importSkill({
          ...EMPTY_FORM,
          ...payload,
        });
        toast.success(`技能「${a.name}」已导入`);
      } else if (editing) {
        // 编辑我的技能
        if (!form.name.trim() || !form.system_prompt.trim()) throw new Error("名称与提示词为必填");
        await updateAgent(editing.id, {
          name: form.name.trim(),
          description: form.description,
          icon: form.icon || "sparkles",
          applies_to: form.applies_to.split(","),
          system_prompt: form.system_prompt,
          is_nsfw: form.is_nsfw,
        });
        toast.success("技能已更新");
      } else {
        // 手填表单导入
        if (!form.name.trim() || !form.system_prompt.trim()) throw new Error("名称与提示词为必填");
        const a = await importSkill({
          ...form,
          name: form.name.trim(),
          system_prompt: form.system_prompt,
        });
        toast.success(`技能「${a.name}」已导入`);
      }
      setImportOpen(false);
      await refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function share(a: Agent) {
    const json = JSON.stringify(serializeSkillShare(a), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      toast.success("技能 JSON 已复制,发给他人即可导入");
    } catch {
      // 剪贴板不可用(非 https/权限拒绝):退化为弹窗展示
      window.prompt("复制以下 JSON 分享技能:", json);
    }
  }

  // ── 删除确认 ──
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteAgent(deleting.id);
      toast.success(`技能「${deleting.name}」已删除`);
      setDeleting(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleteBusy(false);
    }
  }

  // ── 提示词查看 ──
  const [viewing, setViewing] = useState<Agent | null>(null);

  return (
    <div className="skill-market">
      <header className="skill-market-head">
        <div>
          <h1 className="skill-market-title">
            <Icon name="package" size={20} /> Skill 市场
          </h1>
          <p className="skill-market-sub">
            收集不同风格的提示词技能,导入后个人专属;生成页的「优化」按钮即可选用。
          </p>
        </div>
        <Button variant="primary" size="sm" icon={<Icon name="download" size={14} />} onClick={openImport}>
          导入技能
        </Button>
      </header>

      {error && <p className="skill-market-error">{error}</p>}
      {loading ? (
        <p className="skill-market-empty">加载中…</p>
      ) : (
        <>
          <Section title={`我的技能(${mine.length})`} empty="还没有个人技能,点右上「导入技能」或粘贴他人分享的 JSON" agents={mine} onView={setViewing}>
            {(a) => (
              <>
                <button type="button" className="skill-card-act" title="编辑" onClick={() => openEdit(a)}>
                  <Icon name="pencil" size={12} />
                </button>
                <button type="button" className="skill-card-act" title="分享(复制 JSON)" onClick={() => void share(a)}>
                  <Icon name="share" size={12} />
                </button>
                <button type="button" className="skill-card-act is-danger" title="删除" onClick={() => setDeleting(a)}>
                  <Icon name="delete" size={12} />
                </button>
              </>
            )}
          </Section>

          <Section title={`公共技能(${pub.length})`} empty="暂无公共自定义技能(admin 可在管理页创建)" agents={pub} onView={setViewing}>
            {(a) => (
              <button type="button" className="skill-card-act" title="分享(复制 JSON)" onClick={() => void share(a)}>
                <Icon name="share" size={12} />
              </button>
            )}
          </Section>

          <Section title={`内置技能(${builtin.length})`} empty="" agents={builtin} onView={setViewing}>
            {(a) => (
              <button type="button" className="skill-card-act" title="分享(复制 JSON)" onClick={() => void share(a)}>
                <Icon name="share" size={12} />
              </button>
            )}
          </Section>
        </>
      )}

      {/* 导入 / 编辑 弹窗 */}
      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={editing ? "编辑技能" : "导入技能"}
        preventClose={submitting}
        width={560}
      >
        {!editing && (
          <div className="skill-import-mode">
            <button
              type="button"
              className={`skill-mode-btn${!jsonMode ? " is-on" : ""}`}
              onClick={() => setJsonMode(false)}
            >
              手填表单
            </button>
            <button
              type="button"
              className={`skill-mode-btn${jsonMode ? " is-on" : ""}`}
              onClick={() => setJsonMode(true)}
            >
              粘贴 JSON
            </button>
          </div>
        )}

        {jsonMode && !editing ? (
          <Field
            label="技能 JSON"
            hint="他人技能卡「分享」复制的 JSON,粘贴后一键导入为个人技能"
            error={formError ?? undefined}
          >
            <Textarea
              rows={10}
              value={jsonText}
              placeholder='{"name": "赛璐璐复古风", "system_prompt": "你是…", …}'
              onChange={(e) => setJsonText(e.target.value)}
            />
          </Field>
        ) : (
          <>
            <Field label="名称" error={formError && !form.name.trim() ? formError : undefined}>
              <Input value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="描述">
              <Input
                value={form.description}
                maxLength={500}
                placeholder="一句话说明风格效果"
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>
            <div className="skill-form-row">
              <Field label="图标">
                <Input value={form.icon} maxLength={64} onChange={(e) => setForm({ ...form, icon: e.target.value })} />
              </Field>
              <Field label="适用范围">
                <select
                  className="input"
                  value={form.applies_to}
                  onChange={(e) => setForm({ ...form, applies_to: e.target.value })}
                >
                  {APPLIES_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {o === "all" ? "全部" : o}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="提示词(system prompt)" hint="技能人格:优化时拼接在原提示词之前">
              <Textarea
                rows={6}
                value={form.system_prompt}
                maxLength={20000}
                onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
              />
            </Field>
            <div className="skill-form-row skill-form-switch">
              <span>R18 技能</span>
              <Switch
                checked={form.is_nsfw}
                onChange={(v) => setForm({ ...form, is_nsfw: v })}
                ariaLabel="R18 技能"
              />
            </div>
            {formError && <p className="skill-form-error">{formError}</p>}
          </>
        )}

        <div className="skill-form-actions">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(false)} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={submitting} onClick={() => void submitImport()}>
            {editing ? "保存" : "导入"}
          </Button>
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)} title="删除技能" danger>
        <p style={{ margin: 0 }}>
          确定删除技能「{deleting?.name}」?此操作不可撤销。
        </p>
        <div className="skill-form-actions">
          <Button variant="ghost" size="sm" onClick={() => setDeleting(null)} disabled={deleteBusy}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={deleteBusy} onClick={() => void confirmDelete()}>
            删除
          </Button>
        </div>
      </Modal>

      {/* 提示词查看 */}
      <Modal
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={viewing ? `技能提示词 · ${viewing.name}` : ""}
        width={560}
      >
        <pre className="skill-prompt-view">{viewing?.system_prompt}</pre>
      </Modal>

      <style jsx>{`
        .skill-market {
          max-width: 1080px;
          margin: 0 auto;
          padding: var(--space-5, 20px) var(--space-4, 16px) 96px;
          display: flex;
          flex-direction: column;
          gap: var(--space-5, 20px);
        }
        .skill-market-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--space-3, 12px);
        }
        .skill-market-title {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0;
          font-size: 20px;
        }
        .skill-market-sub {
          margin: 4px 0 0;
          color: var(--text-muted);
          font-size: 13px;
        }
        .skill-market-empty,
        .skill-market-error {
          color: var(--text-muted);
          text-align: center;
          padding: 32px 0;
        }
        .skill-market-error {
          color: var(--err);
        }
        .skill-section {
          display: flex;
          flex-direction: column;
          gap: var(--space-2, 8px);
        }
        .skill-section-title {
          margin: 0;
          font-size: 14px;
          color: var(--text-secondary);
        }
        .skill-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: var(--space-3, 12px);
        }
        .skill-grid.is-empty {
          display: block;
        }
        .skill-empty {
          color: var(--text-muted);
          font-size: 12px;
          padding: var(--space-2, 8px) 0;
        }
        .skill-card {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: var(--space-3, 12px);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-card, 12px);
          background: var(--bg-surface-2, transparent);
        }
        .skill-card-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .skill-card-name {
          flex: 1;
          min-width: 0;
          font-size: 14px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .skill-card-act {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          flex-shrink: 0;
        }
        .skill-card-act:hover {
          background: var(--bg-surface-3, rgba(0, 0, 0, 0.06));
          color: var(--text-primary);
        }
        .skill-card-act.is-danger:hover {
          color: var(--err);
        }
        .skill-card-desc {
          margin: 0;
          font-size: 12px;
          color: var(--text-muted);
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .skill-card-tags {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }
        .skill-tag {
          font-size: 10px;
          padding: 1px 7px;
          border-radius: 999px;
          border: 1px solid var(--border-subtle);
          color: var(--text-muted);
        }
        .skill-tag.is-nsfw {
          color: var(--err);
          border-color: var(--err);
        }
        .skill-import-mode {
          display: flex;
          gap: var(--space-2, 8px);
          margin-bottom: var(--space-3, 12px);
        }
        .skill-mode-btn {
          flex: 1;
          padding: 7px 0;
          font-size: 13px;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control, 8px);
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
        }
        .skill-mode-btn.is-on {
          color: var(--text-primary);
          border-color: var(--accent);
        }
        .skill-form-row {
          display: flex;
          gap: var(--space-2, 8px);
        }
        .skill-form-row > :global(*) {
          flex: 1;
          min-width: 0;
        }
        .skill-form-switch {
          align-items: center;
          color: var(--text-secondary);
          font-size: 13px;
        }
        .skill-form-error {
          margin: 0;
          font-size: 12px;
          color: var(--err);
        }
        .skill-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: var(--space-2, 8px);
          margin-top: var(--space-3, 12px);
        }
        .skill-prompt-view {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 12px;
          line-height: 1.6;
          max-height: 50vh;
          overflow: auto;
        }
      `}</style>
    </div>
  );
}

/** 技能分区:标题 + 卡片网格;actions(a) 渲染卡片右上操作按钮。 */
function Section({
  title,
  empty,
  agents,
  onView,
  children,
}: {
  title: string;
  empty: string;
  agents: Agent[];
  onView: (a: Agent) => void;
  children: (a: Agent) => React.ReactNode;
}) {
  return (
    <section className="skill-section">
      <h2 className="skill-section-title">{title}</h2>
      <div className={`skill-grid${agents.length === 0 ? " is-empty" : ""}`}>
        {agents.length === 0 ? (
          <p className="skill-empty">{empty}</p>
        ) : (
          agents.map((a) => (
            <article key={a.id} className="skill-card">
              <div className="skill-card-head">
                <Icon name={iconOf(a)} size={15} />
                <button
                  type="button"
                  className="skill-card-name"
                  title="查看提示词"
                  style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, color: "inherit", textAlign: "left" }}
                  onClick={() => onView(a)}
                >
                  {a.name}
                </button>
                {children(a)}
              </div>
              {a.description && <p className="skill-card-desc">{a.description}</p>}
              <div className="skill-card-tags">
                <span className="skill-tag">{a.applies_to.includes("all") ? "全部" : a.applies_to.join("/")}</span>
                {a.is_nsfw && <span className="skill-tag is-nsfw">R18</span>}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

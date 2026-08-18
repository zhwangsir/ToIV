"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
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
/* 样式在 app/styles/skills.css(文件级):Section 子组件元素不被 styled-jsx
   注入哈希类,作用域样式会静默失效(网格退化单列),故迁文件样式与 library.css 同范式 */
import "@/app/styles/skills.css";

/**
 * Skill 市场(2026-08-18,替代「Agent 团队」导航位;同日排版重做接入全站范式):
 * single-view 版心 + compact 页头;内置/公共/我的技能三区;技能卡网格(同行等高、
 * tags 压底);支持 粘贴 JSON 或手填表单导入个人技能,属主可改可删;任意技能可分享。
 */

const APPLIES_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "image,video", label: "图片 + 视频" },
];

/** 图标下拉选项(与 Icon.tsx ICON_MAP 智能体图标键对齐,防自由文本填非法名)。 */
const ICON_OPTIONS: IconName[] = [
  "sparkles",
  "camera",
  "palette",
  "film",
  "brush",
  "cpu",
  "package",
  "mic",
  "database",
];

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
  return ICON_OPTIONS.includes(a.icon as IconName) ? (a.icon as IconName) : "sparkles";
}

function appliesLabel(a: Agent): string {
  if (a.applies_to.includes("all")) return "全部";
  const map = new Map(APPLIES_OPTIONS.map((o) => [o.value, o.label]));
  return a.applies_to.map((v) => map.get(v) ?? v).join(" / ");
}

export function SkillMarketView() {
  const toast = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    // listAgents 失败静默返回 [](优雅降级,与 OptimizeButton 同款);空列表走分区空态
    setAgents(await listAgents());
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
  const [promptError, setPromptError] = useState<string | null>(null); // system_prompt 字段级错误

  const openImport = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setJsonText("");
    setFormError(null);
    setPromptError(null);
    setImportOpen(true);
  };

  const openEdit = (a: Agent) => {
    setEditing(a);
    setForm({
      name: a.name,
      description: a.description,
      icon: iconOf(a),
      applies_to: a.applies_to.join(","),
      system_prompt: a.system_prompt,
      is_nsfw: a.is_nsfw,
      llm_model_override: a.llm_model_override,
    });
    setFormError(null);
    setPromptError(null);
    setImportOpen(true);
  };

  async function submitImport() {
    setFormError(null);
    setPromptError(null);
    setSubmitting(true);
    try {
      if (jsonMode && !editing) {
        let payload: SkillSharePayload;
        try {
          payload = JSON.parse(jsonText) as SkillSharePayload;
        } catch {
          throw new Error("JSON 解析失败,请检查格式");
        }
        if (!payload?.name || !payload?.system_prompt) {
          throw new Error("JSON 缺少必填字段 name / system_prompt");
        }
        const a = await importSkill({ ...EMPTY_FORM, ...payload });
        toast.success(`技能「${a.name}」已导入`);
      } else if (editing) {
        if (!form.name.trim()) throw new Error("请填写名称");
        if (!form.system_prompt.trim()) {
          setPromptError("请填写提示词");
          throw new Error("请填写提示词");
        }
        await updateAgent(editing.id, {
          name: form.name.trim(),
          description: form.description,
          icon: form.icon,
          applies_to: form.applies_to.split(","),
          system_prompt: form.system_prompt,
          is_nsfw: form.is_nsfw,
        });
        toast.success("技能已更新");
      } else {
        if (!form.name.trim()) throw new Error("请填写名称");
        if (!form.system_prompt.trim()) {
          setPromptError("请填写提示词");
          throw new Error("请填写提示词");
        }
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
    <div className="single-view skill-market">
      {/* 2026-08-18 页头移除(灵动岛已指示当前板块):导入按钮收进首区头行右侧 */}
      {loading ? (
        <LoadingBlock variant="grid" count={6} />
      ) : (
        <>
          <section className="skill-section">
            <div className="skill-section-head">
              <h2 className="skill-section-title">我的技能</h2>
              <span className="skill-section-count" aria-label={`${mine.length} 个`}>
                {mine.length}
              </span>
              <div className="skill-section-actions">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Icon name="download" size={14} />}
                  onClick={openImport}
                >
                  导入技能
                </Button>
              </div>
            </div>
            <div className="skill-grid">
              {mine.length === 0 ? (
                <p className="skill-empty">
                  还没有个人技能——点右上「导入技能」,或粘贴他人分享的 JSON
                </p>
              ) : (
                mine.map((a) => (
                  <article key={a.id} className="skill-card">
                    <div className="skill-card-head">
                      <Icon name={iconOf(a)} size={15} />
                      <button
                        type="button"
                        className="skill-card-name"
                        title="查看提示词"
                        onClick={() => setViewing(a)}
                      >
                        {a.name}
                      </button>
                      <button type="button" className="skill-card-act" title="编辑" onClick={() => openEdit(a)}>
                        <Icon name="pencil" size={13} />
                      </button>
                      <button type="button" className="skill-card-act" title="分享(复制 JSON)" onClick={() => void share(a)}>
                        <Icon name="share" size={13} />
                      </button>
                      <button type="button" className="skill-card-act is-danger" title="删除" onClick={() => setDeleting(a)}>
                        <Icon name="delete" size={13} />
                      </button>
                    </div>
                    {a.description && <p className="skill-card-desc">{a.description}</p>}
                    <div className="skill-card-tags">
                      <span className="skill-tag">{appliesLabel(a)}</span>
                      <span className="skill-tag">我的</span>
                      {a.is_nsfw && <span className="skill-tag is-nsfw">R18</span>}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <Section
            title="公共技能"
            count={pub.length}
            empty="暂无公共自定义技能(管理员可在管理页创建)"
            agents={pub}
            onView={setViewing}
          >
            {(a) => (
              <button type="button" className="skill-card-act" title="分享(复制 JSON)" onClick={() => void share(a)}>
                <Icon name="share" size={13} />
              </button>
            )}
          </Section>

          <Section
            title="内置技能"
            count={builtin.length}
            empty=""
            agents={builtin}
            onView={setViewing}
          >
            {(a) => (
              <button type="button" className="skill-card-act" title="分享(复制 JSON)" onClick={() => void share(a)}>
                <Icon name="share" size={13} />
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
          <div className="skill-import-mode" role="tablist" aria-label="导入方式">
            <button
              type="button"
              role="tab"
              aria-selected={!jsonMode}
              className={`skill-mode-btn${!jsonMode ? " is-on" : ""}`}
              onClick={() => setJsonMode(false)}
            >
              手填表单
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={jsonMode}
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
              <Input value={form.name} maxLength={120} placeholder="如:赛璐璐复古风" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="描述(可选)">
              <Input
                value={form.description}
                maxLength={500}
                placeholder="一句话说明风格效果"
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>
            <div className="skill-form-row">
              <Field label="图标">
                <select
                  className="input"
                  value={form.icon}
                  onChange={(e) => setForm({ ...form, icon: e.target.value })}
                >
                  {ICON_OPTIONS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="适用范围">
                <select
                  className="input"
                  value={form.applies_to}
                  onChange={(e) => setForm({ ...form, applies_to: e.target.value })}
                >
                  {APPLIES_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="提示词(system prompt)" hint="技能人格:优化时拼接在原提示词之前" error={promptError ?? undefined}>
              <Textarea
                rows={6}
                value={form.system_prompt}
                maxLength={20000}
                placeholder="你是……风格的提示词工程师。正向提示词必含……"
                onChange={(e) => {
                  setForm({ ...form, system_prompt: e.target.value });
                  if (promptError) setPromptError(null);
                }}
              />
            </Field>
            <div className="skill-form-switch">
              <span>R18 技能(需在 R18 模式下导入)</span>
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
        <p className="skill-delete-text">确定删除技能「{deleting?.name}」?此操作不可撤销。</p>
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
          display: flex;
          flex-direction: column;
          gap: var(--space-5);
          min-height: 0;
        }
        .skill-section {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .skill-section-head {
          display: flex;
          align-items: baseline;
          gap: var(--space-2);
        }
        .skill-section-title {
          margin: 0;
          font-size: var(--text-label);
          font-weight: var(--font-medium);
          letter-spacing: 0.04em;
          color: var(--text-muted);
          text-transform: uppercase;
        }
        .skill-section-count {
          font-size: var(--text-label);
          color: var(--text-muted);
          font-variant-numeric: tabular-nums;
        }
        .skill-grid {
          display: grid;
          /* min() 根治超窄容器(分屏/折叠屏)轨道溢出 */
          grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr));
          gap: var(--space-3);
        }
        .skill-empty {
          margin: 0;
          color: var(--text-muted);
          font-size: var(--text-aux);
          padding: var(--space-2) 0 var(--space-1);
        }
        .skill-card {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-3) var(--space-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-card);
          background: var(--bg-surface-2);
          transition: border-color var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .skill-card:hover {
          border-color: var(--accent-glow);
          transform: translateY(-1px);
          box-shadow: var(--shadow-lift);
        }
        .skill-card-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .skill-card-name {
          flex: 1;
          min-width: 0;
          font-size: var(--text-body);
          color: var(--text-primary);
          text-align: left;
          border: none;
          background: transparent;
          padding: 0;
          cursor: pointer;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .skill-card-name:hover {
          color: var(--accent);
        }
        .skill-card-act {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border: none;
          border-radius: var(--radius-sm);
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          flex-shrink: 0;
        }
        .skill-card-act:hover {
          background: var(--bg-surface-3);
          color: var(--text-primary);
        }
        .skill-card-act.is-danger:hover {
          color: var(--err);
        }
        .skill-card-desc {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .skill-card-tags {
          /* 压底:同行网格卡片(有无 desc/R18)底边对齐 */
          margin-top: auto;
          display: flex;
          gap: var(--space-1);
          flex-wrap: wrap;
        }
        .skill-tag {
          font-size: var(--text-caption);
          padding: 1px 8px;
          border-radius: var(--radius-full);
          border: 1px solid var(--border-subtle);
          color: var(--text-muted);
        }
        .skill-tag.is-nsfw {
          color: var(--err);
          border-color: var(--err);
        }
        .skill-import-mode {
          display: flex;
          gap: var(--space-2);
          margin-bottom: var(--space-3);
        }
        .skill-mode-btn {
          flex: 1;
          min-height: 40px;
          font-size: var(--text-body);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
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
          gap: var(--space-2);
        }
        .skill-form-row > :global(*) {
          flex: 1;
          min-width: 0;
        }
        .skill-form-switch {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-2) 0;
          color: var(--text-secondary);
          font-size: var(--text-body);
        }
        .skill-form-error {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--err);
        }
        .skill-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: var(--space-2);
          margin-top: var(--space-3);
        }
        .skill-delete-text {
          margin: 0;
          color: var(--text-secondary);
        }
        .skill-prompt-view {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: var(--text-aux);
          line-height: 1.6;
          max-height: 50vh;
          overflow: auto;
        }
        @media (max-width: 575px) {
          .skill-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: var(--space-2);
          }
          .skill-card {
            padding: var(--space-2);
          }
          .skill-card-act {
            width: 24px;
            height: 24px;
          }
        }
      `}</style>
    </div>
  );
}

/** 技能分区:标题行(小写铭牌 + 计数)+ 卡片网格;children(a) 渲染卡片操作按钮。 */
function Section({
  title,
  count,
  empty,
  agents,
  onView,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  agents: Agent[];
  onView: (a: Agent) => void;
  children: (a: Agent) => React.ReactNode;
}) {
  return (
    <section className="skill-section">
      <div className="skill-section-head">
        <h2 className="skill-section-title">{title}</h2>
        <span className="skill-section-count" aria-label={`${count} 个`}>
          {count}
        </span>
      </div>
      <div className="skill-grid">
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
                  onClick={() => onView(a)}
                >
                  {a.name}
                </button>
                {children(a)}
              </div>
              {a.description && <p className="skill-card-desc">{a.description}</p>}
              <div className="skill-card-tags">
                <span className="skill-tag">{appliesLabel(a)}</span>
                {a.is_mine && <span className="skill-tag">我的</span>}
                {a.is_nsfw && <span className="skill-tag is-nsfw">R18</span>}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

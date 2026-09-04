"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
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
 *
 * 2026-08-18 检索增强:工具栏提供 名称/描述搜索 + 适用范围筛选(全部/图片/视频/音频)
 * + R18 过滤,三区共用同一过滤条件(客户端过滤,即时生效)。
 */

const APPLIES_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "image,video", label: "图片 + 视频" },
];

/** 检索工具栏的适用范围 chips(all=不过滤;其余按 applies_to 包含匹配,含 all 的技能恒中)。 */
const SCOPE_CHIPS: { value: string; label: string }[] = [
  { value: "all", label: "全部范围" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
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
  // 列表加载失败(2026-08-30 UX 批 C:listAgents 改抛错):错误态 + 重试,区分「空」与「挂了」
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── 检索(2026-08-18):搜索词 + 适用范围 + R18,三区共用 ──
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [nsfwOnly, setNsfwOnly] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setAgents(await listAgents());
    } catch (e) {
      setAgents([]);
      setLoadError(e instanceof Error ? e.message : "技能列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 客户端过滤:名称/描述包含搜索词(不区分大小写)+ 范围包含匹配 + R18 开关。 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (q && !`${a.name}\n${a.description}`.toLowerCase().includes(q)) return false;
      if (scope !== "all" && !(a.applies_to.includes("all") || a.applies_to.includes(scope))) {
        return false;
      }
      if (nsfwOnly && !a.is_nsfw) return false;
      return true;
    });
  }, [agents, query, scope, nsfwOnly]);

  const mine = useMemo(() => filtered.filter((a) => a.is_mine), [filtered]);
  const builtin = useMemo(() => filtered.filter((a) => a.is_builtin && !a.is_mine), [filtered]);
  const pub = useMemo(() => filtered.filter((a) => a.is_public_custom), [filtered]);
  const filtering = query.trim() !== "" || scope !== "all" || nsfwOnly;

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

  // 分享复制失败兜底(2026-08-30 UX 批 C):剪贴板不可用(非安全上下文/权限拒绝)时
  // 弹 Modal 展示 JSON 供手动全选复制,替代原生 prompt 弹窗
  const [shareFallback, setShareFallback] = useState<{ name: string; json: string } | null>(null);

  async function share(a: Agent) {
    const json = JSON.stringify(serializeSkillShare(a), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      toast.success("技能 JSON 已复制,发给他人即可导入");
    } catch {
      setShareFallback({ name: a.name, json });
      toast.info("自动复制失败,请在弹窗中手动全选复制");
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
      ) : loadError ? (
        /* 加载失败:ErrorBar + 条外重试,不再静默显示空市场 */
        <div className="skill-load-error">
          <ErrorBar message={loadError} onClose={() => setLoadError(null)} />
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="refresh" size={13} />}
            onClick={() => void refresh()}
          >
            重试
          </Button>
        </div>
      ) : (
        <>
          {/* 检索工具栏:搜索 + 适用范围 chips + R18(客户端即时过滤,三区共用) */}
          <div className="skill-toolbar" role="search">
            <div className="skill-toolbar-search">
              <Icon name="search" size={14} strokeWidth={1.8} />
              <input
                type="search"
                className="skill-search-input"
                placeholder="搜索技能名称或描述…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索技能"
              />
            </div>
            <div className="skill-toolbar-chips" role="group" aria-label="按适用范围筛选">
              {SCOPE_CHIPS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={`skill-chip${scope === c.value ? " is-on" : ""}`}
                  aria-pressed={scope === c.value}
                  onClick={() => setScope(c.value)}
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button"
                className={`skill-chip skill-chip--nsfw${nsfwOnly ? " is-on" : ""}`}
                aria-pressed={nsfwOnly}
                onClick={() => setNsfwOnly((v) => !v)}
                title="仅显示 R18 技能(需在 R18 模式下可见)"
              >
                R18
              </button>
            </div>
          </div>

          {(filtering && mine.length + builtin.length + pub.length === 0) && (
            /* 空态升级(2026-09-04 美化 W4):单行 muted → 共享三档空态 inline 档 */
            <Empty size="inline" title="没有匹配的技能——换个关键词,或清除筛选条件" />
          )}

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
                <Empty size="inline" title="还没有个人技能——点右上「导入技能」,或粘贴他人分享的 JSON" />
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

      {/* 删除确认(danger 确认键,与删除语义一致) */}
      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)} title="删除技能" danger>
        <p className="skill-delete-text">确定删除技能「{deleting?.name}」?此操作不可撤销。</p>
        <div className="skill-form-actions">
          <Button variant="ghost" size="sm" onClick={() => setDeleting(null)} disabled={deleteBusy}>
            取消
          </Button>
          <Button variant="danger" size="sm" loading={deleteBusy} onClick={() => void confirmDelete()}>
            删除
          </Button>
        </div>
      </Modal>

      {/* 分享复制失败兜底:剪贴板不可用时手动全选复制 */}
      <Modal
        open={Boolean(shareFallback)}
        onClose={() => setShareFallback(null)}
        title={shareFallback ? `分享技能 · ${shareFallback.name}` : ""}
        width={560}
      >
        <Field label="技能 JSON" hint="点击文本框后 Ctrl/Cmd+A 全选,Ctrl/Cmd+C 复制">
          <Textarea
            rows={12}
            readOnly
            value={shareFallback?.json ?? ""}
            onFocus={(e) => e.target.select()}
          />
        </Field>
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
          /* empty 文案为空(如内置技能区)时不渲染空态占位;
             空态升级(2026-09-04 美化 W4):共享三档空态 inline 档,grid 内占满整行 */
          empty ? (
            <Empty size="inline" title={empty} />
          ) : null
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import {
  confirmAppImport,
  createApp,
  deleteApp,
  importAppDraft,
  listApps,
  preflightApp,
  bulkSetPublic,
  putCuration,
  retagOne,
  smokeOne,
  togglePublic,
  uploadAppCover,
  type AdminApp,
  type AdminAppCreateBody,
  type PreflightResult,
} from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";

const USE_CASES = [
  "photo", "face", "edit", "fashion", "drama", "motion",
  "art", "anime", "avatar", "ecommerce", "ad", "other",
] as const;

type RowState = { busy?: boolean; note?: string };
type Toast = { msg: string; tone: "ok" | "err" };

/** id 前端预检(小写字母/数字/连字符;后端另有 ≤64 长度约束)。 */
const APP_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 产物类型选项(与后端 _OUTPUT_KINDS 同源 + 3d 家族;非法值后端 422 内联透出)。 */
const OUTPUT_KIND_OPTIONS = ["image", "video", "audio", "3d"] as const;
/** 分类基线集(与后端 _CATEGORIES 同源),再并上列表中实见的分类。 */
const BASE_CATEGORIES = ["image", "video", "audio", "edit", "3d", "other"];
const COVER_MAX_BYTES = 8 * 1024 * 1024;
const TOAST_MS = 4000;

/** 导入草稿(与后端 AppImportDraftOut 对齐)。 */
type ImportDraft = {
  draft_id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  output_kind: string;
  is_nsfw_guess: boolean;
  params_schema: unknown[];
  bindings: Record<string, unknown>;
  warnings: string[];
};

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** 粘贴文本 → workflow 对象;不合法抛中文错,供表单内联展示。 */
function parseWorkflowText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("请先粘贴 workflow JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`JSON 解析失败: ${e instanceof Error ? e.message : "格式错误"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workflow JSON 须为对象(节点 id → 节点定义)");
  }
  return parsed as Record<string, unknown>;
}

export function AppsManager() {
  const [apps, setApps] = useState<AdminApp[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "public" | "hidden" | "smoke-fail" | "smoke-untested">("all");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // Admin P1 内容运营:toast/勾选/批量/封面/弹窗态
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<AdminApp | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");
  const [coverTs, setCoverTs] = useState<Record<string, number>>({});
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverForRef = useRef<string | null>(null);

  const showToast = useCallback((msg: string, tone: "ok" | "err" = "ok") => {
    setToast({ msg, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const load = useCallback(async () => {
    try {
      const list = await listApps(q);
      setApps(list);
      // 刷新后剪掉已不在列表中的勾选(删除/搜索缩圈)
      const ids = new Set(list.map((a) => a.id));
      setSel((prev) => new Set([...prev].filter((id) => ids.has(id))));
    } catch (e) {
      setErr(errMsg(e, "加载失败"));
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const visible = useMemo(() => {
    const list = apps ?? [];
    if (filter === "public") return list.filter((a) => a.is_public);
    if (filter === "hidden") return list.filter((a) => !a.is_public);
    if (filter === "smoke-fail") return list.filter((a) => a.smoke_status === "fail" || a.smoke_status === "timeout");
    if (filter === "smoke-untested") return list.filter((a) => !a.smoke_status || a.smoke_status === "untested");
    return list;
  }, [apps, filter]);

  const rendered = useMemo(() => visible.slice(0, 120), [visible]);

  /** 分类选项 = 后端基线集 ∪ 列表实见分类(读现有分类集)。 */
  const categories = useMemo(() => {
    const s = new Set<string>(BASE_CATEGORIES);
    for (const a of apps ?? []) if (a.category) s.add(a.category);
    return [...s];
  }, [apps]);

  const allChecked = rendered.length > 0 && rendered.every((a) => sel.has(a.id));

  const toggleAll = () =>
    setSel((prev) => {
      const next = new Set(prev);
      if (allChecked) rendered.forEach((a) => next.delete(a.id));
      else rendered.forEach((a) => next.add(a.id));
      return next;
    });

  const toggleOne = (id: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const mark = (id: string, patch: RowState) =>
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const doSmoke = async (a: AdminApp) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      const r = (await smokeOne(a.id)) as { status?: string; cls?: string };
      mark(a.id, { busy: false, note: `烟测 ${r.status ?? "?"}` });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: errMsg(e, "烟测出错") });
    }
  };

  const doRetag = async (a: AdminApp) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      const r = await retagOne(a.id);
      mark(a.id, { busy: false, note: `→ ${r.use_case}` });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: errMsg(e, "打标出错") });
    }
  };

  const doCuration = async (a: AdminApp, useCase: string) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      await putCuration(a.id, { use_case: useCase });
      mark(a.id, { busy: false, note: `分类 → ${useCase}` });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: errMsg(e, "策展出错") });
    }
  };

  const toggleFeatured = async (a: AdminApp) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      await putCuration(a.id, { featured: !a.featured });
      mark(a.id, { busy: false });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: errMsg(e, "策展出错") });
    }
  };

  const togglePublicState = async (a: AdminApp) => {
    mark(a.id, { busy: true, note: undefined });
    try {
      await togglePublic(a.id, !a.is_public);
      mark(a.id, { busy: false });
      await load();
    } catch (e) {
      mark(a.id, { busy: false, note: errMsg(e, "切换出错") });
    }
  };

  // ---------- Admin P1:封面/删除/批量精选 ----------

  const pickCover = (a: AdminApp) => {
    coverForRef.current = a.id;
    coverInputRef.current?.click();
  };

  const onCoverFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const id = coverForRef.current;
    coverForRef.current = null;
    if (!file || !id) return;
    if (file.size > COVER_MAX_BYTES) {
      mark(id, { note: "封面图过大(上限 8MB)" });
      return;
    }
    mark(id, { busy: true, note: undefined });
    try {
      const r = await uploadAppCover(id, file);
      const newUrl = typeof r.cover_url === "string" && r.cover_url ? r.cover_url : null;
      if (newUrl) {
        setApps((prev) =>
          prev ? prev.map((x) => (x.id === id ? { ...x, cover_url: newUrl } : x)) : prev,
        );
      }
      setCoverTs((prev) => ({ ...prev, [id]: Date.now() }));
      mark(id, { busy: false, note: "封面已更新" });
    } catch (err2) {
      mark(id, { busy: false, note: errMsg(err2, "封面上传失败") });
    }
  };

  const doDeleteApp = async () => {
    if (!delTarget) return;
    setDelBusy(true);
    setDelErr("");
    try {
      await deleteApp(delTarget.id);
      const name = delTarget.name;
      setApps((prev) => (prev ? prev.filter((x) => x.id !== delTarget.id) : prev));
      setSel((prev) => {
        const next = new Set(prev);
        next.delete(delTarget.id);
        return next;
      });
      setDelTarget(null);
      showToast(`已删除应用「${name}」`);
    } catch (e) {
      setDelErr(errMsg(e, "删除失败"));
    } finally {
      setDelBusy(false);
    }
  };


  /** 批量 soft-hide / 上架:走 bulk-public 端点,单次最多 200。 */
  const bulkPublic = async (is_public: boolean) => {
    const ids = [...sel];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const r = await bulkSetPublic(ids, is_public);
      showToast(
        `${is_public ? "批量上架" : "批量软隐藏"}完成:成功 ${r.done} / 缺失 ${r.missing}`,
        r.missing > 0 ? "err" : "ok",
      );
      setSel(new Set());
      await load();
    } catch (e) {
      showToast(errMsg(e, "批量上下架失败"), "err");
    } finally {
      setBulkBusy(false);
    }
  };

  /** 批量精选:顺序循环逐条 putCuration,单条失败不中断,toast 汇总。 */
  const bulkFeature = async (featured: boolean) => {
    const ids = [...sel];
    if (ids.length === 0) return;
    setBulkBusy(true);
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        await putCuration(id, { featured });
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBulkBusy(false);
    showToast(
      `${featured ? "设为精选" : "取消精选"}完成:成功 ${ok} / 失败 ${fail}`,
      fail > 0 ? "err" : "ok",
    );
    setSel(new Set());
    await load();
  };

  return (
    <div>
      <div className="bar">
        <input
          style={{ width: 280 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索名称/简介…"
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">全部应用</option>
          <option value="public">仅已上架</option>
          <option value="hidden">仅软隐藏</option>
          <option value="smoke-fail">烟测失败/超时</option>
          <option value="smoke-untested">烟测未测</option>
        </select>
        <button className="btn primary" onClick={() => setCreateOpen(true)}>
          新建应用
        </button>
        <button className="btn" onClick={() => setImportOpen(true)}>
          导入工作流
        </button>
        <button className="btn" onClick={() => setPreflightOpen(true)}>
          预检
        </button>
        <div className="spacer" />
        <span className="muted">{visible.length} 个应用</span>
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </div>
      {err && <div className="login-err">{err}</div>}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="apm-checkcol">
                <input
                  type="checkbox"
                  aria-label="全选当前显示行"
                  checked={allChecked}
                  onChange={toggleAll}
                />
              </th>
              <th>封面</th>
              <th>应用</th>
              <th>产物</th>
              <th>分类</th>
              <th>上架</th>
              <th>烟测</th>
              <th className="num">用量</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rendered.map((a) => {
              const st = rows[a.id] ?? {};
              const coverSrc = a.cover_url
                ? `${a.cover_url}${a.cover_url.includes("?") ? "&" : "?"}token=${typeof window !== "undefined" ? window.localStorage.getItem("toiv_admin_token") ?? "" : ""}${coverTs[a.id] ? `&t=${coverTs[a.id]}` : ""}`
                : "";
              return (
                <tr key={a.id}>
                  <td className="apm-checkcol">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${a.name}`}
                      checked={sel.has(a.id)}
                      onChange={() => toggleOne(a.id)}
                    />
                  </td>
                  <td>
                    {a.cover_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="cover-thumb" src={coverSrc} alt="" />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <div>{a.name}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{a.id}</div>
                    {st.note && <div className="pill warn">{st.note}</div>}
                  </td>
                  <td>{a.output_kind}</td>
                  <td>
                    <select
                      value={USE_CASES.includes((a.use_case ?? "") as never) ? a.use_case : "other"}
                      disabled={st.busy}
                      onChange={(e) => void doCuration(a, e.target.value)}
                    >
                      {USE_CASES.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className={`act-btn${a.is_public ? " is-done" : ""}`}
                      title="切换上架(公开)状态"
                      onClick={() => void togglePublicState(a)}
                    >
                      {a.is_public ? "已上架" : "未上架"}
                    </button>
                    {a.featured && <span className="pill on">精选</span>}
                    {a.is_nsfw && <span className="pill danger">R18</span>}
                  </td>
                  <td>
                    <span
                      className={`pill${a.smoke_status === "pass" ? " ok" : a.smoke_status === "fail" || a.smoke_status === "timeout" ? " danger" : ""}`}
                    >
                      {a.smoke_status || "未测"}
                    </span>
                  </td>
                  <td className="num">{a.usage_count}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className={`act-btn${st.busy ? " is-busy" : ""}`}
                      disabled={st.busy}
                      onClick={() => void doSmoke(a)}
                    >
                      烟测
                    </button>
                    <button
                      className={`act-btn${st.busy ? " is-busy" : ""}`}
                      disabled={st.busy}
                      onClick={() => void doRetag(a)}
                    >
                      重打标
                    </button>
                    <button
                      className={`act-btn${a.featured ? " is-done" : ""}`}
                      disabled={st.busy}
                      onClick={() => void toggleFeatured(a)}
                    >
                      {a.featured ? "取消精选" : "设精选"}
                    </button>
                    <button
                      className={`act-btn${st.busy ? " is-busy" : ""}`}
                      disabled={st.busy}
                      title="上传封面(png/jpg/webp/gif ≤8MB)"
                      onClick={() => pickCover(a)}
                    >
                      封面
                    </button>
                    {!a.is_builtin && (
                      <button
                        className="act-btn"
                        disabled={st.busy}
                        title="删除应用(不影响已生成作品)"
                        onClick={() => {
                          setDelTarget(a);
                          setDelErr("");
                        }}
                      >
                        删除
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length > 120 && (
          <div className="muted" style={{ padding: 10 }}>
            仅显示前 120 个,用搜索缩小范围。
          </div>
        )}
      </div>

      {/* 封面上传:单例隐藏 input,点击行内「封面」时记录目标 app */}
      <input
        ref={coverInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: "none" }}
        onChange={(e) => void onCoverFile(e)}
      />

      {/* 批量精选浮动操作条 */}
      {sel.size > 0 && (
        <div className="apm-bulkbar">
          <span className="muted">已选 {sel.size} 个应用</span>
          <button
            className="btn"
            disabled={bulkBusy}
            onClick={() => void bulkPublic(false)}
          >
            批量软隐藏({sel.size})
          </button>
          <button className="btn" disabled={bulkBusy} onClick={() => void bulkPublic(true)}>
            批量上架({sel.size})
          </button>
          <button
            className="btn primary"
            disabled={bulkBusy}
            onClick={() => void bulkFeature(true)}
          >
            设为精选({sel.size})
          </button>
          <button className="btn" disabled={bulkBusy} onClick={() => void bulkFeature(false)}>
            取消精选({sel.size})
          </button>
          <button className="btn" disabled={bulkBusy} onClick={() => setSel(new Set())}>
            清空选择
          </button>
        </div>
      )}

      {toast && <div className={`apm-toast ${toast.tone}`}>{toast.msg}</div>}

      <CreateAppModal
        open={createOpen}
        categories={categories}
        onClose={() => setCreateOpen(false)}
        onCreated={(name) => {
          showToast(`已创建应用「${name}」`);
          void load();
        }}
      />
      <ImportAppModal
        open={importOpen}
        categories={categories}
        onClose={() => setImportOpen(false)}
        onImported={(name) => {
          showToast(`已导入为个人应用「${name}」,在列表中上架后才会公开`);
          void load();
        }}
      />
      <PreflightModal open={preflightOpen} onClose={() => setPreflightOpen(false)} />

      {/* 删除确认(danger;明示不影响已生成作品) */}
      <Modal
        open={delTarget !== null}
        onClose={() => setDelTarget(null)}
        title="删除应用"
        danger
        preventClose={delBusy}
        width={420}
        footer={
          <>
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={delBusy}
              onClick={() => setDelTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="at-btn at-btn--danger"
              disabled={delBusy}
              onClick={() => void doDeleteApp()}
            >
              {delBusy ? "删除中…" : "确认删除"}
            </button>
          </>
        }
      >
        <div className="apm-form">
          <p className="apm-hint">
            确定删除应用「{delTarget?.name}」({delTarget?.id})?
            删除应用不影响已生成的作品,仅移除应用本身;该操作不可恢复。
          </p>
          {delErr && <div className="apm-err">{delErr}</div>}
        </div>
      </Modal>

      <style jsx global>{`
        .apm-checkcol {
          width: 30px;
          text-align: center;
        }
        .apm-toast {
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: var(--z-toast);
          max-width: 420px;
          padding: 10px 16px;
          border-radius: var(--radius);
          background: var(--surface-1);
          border: 1px solid var(--border);
          color: var(--text-1);
          font-size: 13px;
          box-shadow: var(--shadow-pop);
        }
        .apm-toast.ok {
          border-color: var(--ok);
        }
        .apm-toast.err {
          border-color: var(--danger);
          color: var(--danger);
        }
        .apm-bulkbar {
          position: fixed;
          left: 50%;
          bottom: 20px;
          transform: translateX(-50%);
          z-index: var(--z-toast);
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          border-radius: 12px;
          background: var(--surface-1);
          border: 1px solid var(--border);
          box-shadow: var(--shadow-pop);
        }
        /* 以下为 Modal 内表单:Modal 卡片是 web 亮色系,统一用 web token */
        .apm-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .apm-field {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .apm-label {
          font-size: var(--text-aux);
          color: var(--text-secondary);
          font-weight: var(--font-medium);
        }
        .apm-hint {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.55;
        }
        .apm-err {
          padding: var(--space-2) var(--space-3);
          background: var(--err-soft);
          border: 1px solid var(--err);
          border-radius: var(--radius-badge);
          color: var(--err);
          font-size: var(--text-aux);
          line-height: 1.45;
          word-break: break-all;
        }
        .apm-textarea {
          font-family: var(--font-mono);
          font-size: 12px;
          min-height: 120px;
          resize: vertical;
        }
        .apm-kv {
          display: flex;
          gap: var(--space-2);
          font-size: var(--text-body);
          color: var(--text-primary);
          align-items: baseline;
        }
        .apm-kv .k {
          flex-shrink: 0;
          width: 64px;
          font-size: var(--text-aux);
          color: var(--text-muted);
        }
        .apm-warn-list {
          margin: 0;
          padding-left: 18px;
          color: var(--warn);
          font-size: var(--text-aux);
          line-height: 1.6;
        }
        .apm-mono-list {
          margin: 0;
          padding-left: 18px;
          font-family: var(--font-mono);
          font-size: var(--text-aux);
          color: var(--text-secondary);
          line-height: 1.6;
          word-break: break-all;
        }
        .apm-verdict {
          display: inline-block;
          padding: 4px 14px;
          border-radius: 999px;
          border: 1px solid var(--border-strong);
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-secondary);
        }
        .apm-verdict.ok {
          color: var(--ok);
          border-color: var(--ok);
          background: var(--ok-soft);
        }
        .apm-verdict.err {
          color: var(--err);
          border-color: var(--err);
          background: var(--err-soft);
        }
        .apm-preflight-result {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          padding-top: var(--space-3);
          border-top: 1px solid var(--border-subtle);
        }
        .apm-chips {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-2);
        }
        .apm-chip {
          display: inline-block;
          padding: 1px 8px;
          border-radius: 999px;
          border: 1px solid var(--err);
          color: var(--err);
          font-size: var(--text-aux);
          font-family: var(--font-mono);
        }
      `}</style>
    </div>
  );
}

// ---------- Admin P1:新建应用 ----------

function CreateAppModal({
  open,
  categories,
  onClose,
  onCreated,
}: {
  open: boolean;
  categories: string[];
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("other");
  const [outputKind, setOutputKind] = useState<string>("image");
  const [wfText, setWfText] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const idInvalid = id !== "" && (!APP_ID_RE.test(id) || id.length > 64);

  const reset = () => {
    setId("");
    setName("");
    setDescription("");
    setCategory("other");
    setOutputKind("image");
    setWfText("");
    setIsPublic(true);
    setErr("");
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async () => {
    setErr("");
    if (!APP_ID_RE.test(id) || id.length > 64) {
      setErr("id 须为小写字母/数字/连字符(≤64 字符)");
      return;
    }
    if (!name.trim()) {
      setErr("name 必填");
      return;
    }
    let wf: Record<string, unknown>;
    try {
      wf = parseWorkflowText(wfText);
    } catch (e) {
      setErr(errMsg(e, "workflow JSON 错误"));
      return;
    }
    setBusy(true);
    try {
      const body: AdminAppCreateBody = {
        id: id.trim(),
        name: name.trim(),
        description: description.trim(),
        category,
        output_kind: outputKind,
        workflow_json: wf,
        is_public: isPublic,
      };
      await createApp(body);
      const createdName = name.trim();
      reset();
      onClose();
      onCreated(createdName);
    } catch (e) {
      // 409 id 撞车 / 422 图-schema 交叉校验:后端 detail 内联透出
      setErr(errMsg(e, "创建失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="新建应用"
      preventClose={busy}
      width={560}
      footer={
        <>
          <button type="button" className="at-btn at-btn--ghost" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="at-btn at-btn--primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </>
      }
    >
      <div className="apm-form">
        <label className="apm-field">
          <span className="apm-label">应用 id(小写字母/数字/连字符)</span>
          <input
            className="input"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="my-new-app"
            disabled={busy}
          />
          {idInvalid && (
            <span className="apm-hint">id 格式非法:仅小写字母/数字/连字符,≤64 字符</span>
          )}
        </label>
        <label className="apm-field">
          <span className="apm-label">名称</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="apm-field">
          <span className="apm-label">简介(≤500 字)</span>
          <textarea
            className="input"
            style={{ minHeight: 60, resize: "vertical" }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="apm-field">
          <span className="apm-label">分类</span>
          <select
            className="input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            disabled={busy}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="apm-field">
          <span className="apm-label">产物类型</span>
          <select
            className="input"
            value={outputKind}
            onChange={(e) => setOutputKind(e.target.value)}
            disabled={busy}
          >
            {OUTPUT_KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="apm-field">
          <span className="apm-label">workflow JSON(API 格式:节点 id → 节点定义)</span>
          <textarea
            className="input apm-textarea"
            value={wfText}
            onChange={(e) => setWfText(e.target.value)}
            placeholder='{"1": {"class_type": "...", ...}}'
            disabled={busy}
          />
        </label>
        <Switch
          checked={isPublic}
          onChange={setIsPublic}
          disabled={busy}
          label="创建后立即上架(公开)"
          ariaLabel="创建后立即上架"
        />
        {err && <div className="apm-err">{err}</div>}
      </div>
    </Modal>
  );
}

// ---------- Admin P1:导入工作流(两阶段) ----------

function ImportAppModal({
  open,
  categories,
  onClose,
  onImported,
}: {
  open: boolean;
  categories: string[];
  onClose: () => void;
  onImported: (name: string) => void;
}) {
  const [stage, setStage] = useState<"paste" | "draft">("paste");
  const [wfText, setWfText] = useState("");
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("other");
  const [busy, setBusy] = useState<"" | "analyze" | "confirm">("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const draftCategories = useMemo(() => {
    const s = new Set(categories);
    if (draft?.category) s.add(draft.category);
    return [...s];
  }, [categories, draft]);

  const reset = () => {
    setStage("paste");
    setWfText("");
    setDraft(null);
    setName("");
    setDescription("");
    setCategory("other");
    setErr("");
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setWfText(String(reader.result ?? ""));
    reader.onerror = () => setErr("文件读取失败");
    reader.readAsText(f);
  };

  const analyze = async () => {
    setErr("");
    let wf: Record<string, unknown>;
    try {
      wf = parseWorkflowText(wfText);
    } catch (e) {
      setErr(errMsg(e, "workflow JSON 错误"));
      return;
    }
    setBusy("analyze");
    try {
      const d = (await importAppDraft(wf)) as unknown as ImportDraft;
      setDraft(d);
      setName(d.name);
      setDescription(d.description);
      setCategory(d.category);
      setStage("draft");
    } catch (e) {
      setErr(errMsg(e, "分析失败"));
    } finally {
      setBusy("");
    }
  };

  const confirm = async () => {
    if (!draft) return;
    setErr("");
    if (!name.trim()) {
      setErr("name 必填");
      return;
    }
    setBusy("confirm");
    try {
      await confirmAppImport({
        draft_id: draft.draft_id,
        overrides: { name: name.trim(), description: description.trim(), category },
      });
      const importedName = name.trim();
      reset();
      onClose();
      onImported(importedName);
    } catch (e) {
      setErr(errMsg(e, "导入确认失败"));
    } finally {
      setBusy("");
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={stage === "paste" ? "导入工作流" : "导入工作流 · 草稿预览"}
      preventClose={busy !== ""}
      width={640}
      footer={
        stage === "paste" ? (
          <>
            <button type="button" className="at-btn at-btn--ghost" disabled={busy !== ""} onClick={close}>
              取消
            </button>
            <button
              type="button"
              className="at-btn at-btn--primary"
              disabled={busy !== ""}
              onClick={() => void analyze()}
            >
              {busy === "analyze" ? "分析中…(LLM 包装约 1-2 分钟)" : "分析"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={busy !== ""}
              onClick={() => setStage("paste")}
            >
              重新粘贴
            </button>
            <button
              type="button"
              className="at-btn at-btn--primary"
              disabled={busy !== ""}
              onClick={() => void confirm()}
            >
              {busy === "confirm" ? "导入中…" : "确认导入"}
            </button>
          </>
        )
      }
    >
      {stage === "paste" ? (
        <div className="apm-form">
          <label className="apm-field">
            <span className="apm-label">workflow JSON(API 格式)</span>
            <textarea
              className="input apm-textarea"
              value={wfText}
              onChange={(e) => setWfText(e.target.value)}
              placeholder='{"1": {"class_type": "...", ...}}'
              disabled={busy !== ""}
            />
          </label>
          <div>
            <button
              type="button"
              className="at-btn at-btn--ghost"
              disabled={busy !== ""}
              onClick={() => fileRef.current?.click()}
            >
              或上传 .json 文件
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={onFile}
            />
          </div>
          <p className="apm-hint">
            分析由 LLM 完成包装(名称/简介/参数表单),草稿 10 分钟内有效、不落库;
            确认后落库为个人应用(is_public=false),需在列表中上架后才会公开。
          </p>
          {err && <div className="apm-err">{err}</div>}
        </div>
      ) : (
        draft && (
          <div className="apm-form">
            <div className="apm-kv">
              <span className="k">产物类型</span>
              <span>{draft.output_kind}</span>
            </div>
            <div className="apm-kv">
              <span className="k">参数数</span>
              <span>{draft.params_schema.length}</span>
            </div>
            <div className="apm-kv">
              <span className="k">图标</span>
              <span>{draft.icon}</span>
            </div>
            {draft.is_nsfw_guess && (
              <div className="apm-kv">
                <span className="k">内容分级</span>
                <span className="apm-chip">R18(猜测)</span>
              </div>
            )}
            {draft.warnings.length > 0 && (
              <div className="apm-field">
                <span className="apm-label">警告({draft.warnings.length})</span>
                <ul className="apm-warn-list">
                  {draft.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <label className="apm-field">
              <span className="apm-label">名称</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy !== ""}
              />
            </label>
            <label className="apm-field">
              <span className="apm-label">简介(≤500 字)</span>
              <textarea
                className="input"
                style={{ minHeight: 60, resize: "vertical" }}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={busy !== ""}
              />
            </label>
            <label className="apm-field">
              <span className="apm-label">分类</span>
              <select
                className="input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={busy !== ""}
              >
                {draftCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <p className="apm-hint">
              确认后落库为个人应用(仅自己可见),上架(切公开)后对全员可见。
            </p>
            {err && <div className="apm-err">{err}</div>}
          </div>
        )
      )}
    </Modal>
  );
}

// ---------- Admin P1:预检 ----------

function PreflightModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [wfText, setWfText] = useState("");
  const [nodesText, setNodesText] = useState("");
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    setErr("");
    let wf: Record<string, unknown>;
    try {
      wf = parseWorkflowText(wfText);
    } catch (e) {
      setErr(errMsg(e, "workflow JSON 错误"));
      return;
    }
    const nodes = nodesText
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(true);
    try {
      setResult(await preflightApp(wf, nodes));
    } catch (e) {
      setErr(errMsg(e, "预检失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="预检:模型/节点可得性"
      preventClose={busy}
      width={560}
      footer={
        <>
          <button type="button" className="at-btn at-btn--ghost" disabled={busy} onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="at-btn at-btn--primary"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? "预检中…" : result ? "重新预检" : "运行预检"}
          </button>
        </>
      }
    >
      <div className="apm-form">
        <label className="apm-field">
          <span className="apm-label">workflow JSON(API 格式)</span>
          <textarea
            className="input apm-textarea"
            value={wfText}
            onChange={(e) => setWfText(e.target.value)}
            placeholder='{"1": {"class_type": "...", ...}}'
            disabled={busy}
          />
        </label>
        <label className="apm-field">
          <span className="apm-label">required_nodes(逗号分隔,可空)</span>
          <input
            className="input"
            value={nodesText}
            onChange={(e) => setNodesText(e.target.value)}
            placeholder="KSampler, VAEDecode"
            disabled={busy}
          />
        </label>
        {err && <div className="apm-err">{err}</div>}
        {result && (
          <div className="apm-preflight-result">
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
              <span className={`apm-verdict ${result.procurable ? "ok" : "err"}`}>
                {result.procurable ? "依赖全可得" : "存在缺失依赖"}
              </span>
              <span className="apm-hint">模型总数 {result.total_models}</span>
            </div>
            {result.missing_nodes.length > 0 && (
              <div className="apm-field">
                <span className="apm-label">缺失节点({result.missing_nodes.length})</span>
                <div className="apm-chips">
                  {result.missing_nodes.map((n) => (
                    <span key={n} className="apm-chip">
                      {n}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {result.missing_models.length > 0 && (
              <div className="apm-field">
                <span className="apm-label">缺失模型({result.missing_models.length})</span>
                <ul className="apm-mono-list">
                  {result.missing_models.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.note && <p className="apm-hint">{result.note}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

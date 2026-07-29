"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { imageUrl } from "@/lib/api";
import type {
  DramaAsset,
  DramaAssetInput,
  DramaAssetKind,
  DramaAssetPatch,
} from "@/lib/api";
import {
  createDramaAsset,
  listDramaAssets,
  patchDramaAsset,
  deleteDramaAsset,
} from "@/lib/api";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface AssetLibraryProps {
  project: UseDramaProjectReturn;
}

const KINDS: { key: DramaAssetKind; label: string; icon: IconName }[] = [
  { key: "character", label: "角色", icon: "user" },
  { key: "scene", label: "场景", icon: "camera" },
  { key: "prop", label: "道具", icon: "package" },
  { key: "style", label: "风格", icon: "palette" },
];

const EMPTY_DRAFT: DramaAssetInput = {
  kind: "character",
  name: "",
  description: "",
  visual_prompt: "",
  ref_image: "",
  ref_audio: "",
  voice_name: "",
  tags: [],
};

function kindLabel(kind: string): string {
  return KINDS.find((k) => k.key === kind)?.label || kind;
}

function kindIcon(kind: string): IconName {
  return KINDS.find((k) => k.key === kind)?.icon || "box";
}

/**
 * M2:跨项目资产库面板。
 * - 按 kind 过滤 + 名称/标签搜索
 * - 新增/编辑/删除资产
 * - 将资产应用为当前项目的角色
 */
export function AssetLibrary({ project }: AssetLibraryProps) {
  const { current, applyAsset } = project;
  const { show: showToast } = useToast();

  const [assets, setAssets] = useState<DramaAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const [filterKind, setFilterKind] = useState<DramaAssetKind | "all">("all");
  const [query, setQuery] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DramaAssetInput>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>("");

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    const kind = filterKind === "all" ? undefined : filterKind;
    listDramaAssets(kind)
      .then((res) => setAssets(res.assets ?? []))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载资产库失败"),
      )
      .finally(() => setLoading(false));
  }, [filterKind]);

  useEffect(() => {
    load();
  }, [load]);

  const filteredAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description || "").toLowerCase().includes(q) ||
        (a.tags || []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [assets, query]);

  const resetDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
  }, []);

  const openCreate = useCallback(() => {
    setEditingId(null);
    resetDraft();
    setFormError("");
    setShowForm(true);
  }, [resetDraft]);

  const openEdit = useCallback((a: DramaAsset) => {
    setEditingId(a.id);
    setDraft({
      kind: a.kind,
      name: a.name,
      description: a.description,
      visual_prompt: a.visual_prompt,
      ref_image: a.ref_image,
      ref_audio: a.ref_audio,
      voice_name: a.voice_name,
      tags: a.tags ?? [],
    });
    setFormError("");
    setShowForm(true);
  }, []);

  const tagsString = useMemo(
    () => (draft.tags || []).join(", "),
    [draft.tags],
  );

  const setTagsString = useCallback((value: string) => {
    const tags = value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    setDraft((d) => ({ ...d, tags }));
  }, []);

  const handleSave = useCallback(() => {
    if (!draft.name?.trim()) {
      setFormError("请填写资产名称");
      return;
    }
    setSaving(true);
    setFormError("");

    const body: DramaAssetInput = {
      kind: draft.kind || "character",
      name: draft.name.trim(),
      description: draft.description?.trim() || "",
      visual_prompt: draft.visual_prompt?.trim() || "",
      ref_image: draft.ref_image?.trim() || "",
      ref_audio: draft.ref_audio?.trim() || "",
      voice_name: draft.voice_name?.trim() || "",
      tags: draft.tags || [],
    };

    const promise = editingId
      ? patchDramaAsset(editingId, body as DramaAssetPatch)
      : createDramaAsset(body);

    promise
      .then(() => {
        setShowForm(false);
        setEditingId(null);
        resetDraft();
        load();
        showToast("success", editingId ? "资产已更新" : "资产已创建");
      })
      .catch((err) =>
        setFormError(err instanceof Error ? err.message : "保存资产失败"),
      )
      .finally(() => setSaving(false));
  }, [draft, editingId, load, resetDraft, showToast]);

  const handleDelete = useCallback(
    (a: DramaAsset) => {
      if (deleteConfirmId !== a.id) {
        setDeleteConfirmId(a.id);
        window.setTimeout(() => {
          setDeleteConfirmId((cur) => (cur === a.id ? null : cur));
        }, 4000);
        return;
      }
      deleteDramaAsset(a.id)
        .then(() => {
          setAssets((prev) => prev.filter((x) => x.id !== a.id));
          setDeleteConfirmId(null);
          showToast("success", `资产「${a.name}」已删除`);
        })
        .catch((err) =>
          showToast(
            "error",
            err instanceof Error ? err.message : "删除资产失败",
          ),
        );
    },
    [deleteConfirmId, showToast],
  );

  const handleApply = useCallback(
    (a: DramaAsset) => {
      if (!current) {
        showToast("error", "请先打开一个项目");
        return;
      }
      if (a.kind !== "character") {
        showToast("info", "当前仅支持将角色资产应用到项目");
        return;
      }
      setApplyingId(a.id);
      applyAsset(a.id, a.name).finally(() => setApplyingId(null));
    },
    [current, applyAsset, showToast],
  );

  return (
    <section className="ds-section ds-asset-section card">
      <div className="ds-section-head">
        <Icon name="box" size={14} />
        <span className="ds-section-title">跨项目资产库</span>
        {assets.length > 0 && (
          <span className="ds-section-count">{assets.length}</span>
        )}
        <span className="ds-section-hint">跨剧本复用角色/场景/道具/风格</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm ds-asset-add"
          onClick={openCreate}
        >
          <Icon name="create" size={12} />
          新增资产
        </button>
      </div>

      <div className="ds-asset-toolbar">
        <div className="ds-asset-kind-filter">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              className={`ds-asset-kind-btn ${filterKind === k.key ? "active" : ""}`}
              onClick={() =>
                setFilterKind((prev) => (prev === k.key ? "all" : k.key))
              }
              title={k.label}
            >
              <Icon name={k.icon} size={12} />
              {k.label}
            </button>
          ))}
        </div>
        <div className="ds-asset-search">
          <Icon name="search" size={12} />
          <input
            type="text"
            className="ds-asset-search-input"
            placeholder="搜索资产名称、描述、标签…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="ds-asset-search-clear"
              onClick={() => setQuery("")}
            >
              <Icon name="close" size={10} />
            </button>
          )}
        </div>
      </div>

      {showForm && (
        <div className="ds-char-form">
          <div className="ds-char-form-title">
            <Icon name="box" size={13} />
            {editingId ? "编辑资产" : "新增资产"}
          </div>
          <div className="ds-field-row">
            <label className="ds-field">
              <span className="ds-field-label">类型</span>
              <select
                className="ds-input"
                value={draft.kind}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    kind: e.target.value as DramaAssetKind,
                  }))
                }
              >
                {KINDS.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ds-field">
              <span className="ds-field-label">名称 *</span>
              <input
                className="ds-input"
                value={draft.name ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
                maxLength={64}
              />
            </label>
          </div>
          <label className="ds-field">
            <span className="ds-field-label">描述</span>
            <input
              className="ds-input"
              value={draft.description ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
            />
          </label>
          <label className="ds-field">
            <span className="ds-field-label">
              视觉提示词(注入生成 prompt)
            </span>
            <textarea
              className="ds-textarea"
              value={draft.visual_prompt ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, visual_prompt: e.target.value }))
              }
              rows={2}
            />
          </label>
          <label className="ds-field">
            <span className="ds-field-label">参考图 URL</span>
            <input
              className="ds-input"
              value={draft.ref_image ?? ""}
              onChange={(e) =>
                setDraft((d) => ({ ...d, ref_image: e.target.value }))
              }
              placeholder="可选"
            />
          </label>
          {draft.kind === "character" && (
            <div className="ds-field-row">
              <label className="ds-field">
                <span className="ds-field-label">定妆音色 URL</span>
                <input
                  className="ds-input"
                  value={draft.ref_audio ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, ref_audio: e.target.value }))
                  }
                  placeholder="可选"
                />
              </label>
              <label className="ds-field">
                <span className="ds-field-label">音色名</span>
                <input
                  className="ds-input"
                  value={draft.voice_name ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, voice_name: e.target.value }))
                  }
                  placeholder="可选"
                />
              </label>
            </div>
          )}
          <label className="ds-field">
            <span className="ds-field-label">标签(逗号分隔)</span>
            <input
              className="ds-input"
              value={tagsString}
              onChange={(e) => setTagsString(e.target.value)}
              placeholder="古风, 女主, 反派"
            />
          </label>
          {formError && <div className="ds-error-inline">{formError}</div>}
          <div className="ds-form-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
                setFormError("");
              }}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? (
                <>
                  <Icon name="loading" size={13} className="ds-spin" />
                  保存中…
                </>
              ) : (
                <>
                  <Icon name="check" size={13} />
                  保存
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div className="ds-empty ds-empty-inline">
          <Icon name="loading" size={18} className="ds-spin" />
          <span>加载资产库…</span>
        </div>
      )}

      {error && !loading && (
        <div className="ds-error-inline">
          <Icon name="error" size={14} />
          {error}
          <button type="button" className="btn btn-sm" onClick={load}>
            <Icon name="refresh" size={11} />
            重试
          </button>
        </div>
      )}

      {!loading && !error && filteredAssets.length === 0 && (
        <div className="ds-empty ds-empty-inline">
          {query ? "没有匹配的资产" : "暂无资产 · 点击右上角新增"}
        </div>
      )}

      {!loading && !error && filteredAssets.length > 0 && (
        <ul className="ds-asset-list">
          {filteredAssets.map((a) => (
            <li key={a.id} className="ds-asset-item">
              <div className="ds-asset-thumb">
                {a.ref_image ? (
                  <img
                    src={imageUrl(a.ref_image)}
                    alt={a.name}
                    loading="lazy"
                  />
                ) : (
                  <Icon name={kindIcon(a.kind)} size={20} strokeWidth={1.4} />
                )}
              </div>
              <div className="ds-asset-body">
                <div className="ds-asset-head">
                  <span className="ds-asset-kind">
                    <Icon name={kindIcon(a.kind)} size={10} />
                    {kindLabel(a.kind)}
                  </span>
                  <span className="ds-asset-name" title={a.name}>
                    {a.name}
                  </span>
                </div>
                {a.description && (
                  <div className="ds-asset-desc">{a.description}</div>
                )}
                {a.visual_prompt && (
                  <div className="ds-asset-vp" title={a.visual_prompt}>
                    <Icon name="palette" size={10} />
                    {a.visual_prompt}
                  </div>
                )}
                {(a.tags || []).length > 0 && (
                  <div className="ds-asset-tags">
                    {a.tags.map((t) => (
                      <span key={t} className="ds-asset-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="ds-asset-actions">
                {a.kind === "character" && (
                  <button
                    type="button"
                    className="ds-mini-btn ds-mini-btn-primary"
                    onClick={() => handleApply(a)}
                    disabled={applyingId === a.id || !current}
                    title={current ? "应用为项目角色" : "请先打开项目"}
                  >
                    <Icon
                      name={applyingId === a.id ? "loading" : "plus"}
                      size={11}
                      className={applyingId === a.id ? "ds-spin" : undefined}
                    />
                    应用
                  </button>
                )}
                <button
                  type="button"
                  className="ds-mini-btn"
                  onClick={() => openEdit(a)}
                  title="编辑资产"
                >
                  <Icon name="create" size={11} />
                </button>
                <button
                  type="button"
                  className={`ds-mini-btn ds-mini-btn-danger ${deleteConfirmId === a.id ? "confirm" : ""}`}
                  onClick={() => handleDelete(a)}
                  title="删除资产"
                >
                  <Icon name="delete" size={11} />
                  {deleteConfirmId === a.id ? "确认?" : ""}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

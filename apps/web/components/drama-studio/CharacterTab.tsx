"use client";

import { useCallback, useState } from "react";

import { imageUrl } from "@/lib/api";
import type {
  DramaCharacterInput,
  DramaCharacterItem,
} from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import type { UseDramaProjectReturn } from "@/hooks/useDramaProject";

interface CharacterTabProps {
  project: UseDramaProjectReturn;
}

const EMPTY_DRAFT: DramaCharacterInput = {
  name: "",
  description: "",
  visual_prompt: "",
  ref_audio: "",
  voice_name: "",
};

/**
 * 角色库 + 三视图 Tab。
 * - 角色列表(名称/描述/视觉 token/音色/三视图缩略图)
 * - 新增/编辑/删除角色(本地表单状态)
 * - M1:生成正/侧/背三视图,点击放大预览
 */
export function CharacterTab({ project }: CharacterTabProps) {
  const {
    characters,
    createCharacter,
    patchCharacter,
    deleteCharacter,
    generateReference,
    busyRef,
    setRefPreview,
  } = project;

  // 角色表单本地状态
  const [showCharForm, setShowCharForm] = useState(false);
  const [editingCharId, setEditingCharId] = useState<string | null>(null);
  const [charDraft, setCharDraft] = useState<DramaCharacterInput>(EMPTY_DRAFT);
  const [charSaving, setCharSaving] = useState(false);
  const [charError, setCharError] = useState<string>("");

  const resetCharDraft = useCallback(() => {
    setCharDraft(EMPTY_DRAFT);
  }, []);

  const openCharForm = useCallback(
    (existing?: DramaCharacterItem) => {
      if (existing) {
        setEditingCharId(existing.id);
        setCharDraft({
          name: existing.name,
          description: existing.description ?? "",
          visual_prompt: existing.visual_prompt ?? "",
          ref_audio: existing.ref_audio ?? "",
          voice_name: existing.voice_name ?? "",
        });
      } else {
        setEditingCharId(null);
        resetCharDraft();
      }
      setCharError("");
      setShowCharForm(true);
    },
    [resetCharDraft],
  );

  const handleSaveCharacter = useCallback(() => {
    if (!charDraft.name?.trim()) {
      setCharError("请填写角色名");
      return;
    }
    setCharSaving(true);
    setCharError("");
    const body: DramaCharacterInput = {
      name: charDraft.name.trim(),
      ...(charDraft.description?.trim()
        ? { description: charDraft.description.trim() }
        : {}),
      ...(charDraft.visual_prompt?.trim()
        ? { visual_prompt: charDraft.visual_prompt.trim() }
        : {}),
      ...(charDraft.ref_audio?.trim()
        ? { ref_audio: charDraft.ref_audio.trim() }
        : {}),
      ...(charDraft.voice_name?.trim()
        ? { voice_name: charDraft.voice_name.trim() }
        : {}),
    };
    const promise = editingCharId
      ? patchCharacter(editingCharId, body)
      : createCharacter(body);
    promise
      .then(() => {
        setShowCharForm(false);
        setEditingCharId(null);
        resetCharDraft();
      })
      .catch((err) =>
        setCharError(err instanceof Error ? err.message : "保存角色失败"),
      )
      .finally(() => setCharSaving(false));
  }, [
    charDraft,
    editingCharId,
    createCharacter,
    patchCharacter,
    resetCharDraft,
  ]);

  return (
    <section className="ds-section ds-char-bar card">
      <div className="ds-section-head">
        <Icon name="mic" size={14} />
        <span className="ds-section-title">角色库</span>
        {characters.length > 0 && (
          <span className="ds-section-count">{characters.length}</span>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm ds-char-add"
          onClick={() => openCharForm()}
        >
          <Icon name="create" size={12} />
          新增角色
        </button>
      </div>

      {showCharForm && (
        <div className="ds-char-form">
          <div className="ds-char-form-title">
            <Icon name="mic" size={13} />
            {editingCharId ? "编辑角色" : "新增角色"}
          </div>
          <label className="ds-field">
            <span className="ds-field-label">角色名 *</span>
            <input
              className="ds-input"
              value={charDraft.name ?? ""}
              onChange={(e) =>
                setCharDraft((f) => ({ ...f, name: e.target.value }))
              }
              maxLength={40}
            />
          </label>
          <label className="ds-field">
            <span className="ds-field-label">描述</span>
            <input
              className="ds-input"
              value={charDraft.description ?? ""}
              onChange={(e) =>
                setCharDraft((f) => ({
                  ...f,
                  description: e.target.value,
                }))
              }
            />
          </label>
          <label className="ds-field">
            <span className="ds-field-label">
              视觉 token(注入视频 prompt 保一致性)
            </span>
            <textarea
              className="ds-textarea"
              value={charDraft.visual_prompt ?? ""}
              onChange={(e) =>
                setCharDraft((f) => ({
                  ...f,
                  visual_prompt: e.target.value,
                }))
              }
              rows={2}
            />
          </label>
          <div className="ds-field-row">
            <label className="ds-field">
              <span className="ds-field-label">定妆音色(ref_audio)</span>
              <input
                className="ds-input"
                value={charDraft.ref_audio ?? ""}
                onChange={(e) =>
                  setCharDraft((f) => ({
                    ...f,
                    ref_audio: e.target.value,
                  }))
                }
                placeholder="wav 路径或 URL"
              />
            </label>
            <label className="ds-field">
              <span className="ds-field-label">音色名(voice_name)</span>
              <input
                className="ds-input"
                value={charDraft.voice_name ?? ""}
                onChange={(e) =>
                  setCharDraft((f) => ({
                    ...f,
                    voice_name: e.target.value,
                  }))
                }
              />
            </label>
          </div>
          {charError && <div className="ds-error-inline">{charError}</div>}
          <div className="ds-form-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setShowCharForm(false);
                setEditingCharId(null);
                setCharError("");
              }}
              disabled={charSaving}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSaveCharacter}
              disabled={charSaving}
            >
              {charSaving ? (
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

      {characters.length === 0 && !showCharForm && (
        <div className="ds-empty ds-empty-inline">
          暂无角色 · 点上方&quot;新增角色&quot;添加
        </div>
      )}

      {characters.length > 0 && (
        <ul className="ds-char-ul">
          {characters.map((c) => (
            <li key={c.id} className="ds-char-item">
              <div className="ds-char-name">{c.name}</div>
              {c.description && (
                <div className="ds-char-desc">{c.description}</div>
              )}
              {c.visual_prompt && (
                <div className="ds-char-vp" title={c.visual_prompt}>
                  <Icon name="palette" size={10} />
                  {c.visual_prompt}
                </div>
              )}

              {/* M1:角色三视图(正/侧/背)*/}
              {(c.reference_front || c.reference_side || c.reference_back) && (
                <div className="ds-char-ref-grid">
                  {([
                    { key: "front", url: c.reference_front, label: "正面" },
                    { key: "side", url: c.reference_side, label: "侧面" },
                    { key: "back", url: c.reference_back, label: "背面" },
                  ] as const).map(
                    (v) =>
                      v.url && (
                        <button
                          key={v.key}
                          type="button"
                          className="ds-char-ref-thumb"
                          onClick={() =>
                            setRefPreview({
                              url: v.url,
                              label: `${c.name} · ${v.label}`,
                            })
                          }
                          title={`${v.label} · 点击放大`}
                        >
                          <img
                            src={imageUrl(v.url)}
                            alt={`${c.name}-${v.label}`}
                            loading="lazy"
                          />
                          <span className="ds-char-ref-label">
                            {v.label}
                          </span>
                        </button>
                      ),
                  )}
                </div>
              )}
              {busyRef === c.id && (
                <div className="ds-char-ref-loading">
                  <Icon name="loading" size={12} className="ds-spin" />
                  <span>三视图生成中…</span>
                </div>
              )}

              <div className="ds-char-foot">
                {c.voice_name && (
                  <span className="ds-char-voice">
                    <Icon name="mic" size={10} />
                    {c.voice_name}
                  </span>
                )}
                {c.ref_audio && (
                  <span className="ds-char-ref" title={c.ref_audio}>
                    ref
                  </span>
                )}
                <button
                  type="button"
                  className="ds-mini-btn ds-mini-btn-ref"
                  onClick={() => generateReference(c.id, c.name)}
                  disabled={busyRef === c.id}
                  title="生成正/侧/背三视图"
                >
                  <Icon
                    name={busyRef === c.id ? "loading" : "user"}
                    size={11}
                    className={busyRef === c.id ? "ds-spin" : undefined}
                  />
                  三视图
                </button>
                <button
                  type="button"
                  className="ds-mini-btn"
                  onClick={() => openCharForm(c)}
                  title="编辑角色"
                >
                  <Icon name="create" size={11} />
                </button>
                <button
                  type="button"
                  className="ds-mini-btn ds-mini-btn-danger"
                  onClick={() => deleteCharacter(c.id, c.name)}
                  title="删除角色"
                >
                  <Icon name="delete" size={11} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

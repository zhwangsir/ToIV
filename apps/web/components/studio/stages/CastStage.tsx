"use client";

import { useState } from "react";
import {
  addStudioCharacter,
  deleteStudioCharacter,
  patchStudioCharacter,
  type StudioCharacter,
} from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import type { useStudioProject } from "@/hooks/useStudioProject";

/**
 * ② 角色阶段:角色卡 CRUD(跨镜一致性锚点)。
 * 内联编辑失焦即存;voice_ref_url M4 只读展示,参考音上传后续扩展。
 */
export function CastStage({
  project,
  onDone,
}: {
  project: ReturnType<typeof useStudioProject>;
  onDone: () => void;
}) {
  const d = project.detail;
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!d) return null;

  const add = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await addStudioCharacter(d.id, { name: newName.trim() });
      setNewName("");
      await project.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "新建角色失败");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (c: StudioCharacter) => {
    if (!window.confirm(`删除角色「${c.name}」?引用该角色的分镜说话人将失效。`)) return;
    try {
      await deleteStudioCharacter(c.id);
      await project.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const patch = async (cid: string, fields: Parameters<typeof patchStudioCharacter>[1]) => {
    try {
      await patchStudioCharacter(cid, fields);
      await project.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  };

  return (
    <section className="studio-stage studio-stage-cast">
      <div className="studio-cast-grid">
        {d.characters.map((c) => (
          <article key={c.id} className="studio-char">
            <div className="studio-char-head">
              <Icon name="user" size={16} />
              <input
                className="input studio-char-name"
                defaultValue={c.name}
                key={`n-${c.id}-${c.name}`}
                onBlur={(e) =>
                  e.target.value.trim() && e.target.value !== c.name &&
                  void patch(c.id, { name: e.target.value.trim() })
                }
              />
              <button
                type="button"
                className="studio-shot-del"
                title="删除角色"
                onClick={() => void remove(c)}
              >
                <Icon name="delete" size={13} />
              </button>
            </div>
            <label className="studio-label">角色描述</label>
            <textarea
              className="input"
              rows={2}
              defaultValue={c.description}
              key={`d-${c.id}-${c.description}`}
              placeholder="中文角色描述(身份/性格/关系)"
              onBlur={(e) =>
                e.target.value !== c.description && void patch(c.id, { description: e.target.value })
              }
            />
            <label className="studio-label">视觉提示词(英文)</label>
            <textarea
              className="input"
              rows={2}
              defaultValue={c.visual_prompt}
              key={`v-${c.id}-${c.visual_prompt}`}
              placeholder="1boy, black hair, worn jacket…(注入分镜 prompt 保跨镜一致)"
              onBlur={(e) =>
                e.target.value !== c.visual_prompt &&
                void patch(c.id, { visual_prompt: e.target.value })
              }
            />
            {c.voice_ref_url && (
              <p className="studio-char-voice">
                <Icon name="mic" size={12} /> 参考音已配置(配音自动克隆音色)
              </p>
            )}
          </article>
        ))}

        {/* 新建角色卡 */}
        <article className="studio-char studio-char-new">
          <input
            className="input"
            value={newName}
            placeholder="新角色名…"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={adding || !newName.trim()}
            onClick={() => void add()}
          >
            <Icon name={adding ? "loading" : "plus"} size={13} /> 新建角色
          </button>
        </article>
      </div>

      {error && <p className="studio-error">{error}</p>}

      <div className="studio-stage-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={d.characters.length === 0}
          onClick={onDone}
        >
          下一步:分镜 <Icon name="chevron-right" size={14} />
        </button>
      </div>
    </section>
  );
}

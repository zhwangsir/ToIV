"use client";

import { useState } from "react";
import {
  addStudioCharacter,
  deleteStudioCharacter,
  parseStudioScript,
  patchStudioProject,
} from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import type { useStudioProject } from "@/hooks/useStudioProject";

/**
 * ① 剧本阶段:剧情概要 → LLM(L3)拆解为角色 + 分镜草稿。
 * 重新拆解为全量替换:先删旧角色,再建新角色,saveShots 全量替换分镜。
 */
export function ScriptStage({
  project,
  onDone,
}: {
  project: ReturnType<typeof useStudioProject>;
  onDone: () => void;
}) {
  const d = project.detail;
  const [premise, setPremise] = useState(d?.premise ?? "");
  const [style, setStyle] = useState(d?.style ?? "");
  const [numShots, setNumShots] = useState(8);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!d) return null;

  const hasExisting = d.characters.length > 0 || d.shots.length > 0;

  const parse = async () => {
    if (hasExisting && !window.confirm("重新拆解将替换现有角色与分镜,确认继续?")) return;
    setParsing(true);
    setError(null);
    try {
      await patchStudioProject(d.id, { premise, style });
      const r = await parseStudioScript(d.id, { premise, num_shots: numShots, style });
      // 全量替换角色:先删旧,再逐个建
      for (const c of d.characters) await deleteStudioCharacter(c.id);
      for (const c of r.characters) {
        await addStudioCharacter(d.id, {
          name: c.name,
          description: c.description,
          visual_prompt: c.visual_prompt,
        });
      }
      // 分镜全量替换(后端语义:未包含的旧镜删除)
      await project.saveShots(
        r.shots.map((s) => ({ ...s, render_mode: s.render_mode ?? d.render_mode_default })),
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "拆解失败,请重试");
    } finally {
      setParsing(false);
    }
  };

  return (
    <section className="studio-stage studio-stage-script">
      <div className="studio-field">
        <label className="studio-label" htmlFor="studio-premise">
          剧情概要 / 原文
        </label>
        <textarea
          id="studio-premise"
          className="input"
          value={premise}
          onChange={(e) => setPremise(e.target.value)}
          placeholder="输入剧情概要或原文,AI 将拆解为角色与分镜…"
          rows={10}
        />
      </div>
      <div className="studio-field">
        <label className="studio-label" htmlFor="studio-style">
          整体画风(可选)
        </label>
        <input
          id="studio-style"
          className="input"
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          placeholder="如:电影感、冷色调、浅景深…"
        />
      </div>
      <div className="studio-stage-actions">
        <label className="studio-inline-field">
          分镜数
          <input
            className="input"
            type="number"
            min={1}
            max={50}
            value={numShots}
            onChange={(e) => setNumShots(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={parsing || !premise.trim()}
          onClick={parse}
        >
          <Icon name={parsing ? "loading" : "sparkles"} size={14} />
          {parsing ? "AI 拆解中…" : hasExisting ? "重新拆解" : "AI 拆解"}
        </button>
      </div>
      {error && <p className="studio-error">{error}</p>}
    </section>
  );
}

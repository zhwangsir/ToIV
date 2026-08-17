"use client";

import { useRef, useState } from "react";
import {
  addStudioCharacter,
  deleteStudioCharacter,
  parseStudioScript,
  patchStudioProject,
} from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { useStudioProject } from "@/hooks/useStudioProject";

/**
 * ① 剧本阶段:剧情概要 → LLM(L3)拆解为角色 + 分镜草稿。
 * 重新拆解为全量替换:先删旧角色,再建新角色,saveShots 全量替换分镜。
 * 产出规格(分辨率/帧率)为项目级设置,改动即保存,两渲染链共用。
 */

/** 分辨率预设(全部 32 对齐,LTX 兼容;横屏 16:9 / 竖屏 9:16)。 */
const RES_PRESETS = [
  { w: 768, h: 384, label: "768×384 横屏·流畅" },
  { w: 1024, h: 576, label: "1024×576 横屏·标清" },
  { w: 1280, h: 720, label: "1280×720 横屏·高清" },
  { w: 576, h: 1024, label: "576×1024 竖屏·标清" },
  { w: 720, h: 1280, label: "720×1280 竖屏·高清" },
] as const;
const FPS_OPTIONS = [8, 12, 16, 24] as const;

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
  const [resIdx, setResIdx] = useState(() => {
    const i = RES_PRESETS.findIndex((p) => p.w === d?.width && p.h === d?.height);
    return i >= 0 ? i : 0;
  });
  const [fps, setFps] = useState(d?.fps ?? 16);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmParse, setConfirmParse] = useState(false);
  const toast = useToast();
  // 剧情概要自动增高(长原文不再 rows=10 截断出内滚条)
  const premiseRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(premiseRef, premise);

  if (!d) return null;

  const hasExisting = d.characters.length > 0 || d.shots.length > 0;

  /** 产出规格改动即落库(无需等拆解),失败回显错误。 */
  const saveSpec = (idx: number, f: number) => {
    const p = RES_PRESETS[idx];
    patchStudioProject(d.id, { width: p.w, height: p.h, fps: f })
      .then(() => {
        toast.success("产出规格已保存");
        return project.refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : "保存产出规格失败"));
  };

  const parse = () => {
    if (hasExisting) {
      setConfirmParse(true);
      return;
    }
    void runParse();
  };

  const runParse = async () => {
    setParsing(true);
    setError(null);
    try {
      const p = RES_PRESETS[resIdx];
      await patchStudioProject(d.id, {
        premise,
        style,
        width: p.w,
        height: p.h,
        fps,
      });
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
      setConfirmParse(false);
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
          ref={premiseRef}
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
          分辨率
          <select
            className="input"
            value={resIdx}
            onChange={(e) => {
              const i = Number(e.target.value);
              setResIdx(i);
              saveSpec(i, fps);
            }}
          >
            {RES_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="studio-inline-field">
          帧率
          <select
            className="input"
            value={fps}
            onChange={(e) => {
              const f = Number(e.target.value);
              setFps(f);
              saveSpec(resIdx, f);
            }}
          >
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
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

      {/* 重新拆解确认(替代原生 window.confirm) */}
      <Modal
        open={confirmParse}
        onClose={() => setConfirmParse(false)}
        title="重新拆解"
        danger
        preventClose={parsing}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={parsing}
              onClick={() => setConfirmParse(false)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={parsing}
              onClick={() => void runParse()}
            >
              {parsing ? "拆解中…" : "确认拆解"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          重新拆解将替换现有角色与分镜,确认继续?
        </p>
      </Modal>
    </section>
  );
}

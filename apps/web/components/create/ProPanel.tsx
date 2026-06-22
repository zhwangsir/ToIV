"use client";

import { useCallback, useState } from "react";

import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { Slider } from "@/components/ui/Slider";
import type { ModelsResponse } from "@/lib/types";

import type { Dispatch } from "./useGenerationFeed";
import {
  type Mode,
  type RefImage,
  DEFAULT_NEGATIVE,
  IMG_ASPECTS,
  SAMPLERS,
  SCHEDULERS,
  VID_ASPECTS,
  WORKFLOW_PRESETS,
} from "./types";

interface ProPanelProps {
  mode: Mode;
  setMode: (m: Mode) => void;
  prompt: string;
  setPrompt: (p: string) => void;
  ref: RefImage | null;
  setRef: (r: RefImage | null) => void;
  ensureUploaded: (r: RefImage, kind: string) => Promise<{ filename: string; worker: string }>;
  models: ModelsResponse | null;
  ckpt: string;
  setCkpt: (c: string) => void;
  busy: boolean;
  run: (dispatches: Dispatch[], stage: string) => Promise<void>;
}

interface ImgParams {
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: string;
  batch: number;
  denoise: number;
}

/** 专业版:全控制面板,可折叠高级分区 + 工作流预设 + 占位槽位。 */
export function ProPanel(props: ProPanelProps) {
  const { mode, setMode, prompt, setPrompt, ref, setRef, ensureUploaded, models, ckpt, setCkpt, busy, run } = props;

  const [img, setImg] = useState<ImgParams>({
    negative: DEFAULT_NEGATIVE,
    width: 768,
    height: 768,
    steps: 20,
    cfg: 7,
    sampler: "euler",
    scheduler: "normal",
    seed: "",
    batch: 1,
    denoise: 0.6,
  });
  const [vidLength, setVidLength] = useState(81);
  const [vidFps, setVidFps] = useState(16);
  const [vidAspect, setVidAspect] = useState(VID_ASPECTS[1]);
  const [octree, setOctree] = useState(256);
  const [steps3d, setSteps3d] = useState(30);
  const [cfg3d, setCfg3d] = useState(5);
  const [audioLyrics, setAudioLyrics] = useState("");
  const [audioSeconds, setAudioSeconds] = useState(30);
  const [advanced, setAdvanced] = useState(false);

  const set = <K extends keyof ImgParams>(k: K, v: ImgParams[K]) => setImg((p) => ({ ...p, [k]: v }));
  const seedNum = img.seed.trim() ? Number(img.seed) : null;

  const pickFile = useCallback(
    (file: File | null) => {
      if (!file) return;
      setRef({ previewUrl: URL.createObjectURL(file), file });
    },
    [setRef],
  );

  const applyWorkflow = (key: string) => {
    const w = WORKFLOW_PRESETS.find((p) => p.key === key);
    if (!w) return;
    setImg((p) => ({ ...p, steps: w.steps, cfg: w.cfg, sampler: w.sampler, scheduler: w.scheduler }));
  };

  const submit = useCallback(async () => {
    if (busy) return;
    const positive = prompt.trim();

    if (mode === "image") {
      if (ref) {
        const up = await ensureUploaded(ref, "img2img");
        await run(
          [{
            type: "img2img",
            prompt,
            meta: { ckpt, beforeUrl: ref.previewUrl },
            params: {
              positive: positive || "enhance, high quality, detailed",
              negative: img.negative,
              ckpt_name: ckpt,
              image: up.filename,
              worker: up.worker,
              denoise: img.denoise,
              steps: img.steps,
              cfg: img.cfg,
              sampler: img.sampler,
              scheduler: img.scheduler,
              seed: seedNum,
            },
          }],
          "重绘中…",
        );
      } else {
        await run(
          [{
            type: "txt2img",
            prompt,
            meta: { ckpt, width: img.width, height: img.height },
            params: {
              positive,
              negative: img.negative,
              ckpt_name: ckpt,
              width: img.width,
              height: img.height,
              steps: img.steps,
              cfg: img.cfg,
              sampler: img.sampler,
              scheduler: img.scheduler,
              seed: seedNum,
              batch_size: img.batch,
            },
          }],
          img.batch > 1 ? `生成 ${img.batch} 张…` : "生成中…",
        );
      }
      return;
    }

    if (mode === "video") {
      if (ref) {
        const up = await ensureUploaded(ref, "video");
        await run(
          [{
            type: "video",
            prompt,
            params: {
              positive: positive || "subtle natural motion",
              image: up.filename,
              worker: up.worker,
              width: vidAspect.w,
              height: vidAspect.h,
              length: vidLength,
              fps: vidFps,
              seed: seedNum,
            },
          }],
          "图生视频…",
        );
      } else {
        await run(
          [{
            type: "txt2video",
            prompt,
            params: {
              positive: positive || "cinematic motion",
              negative: img.negative,
              width: vidAspect.w,
              height: vidAspect.h,
              length: vidLength,
              fps: vidFps,
              seed: seedNum,
            },
          }],
          "文生视频…",
        );
      }
      return;
    }

    if (mode === "model3d" && ref) {
      const up = await ensureUploaded(ref, "threed");
      await run(
        [{
          type: "model3d",
          prompt,
          params: { image: up.filename, worker: up.worker, steps: steps3d, cfg: cfg3d, octree_resolution: octree, seed: seedNum },
        }],
        "生成 3D…",
      );
      return;
    }

    if (mode === "audio") {
      await run(
        [{ type: "audio", prompt, params: { tags: positive, lyrics: audioLyrics, seconds: audioSeconds, seed: seedNum } }],
        "创作音乐…",
      );
    }
  }, [busy, prompt, mode, ref, ensureUploaded, ckpt, img, seedNum, vidAspect, vidLength, vidFps, steps3d, cfg3d, octree, audioLyrics, audioSeconds, run]);

  const canRun = mode === "audio" ? !!prompt.trim() : mode === "model3d" ? !!ref : !!(prompt.trim() || ref);
  const optimizeKind = mode === "audio" ? "audio" : mode === "video" ? "video" : ref ? "image_edit" : "image";

  return (
    <div className="pro-panel">
      {/* 模式 */}
      <div className="field">
        <label>创作类型</label>
        <div className="seg" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          {(["image", "video", "model3d", "audio"] as Mode[]).map((m) => (
            <button key={m} type="button" className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {m === "image" ? "图像" : m === "video" ? "视频" : m === "model3d" ? "3D" : "音频"}
            </button>
          ))}
        </div>
      </div>

      {/* 模型选择器(图像/视频) */}
      {(mode === "image" || mode === "video") && models && models.checkpoints.length > 0 && (
        <div className="field">
          <label>模型 · checkpoint</label>
          <select value={ckpt} onChange={(e) => setCkpt(e.target.value)}>
            {models.checkpoints.map((c) => (
              <option key={c} value={c}>{c.replace(/\.safetensors$/, "")}</option>
            ))}
          </select>
        </div>
      )}

      {/* 工作流预设 */}
      {(mode === "image" || mode === "video") && (
        <div className="field">
          <label>工作流预设</label>
          <select defaultValue="balanced" onChange={(e) => applyWorkflow(e.target.value)}>
            {WORKFLOW_PRESETS.map((w) => (
              <option key={w.key} value={w.key}>{w.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* 参考图 */}
      {mode !== "audio" && (
        <div className="field">
          <label>
            参考图{mode === "model3d" ? "(必需)" : ref ? "(图生)" : "(可选)"}
            {ref && <button type="button" className="link-clear" onClick={() => setRef(null)}>移除</button>}
          </label>
          {ref ? (
            <div className="ref-preview"><img src={ref.previewUrl} alt="参考图" /></div>
          ) : (
            <label className="dropzone">
              <input type="file" accept="image/*" hidden onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
              {mode === "model3d" ? "上传物体图(干净背景最佳)" : "拖入或点击上传"}
            </label>
          )}
        </div>
      )}

      {/* 提示词 */}
      <div className="field">
        <label htmlFor="pro-prompt">
          {mode === "audio" ? "风格 / 标签" : "提示词"}
          <OptimizeButton value={prompt} kind={optimizeKind} onResult={setPrompt} disabled={busy} />
        </label>
        <textarea
          id="pro-prompt"
          rows={3}
          placeholder={mode === "audio" ? "lofi hip hop, chill, piano, 90 bpm" : "描述你想要的内容"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      {/* 负面(图像/视频) */}
      {mode !== "model3d" && mode !== "audio" && (
        <div className="field">
          <label htmlFor="pro-neg">负面提示词</label>
          <textarea id="pro-neg" rows={2} value={img.negative} onChange={(e) => set("negative", e.target.value)} />
        </div>
      )}

      {/* === 图像参数 === */}
      {mode === "image" && (
        <>
          {!ref && (
            <>
              <div className="field">
                <label>画幅预设<span className="hint">{img.width}×{img.height}</span></label>
                <div className="seg">
                  {IMG_ASPECTS.map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      className={img.width === a.w && img.height === a.h ? "active" : ""}
                      onClick={() => setImg((p) => ({ ...p, width: a.w, height: a.h }))}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              <Slider label="宽度 width" value={img.width} min={384} max={1536} step={64} suffix="px" onChange={(v) => set("width", v)} disabled={busy} />
              <Slider label="高度 height" value={img.height} min={384} max={1536} step={64} suffix="px" onChange={(v) => set("height", v)} disabled={busy} />
              <Slider label="批量 batch" value={img.batch} min={1} max={8} step={1} suffix="张" onChange={(v) => set("batch", v)} disabled={busy} />
            </>
          )}
          {ref && (
            <Slider label="重绘强度 denoise" value={img.denoise} min={0.2} max={0.95} step={0.05} onChange={(v) => set("denoise", v)} disabled={busy} />
          )}
        </>
      )}

      {/* === 视频参数 === */}
      {mode === "video" && (
        <>
          <div className="field">
            <label>画幅</label>
            <div className="seg" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {VID_ASPECTS.map((a) => (
                <button key={a.key} type="button" className={vidAspect.key === a.key ? "active" : ""} onClick={() => setVidAspect(a)}>{a.label}</button>
              ))}
            </div>
          </div>
          <Slider
            label="时长 length"
            value={vidLength}
            min={25}
            max={121}
            step={4}
            suffix="帧"
            format={(v) => `${v} · ~${(v / vidFps).toFixed(1)}s`}
            onChange={setVidLength}
            disabled={busy}
          />
          <Slider label="帧率 fps" value={vidFps} min={8} max={30} step={1} onChange={setVidFps} disabled={busy} />
        </>
      )}

      {/* === 3D 参数 === */}
      {mode === "model3d" && (
        <>
          <Slider label="octree 分辨率" value={octree} min={128} max={512} step={64} onChange={setOctree} disabled={busy} />
          <Slider label="steps" value={steps3d} min={10} max={50} step={1} onChange={setSteps3d} disabled={busy} />
          <Slider label="cfg" value={cfg3d} min={1} max={10} step={0.5} onChange={setCfg3d} disabled={busy} />
        </>
      )}

      {/* === 音频参数 === */}
      {mode === "audio" && (
        <>
          <div className="field">
            <label htmlFor="pro-lyrics">歌词<span className="hint">留空 = 纯音乐</span></label>
            <textarea id="pro-lyrics" rows={3} placeholder="支持 [verse] [chorus] 标记" value={audioLyrics} onChange={(e) => setAudioLyrics(e.target.value)} />
          </div>
          <Slider label="时长" value={audioSeconds} min={10} max={120} step={5} suffix="s" onChange={setAudioSeconds} disabled={busy} />
        </>
      )}

      {/* === 可折叠高级分区(采样器/调度器/seed + 占位槽位) === */}
      {mode !== "audio" && (
        <div className="advanced">
          <button type="button" className="advanced-toggle" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
            <span className={`adv-caret ${advanced ? "open" : ""}`} aria-hidden="true">▸</span>
            高级
          </button>
          {advanced && (
            <div className="advanced-body">
              {(mode === "image") && (
                <>
                  <Slider label="steps" value={img.steps} min={1} max={60} step={1} onChange={(v) => set("steps", v)} disabled={busy} />
                  <Slider label="cfg" value={img.cfg} min={1} max={15} step={0.5} onChange={(v) => set("cfg", v)} disabled={busy} />
                  <div className="row-2">
                    <div className="field">
                      <label>采样器</label>
                      <select value={img.sampler} onChange={(e) => set("sampler", e.target.value)}>
                        {(models?.samplers?.length ? models.samplers : SAMPLERS).map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label>调度器</label>
                      <select value={img.scheduler} onChange={(e) => set("scheduler", e.target.value)}>
                        {(models?.schedulers?.length ? models.schedulers : SCHEDULERS).map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="pro-seed">seed<span className="hint">留空 = 随机</span></label>
                <input id="pro-seed" type="number" placeholder="随机" value={img.seed} onChange={(e) => set("seed", e.target.value)} />
              </div>

              {/* LoRA / ControlNet 槽位:UI 占位,后端未接 */}
              {(mode === "image") && (
                <div className="slot-group">
                  <div className="slot-placeholder">
                    <span>LoRA 槽位</span>
                    <span className="soon">即将开放</span>
                  </div>
                  <div className="slot-placeholder">
                    <span>ControlNet 槽位</span>
                    <span className="soon">即将开放</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <button type="button" className="generate-btn" disabled={busy || !canRun} onClick={submit}>
        {busy ? "生成中…" : mode === "video" ? (ref ? "图生视频" : "文生视频") : mode === "model3d" ? "生成 3D" : mode === "audio" ? "生成音乐" : ref ? "重绘" : "生成"}
      </button>
    </div>
  );
}

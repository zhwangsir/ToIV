"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ModelViewer } from "@/components/ui/ModelViewer";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import {
  generate3D,
  generateImg2img,
  generateTxt2img,
  generateVideo,
  imageUrl,
  jobEventsUrl,
  listModels,
  uploadImage,
} from "@/lib/api";
import type { GenerateResponse, ModelsResponse } from "@/lib/types";

type Mode = "image" | "video";
type ResultKind = "image" | "video" | "model3d";

interface ResultItem {
  id: string;
  kind: ResultKind;
  url: string;
  prompt: string;
}

interface RefImage {
  previewUrl: string;
  file: File;
  uploaded?: { filename: string; worker: string };
}

const IMG_ASPECTS = [
  { key: "1:1", w: 512, h: 512, label: "1:1" },
  { key: "2:3", w: 512, h: 768, label: "竖" },
  { key: "3:2", w: 768, h: 512, label: "横" },
  { key: "hd", w: 768, h: 768, label: "大图" },
];
const VID_ASPECTS = [
  { key: "1:1", w: 480, h: 480, label: "1:1" },
  { key: "16:9", w: 832, h: 480, label: "横屏" },
  { key: "9:16", w: 480, h: 832, label: "竖屏" },
];
const VID_LENGTHS = [
  { v: 25, label: "~1.5s" },
  { v: 49, label: "~3s" },
  { v: 81, label: "~5s" },
  { v: 121, label: "~7.5s" },
];

let _seq = 0;
const nextId = () => `r-${_seq++}`;

export function CreateStudio() {
  const [mode, setMode] = useState<Mode>("image");
  const [prompt, setPrompt] = useState("");
  const [ref, setRef] = useState<RefImage | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [ckpt, setCkpt] = useState("");
  // 图像参数
  const [batch, setBatch] = useState(1);
  const [imgAspect, setImgAspect] = useState(IMG_ASPECTS[0]);
  const [denoise, setDenoise] = useState(0.6);
  // 视频参数
  const [vidAspect, setVidAspect] = useState(VID_ASPECTS[1]);
  const [length, setLength] = useState(81);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultItem[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    listModels()
      .then((m) => {
        setModels(m);
        setCkpt(m.checkpoints[0] ?? "");
      })
      .catch(() => {});
    return () => esRef.current?.close();
  }, []);

  useEffect(() => () => { if (ref) URL.revokeObjectURL(ref.previewUrl); }, [ref]);

  const addResults = (items: ResultItem[]) => setResults((prev) => [...items, ...prev]);

  const pickFile = useCallback((file: File | null) => {
    if (!file) return;
    setRef({ previewUrl: URL.createObjectURL(file), file });
  }, []);

  // 确保参考图已上传到某 worker(图生图/图生视频/图生3D 需要)
  const ensureUploaded = async (r: RefImage, kind: string) => {
    if (r.uploaded) return r.uploaded;
    const up = await uploadImage(r.file, kind);
    setRef((cur) => (cur ? { ...cur, uploaded: up } : cur));
    return up;
  };

  // 用 EventSource 跟踪一个作业,完成后把产物加入结果流
  const track = (res: GenerateResponse, kind: ResultKind, promptText: string) =>
    new Promise<void>((resolve) => {
      const es = new EventSource(jobEventsUrl(res.prompt_id, res.client_id, res.worker));
      esRef.current = es;
      let done = false;
      es.addEventListener("done", (e) => {
        done = true;
        const d = JSON.parse((e as MessageEvent).data);
        const paths: string[] = d.images ?? [];
        const items: ResultItem[] = paths.map((p) => {
          const isGlb = p.toLowerCase().includes(".glb");
          return {
            id: nextId(),
            kind: isGlb ? "model3d" : kind === "video" ? "video" : "image",
            url: imageUrl(p),
            prompt: promptText,
          };
        });
        addResults(items);
        es.close();
        resolve();
      });
      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        if (data) {
          try { setError(JSON.parse(data).message); } catch { setError("生成出错"); }
          es.close();
          resolve();
        } else if (!done) {
          setError("与服务器连接中断");
          es.close();
          resolve();
        }
      });
    });

  const run = useCallback(async () => {
    if (busy) return;
    const p = prompt.trim();
    if (mode === "image" && !p && !ref) return;
    if (mode === "video" && !ref) {
      setError("视频需要一张参考图(上传,或在某张图片结果上点「转视频」)");
      return;
    }
    esRef.current?.close();
    setError(null);
    setBusy(true);
    try {
      if (mode === "image") {
        if (ref) {
          setStage("重绘中…");
          const up = await ensureUploaded(ref, "img2img");
          const res = await generateImg2img({
            positive: p || "enhance, high quality, detailed",
            negative: "blurry, lowres, deformed, watermark",
            ckpt_name: ckpt,
            image: up.filename,
            worker: up.worker,
            denoise,
            steps: 20,
            cfg: 7,
            sampler: "euler",
            scheduler: "normal",
          });
          await track(res, "image", p);
        } else {
          setStage(batch > 1 ? `生成 ${batch} 张…` : "生成中…");
          const res = await generateTxt2img({
            positive: p,
            negative: "blurry, lowres, deformed, watermark",
            ckpt_name: ckpt,
            width: imgAspect.w,
            height: imgAspect.h,
            steps: 20,
            cfg: 7,
            sampler: "euler",
            scheduler: "normal",
            batch_size: batch,
          });
          await track(res, "image", p);
        }
      } else {
        setStage("生成视频…(约 1-2 分钟)");
        const up = await ensureUploaded(ref!, "video");
        const res = await generateVideo({
          positive: p || "subtle natural motion, cinematic",
          image: up.filename,
          worker: up.worker,
          width: vidAspect.w,
          height: vidAspect.h,
          length,
          fps: 16,
        });
        await track(res, "video", p);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStage("");
    }
  }, [busy, prompt, mode, ref, ckpt, denoise, batch, imgAspect, vidAspect, length]);

  // 续创作:把某张图片结果当参考图,切到目标流程
  const useAsRef = async (item: ResultItem): Promise<File> => {
    const blob = await (await fetch(item.url)).blob();
    return new File([blob], "ref.png", { type: blob.type || "image/png" });
  };

  const toVideo = async (item: ResultItem) => {
    const file = await useAsRef(item);
    setRef({ previewUrl: item.url, file });
    setMode("video");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const toRedraw = async (item: ResultItem) => {
    const file = await useAsRef(item);
    setRef({ previewUrl: item.url, file });
    setMode("image");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const to3D = async (item: ResultItem) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStage("生成 3D…(约 1-3 分钟)");
    try {
      const file = await useAsRef(item);
      const up = await uploadImage(file, "threed");
      const res = await generate3D({
        image: up.filename, worker: up.worker, steps: 30, cfg: 5, octree_resolution: 256,
      });
      await track(res, "model3d", item.prompt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStage("");
    }
  };

  const optimizeKind = mode === "video" ? "video" : ref ? "image_edit" : "image";
  const canRun = mode === "image" ? !!(prompt.trim() || ref) : !!ref;

  return (
    <div className="studio create-studio">
      <div className="panel">
        {/* 模式 */}
        <div className="field">
          <label>创作模式</label>
          <div className="seg" role="group" aria-label="创作模式">
            <button type="button" className={mode === "image" ? "active" : ""} onClick={() => setMode("image")}>图像</button>
            <button type="button" className={mode === "video" ? "active" : ""} onClick={() => setMode("video")}>视频</button>
          </div>
        </div>

        {/* 参考图 */}
        <div className="field">
          <label>
            参考图{mode === "video" ? "(必需)" : "(可选 → 图生图)"}
            {ref && <button type="button" className="link-clear" onClick={() => setRef(null)}>移除</button>}
          </label>
          {ref ? (
            <div className="ref-preview"><img src={ref.previewUrl} alt="参考图" /></div>
          ) : (
            <label className="dropzone">
              <input type="file" accept="image/*" hidden onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
              拖入或点击上传图片
            </label>
          )}
        </div>

        {/* 提示词 */}
        <div className="field">
          <label htmlFor="cprompt">
            提示词
            <OptimizeButton value={prompt} kind={optimizeKind} onResult={setPrompt} disabled={busy} />
          </label>
          <textarea
            id="cprompt"
            rows={3}
            placeholder={mode === "video" ? "描述运动,如:镜头缓慢推进,花瓣飘落" : ref ? "描述想把图片改成什么样" : "描述你想要的画面"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        {/* 图像参数 */}
        {mode === "image" && !ref && (
          <>
            <div className="field">
              <label>数量<span className="hint">{batch} 张</span></label>
              <div className="seg" role="group" aria-label="数量">
                {[1, 2, 4, 6, 8].map((n) => (
                  <button key={n} type="button" className={batch === n ? "active" : ""} onClick={() => setBatch(n)}>{n}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>画幅<span className="hint">{imgAspect.w}×{imgAspect.h}</span></label>
              <div className="seg" role="group" aria-label="画幅">
                {IMG_ASPECTS.map((a) => (
                  <button key={a.key} type="button" className={imgAspect.key === a.key ? "active" : ""} onClick={() => setImgAspect(a)}>{a.label}</button>
                ))}
              </div>
            </div>
          </>
        )}
        {mode === "image" && ref && (
          <div className="field">
            <label>重绘强度<span className="hint">{denoise.toFixed(2)}</span></label>
            <input type="range" min={0.2} max={0.95} step={0.05} value={denoise} onChange={(e) => setDenoise(Number(e.target.value))} />
          </div>
        )}

        {/* 视频参数 */}
        {mode === "video" && (
          <>
            <div className="field">
              <label>时长</label>
              <div className="seg" role="group" aria-label="时长">
                {VID_LENGTHS.map((l) => (
                  <button key={l.v} type="button" className={length === l.v ? "active" : ""} onClick={() => setLength(l.v)}>{l.label}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>画幅</label>
              <div className="seg" role="group" aria-label="视频画幅">
                {VID_ASPECTS.map((a) => (
                  <button key={a.key} type="button" className={vidAspect.key === a.key ? "active" : ""} onClick={() => setVidAspect(a)}>{a.label}</button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* 模型 */}
        {mode === "image" && models && models.checkpoints.length > 0 && (
          <div className="field">
            <label>模型</label>
            <select value={ckpt} onChange={(e) => setCkpt(e.target.value)}>
              {models.checkpoints.map((c) => <option key={c} value={c}>{c.replace(/\.safetensors$/, "")}</option>)}
            </select>
          </div>
        )}

        <button type="button" className="generate-btn" disabled={busy || !canRun} onClick={run}>
          {busy ? stage || "处理中…" : mode === "video" ? "生成视频" : ref ? "重绘" : batch > 1 ? `生成 ${batch} 张` : "生成"}
        </button>
        {error && <div className="alert">⚠ {error}</div>}
      </div>

      <main className="stage">
        <div className="stage-head">
          <h1>创作 <span className="grad">{mode === "video" ? "视频" : "图像"}</span></h1>
          <span className="count">{results.length} 件</span>
        </div>
        {busy && <div className="chat-typing">{stage}</div>}
        {results.length === 0 && !busy ? (
          <div className="hero-canvas"><div className="hero-orb" aria-hidden="true" /><h2>开始创作</h2><p>文字生成,或上传参考图做图生图/图生视频;生成后可一键转视频 / 转 3D / 重绘。</p></div>
        ) : (
          <div className="create-feed">
            {results.map((r) => (
              <figure className="create-card" key={r.id}>
                {r.kind === "model3d" ? (
                  <div className="chat-model3d"><ModelViewer src={r.url} /></div>
                ) : (
                  <img src={r.url} alt={r.prompt || "结果"} loading="lazy" />
                )}
                {r.kind === "image" && (
                  <div className="card-actions">
                    <button type="button" onClick={() => toVideo(r)} disabled={busy}>转视频</button>
                    <button type="button" onClick={() => to3D(r)} disabled={busy}>转 3D</button>
                    <button type="button" onClick={() => toRedraw(r)} disabled={busy}>重绘</button>
                    <a href={r.url} download>下载</a>
                  </div>
                )}
                {r.kind === "video" && <span className="media-tag">▶ 视频</span>}
                {r.kind === "model3d" && <span className="media-tag">⬢ 3D · 可旋转</span>}
              </figure>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

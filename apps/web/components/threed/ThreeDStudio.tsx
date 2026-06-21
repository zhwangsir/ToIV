"use client";

import { createElement, useCallback, useEffect, useRef, useState } from "react";

import { ProgressBar } from "@/components/generate/ProgressBar";
import { generate3D, imageUrl, jobEventsUrl, uploadImage } from "@/lib/api";
import type { GenStatus, Progress } from "@/lib/types";

interface Model3D {
  id: string;
  url: string;
}

function ModelViewer({ src }: { src: string }) {
  // model-viewer 是 Web Component，用 createElement 规避 JSX 类型
  return createElement("model-viewer", {
    src,
    "camera-controls": true,
    "auto-rotate": true,
    "shadow-intensity": "1",
    exposure: "1.1",
    style: {
      width: "100%",
      height: "100%",
      background: "transparent",
      "--poster-color": "transparent",
    },
  });
}

export function ThreeDStudio() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [status, setStatus] = useState<GenStatus>("idle");
  const [progress, setProgress] = useState<Progress>({ value: 0, max: 0 });
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Model3D[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const doneRef = useRef(false);

  // 注入 model-viewer 脚本
  useEffect(() => {
    if (document.querySelector("script[data-model-viewer]")) return;
    const s = document.createElement("script");
    s.type = "module";
    s.src = "https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js";
    s.setAttribute("data-model-viewer", "");
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    if (!imageFile) {
      setImagePreview(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  useEffect(() => () => esRef.current?.close(), []);

  const busy = status === "queued" || status === "running";

  const onSubmit = useCallback(async () => {
    if (!imageFile) return;
    esRef.current?.close();
    doneRef.current = false;
    setError(null);
    setStatus("queued");
    setProgress({ value: 0, max: 0 });
    try {
      const up = await uploadImage(imageFile, "threed");
      const res = await generate3D({
        image: up.filename,
        worker: up.worker,
        steps: 30,
        cfg: 5,
        octree_resolution: 256,
      });
      setStatus("running");
      const es = new EventSource(jobEventsUrl(res.prompt_id, res.client_id, res.worker));
      esRef.current = es;
      es.addEventListener("progress", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setProgress({ value: d.value ?? 0, max: d.max ?? 0 });
      });
      es.addEventListener("done", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        const glb = (d.images as string[]).find((p) => p.includes(".glb")) ?? d.images[0];
        if (glb) setModels((prev) => [{ id: res.prompt_id, url: imageUrl(glb) }, ...prev]);
        doneRef.current = true;
        setStatus("idle");
        es.close();
      });
      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        if (data) {
          try {
            setError(JSON.parse(data).message);
          } catch {
            setError("3D 生成出错");
          }
          setStatus("error");
          es.close();
        } else if (!doneRef.current) {
          setError("与服务器的连接中断");
          setStatus("error");
          es.close();
        }
      });
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }, [imageFile]);

  const latest = models[0];

  return (
    <div className="studio">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (imageFile && !busy) onSubmit();
        }}
      >
        <div className="panel-head">
          <span className="accent" aria-hidden="true" />
          图生 3D · Hunyuan3D
        </div>
        <div className="field">
          <label>物体图片</label>
          <label className="dropzone">
            {imagePreview ? (
              <img src={imagePreview} alt="源图预览" />
            ) : (
              <span>上传单个物体图片(干净背景最佳)</span>
            )}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
        <button type="submit" className="generate-btn" disabled={!imageFile || busy}>
          {busy ? "生成中…" : !imageFile ? "请先上传图片" : "生成 3D 模型"}
        </button>
        <p className="muted" style={{ fontSize: "0.74rem" }}>
          Hunyuan3D 2.0 生成带网格的 GLB;体素解码较慢,请耐心等待。
        </p>
      </form>

      <main className="stage">
        <div className="stage-head">
          <h1>
            图生 <span className="grad">3D</span>
          </h1>
          <span className="count">{models.length} 个模型</span>
        </div>
        <ProgressBar status={status} progress={progress} />
        {error && <div className="alert">⚠ {error}</div>}
        {!latest ? (
          <div className="hero-canvas">
            <div className="hero-orb" aria-hidden="true" />
            <h2>把图片变成 3D</h2>
            <p>上传一张物体图片,由 Hunyuan3D 生成可旋转的 3D 模型,支持导出 GLB。</p>
          </div>
        ) : (
          <>
            <div className="viewer-3d">
              <ModelViewer src={latest.url} />
              <a className="btn-ghost viewer-dl" href={latest.url} download>
                下载 GLB
              </a>
            </div>
            {models.length > 1 && (
              <div className="model3d-list">
                {models.slice(1).map((m) => (
                  <a key={m.id} className="btn-ghost sm" href={m.url} download>
                    模型 {m.id.slice(0, 6)}.glb
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

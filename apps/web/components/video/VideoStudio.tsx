"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ProgressBar } from "@/components/generate/ProgressBar";
import { generateVideo, imageUrl, jobEventsUrl, uploadImage } from "@/lib/api";
import type { GenStatus, Progress } from "@/lib/types";

const ASPECTS = [
  { key: "1:1", w: 480, h: 480, label: "1:1" },
  { key: "16:9", w: 832, h: 480, label: "横屏" },
  { key: "9:16", w: 480, h: 832, label: "竖屏" },
];
const LENGTHS = [
  { v: 25, label: "短 ~1.5s" },
  { v: 49, label: "中 ~3s" },
  { v: 81, label: "长 ~5s" },
];

interface Clip {
  id: string;
  url: string;
  prompt: string;
}

export function VideoStudio() {
  const [positive, setPositive] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [aspect, setAspect] = useState(ASPECTS[0]);
  const [length, setLength] = useState(25);
  const [status, setStatus] = useState<GenStatus>("idle");
  const [progress, setProgress] = useState<Progress>({ value: 0, max: 0 });
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const doneRef = useRef(false);

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
  const canSubmit = positive.trim().length > 0 && !!imageFile && !busy;

  const onSubmit = useCallback(async () => {
    if (!imageFile || !positive.trim()) return;
    esRef.current?.close();
    doneRef.current = false;
    setError(null);
    setStatus("queued");
    setProgress({ value: 0, max: 0 });
    try {
      const up = await uploadImage(imageFile);
      const res = await generateVideo({
        positive: positive.trim(),
        image: up.filename,
        worker: up.worker,
        width: aspect.w,
        height: aspect.h,
        length,
        fps: 16,
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
        const newClips: Clip[] = (d.images as string[]).map((path, i) => ({
          id: `${res.prompt_id}-${i}`,
          url: imageUrl(path),
          prompt: positive.trim(),
        }));
        setClips((prev) => [...newClips, ...prev]);
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
            setError("视频生成出错");
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
  }, [imageFile, positive, aspect, length]);

  return (
    <div className="studio">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit();
        }}
      >
        <div className="panel-head">
          <span className="accent" aria-hidden="true" />
          图生视频 · Wan 2.2
        </div>

        <div className="field">
          <label>源图</label>
          <label className="dropzone">
            {imagePreview ? (
              <img src={imagePreview} alt="源图预览" />
            ) : (
              <span>点击上传首帧图片</span>
            )}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <div className="field">
          <label htmlFor="vprompt">运动描述</label>
          <textarea
            id="vprompt"
            placeholder="描述画面如何运动，例如：镜头缓慢推进，人物转头微笑"
            value={positive}
            onChange={(e) => setPositive(e.target.value)}
            rows={3}
          />
        </div>

        <div className="field">
          <label>画幅</label>
          <div className="seg" role="group" aria-label="画幅">
            {ASPECTS.map((a) => (
              <button
                key={a.key}
                type="button"
                className={aspect.key === a.key ? "active" : ""}
                onClick={() => setAspect(a)}
              >
                <span
                  className="glyph"
                  style={{
                    width: 16 * (a.w / Math.max(a.w, a.h)),
                    height: 16 * (a.h / Math.max(a.w, a.h)),
                  }}
                  aria-hidden="true"
                />
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>时长</label>
          <div className="seg" role="group" aria-label="时长">
            {LENGTHS.map((l) => (
              <button
                key={l.v}
                type="button"
                className={length === l.v ? "active" : ""}
                onClick={() => setLength(l.v)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <button type="submit" className="generate-btn" disabled={!canSubmit}>
          {busy ? "生成中…" : !imageFile ? "请先上传图片" : "生成视频"}
        </button>
        <p className="muted" style={{ fontSize: "0.74rem" }}>
          Wan 2.2 双模型 + 4 步加速；视频较重，请耐心等待。
        </p>
      </form>

      <main className="stage">
        <div className="stage-head">
          <h1>
            图生 <span className="grad">视频</span>
          </h1>
          <span className="count">{clips.length} 段</span>
        </div>
        <ProgressBar status={status} progress={progress} />
        {error && <div className="alert">⚠ {error}</div>}
        {clips.length === 0 ? (
          <div className="hero-canvas">
            <div className="hero-orb" aria-hidden="true" />
            <h2>让画面动起来</h2>
            <p>上传一张图片，描述运动，由 Wan 2.2 生成短视频。</p>
          </div>
        ) : (
          <div className="gallery">
            {clips.map((c) => (
              <figure className="shot" key={c.id}>
                <img src={c.url} alt={c.prompt} loading="lazy" />
                <figcaption className="meta">
                  <span className="prompt" title={c.prompt}>
                    {c.prompt}
                  </span>
                  <span className="sub">Wan 2.2 · 动图</span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

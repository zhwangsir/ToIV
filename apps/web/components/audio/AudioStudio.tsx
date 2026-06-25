"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

import { ProgressBar } from "@/components/generate/ProgressBar";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { generateAudio, imageUrl, invalidateJobs, jobEventsUrl } from "@/lib/api";
import { springSoft } from "@/lib/motion";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import type { GenStatus, Progress } from "@/lib/types";

interface Track {
  id: string;
  url: string;
  tags: string;
}

const DURATIONS = [
  { v: 15, label: "15s" },
  { v: 30, label: "30s" },
  { v: 60, label: "60s" },
  { v: 120, label: "120s" },
];

export function AudioStudio() {
  const [tags, setTags] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [seconds, setSeconds] = useState(30);
  const [status, setStatus] = useState<GenStatus>("idle");
  const [progress, setProgress] = useState<Progress>({ value: 0, max: 0 });
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const reduced = useReducedMotion();

  const esRef = useRef<EventSource | null>(null);
  const doneRef = useRef(false);

  useEffect(() => () => esRef.current?.close(), []);

  const busy = status === "queued" || status === "running";
  const canSubmit = tags.trim().length > 0 && !busy;

  const onSubmit = useCallback(async () => {
    if (!tags.trim()) return;
    esRef.current?.close();
    doneRef.current = false;
    setError(null);
    setStatus("queued");
    setProgress({ value: 0, max: 0 });
    try {
      const res = await generateAudio({ tags: tags.trim(), lyrics, seconds });
      setStatus("running");
      const es = new EventSource(jobEventsUrl(res.prompt_id, res.client_id, res.worker));
      esRef.current = es;
      es.addEventListener("progress", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setProgress({ value: d.value ?? 0, max: d.max ?? 0 });
      });
      es.addEventListener("done", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        const mp3 = (d.images as string[]).find((p) => /\.(mp3|flac|wav|opus)/i.test(p)) ?? d.images[0];
        if (mp3) setTracks((prev) => [{ id: res.prompt_id, url: imageUrl(mp3), tags: tags.trim() }, ...prev]);
        // 新音乐已落库:失效作品库缓存。
        invalidateJobs();
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
            setError("音频生成出错");
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
  }, [tags, lyrics, seconds]);

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
          文生音乐 · ACE-Step
        </div>

        <div className="field">
          <label htmlFor="tags">
            风格 / 标签
            <OptimizeButton value={tags} kind="audio" onResult={setTags} disabled={busy} />
          </label>
          <textarea
            id="tags"
            placeholder="如:lofi hip hop, chill, piano, 90 bpm"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            rows={2}
          />
        </div>

        <div className="field">
          <label htmlFor="lyrics">
            歌词 <span className="hint">留空 = 纯音乐</span>
          </label>
          <textarea
            id="lyrics"
            placeholder="可选,支持 [verse] [chorus] 标记"
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            rows={4}
          />
        </div>

        <div className="field">
          <label>时长</label>
          <div className="seg" role="group" aria-label="时长">
            {DURATIONS.map((d) => (
              <button
                key={d.v}
                type="button"
                className={seconds === d.v ? "active" : ""}
                onClick={() => setSeconds(d.v)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <button type="submit" className="generate-btn" disabled={!canSubmit}>
          {busy ? "创作中…" : "生成音乐"}
        </button>
        <p className="muted" style={{ fontSize: "0.74rem" }}>
          ACE-Step 3.5B 文生音乐,可纯音乐或带唱词。
        </p>
      </form>

      <main className="stage">
        <header className="view-header">
          <span className="view-eyebrow">Score · 编曲台</span>
          <h1 className="view-title">
            文生 <em>音乐</em>
          </h1>
          <div className="view-tally">
            <span className="n">{tracks.length}</span>
            <span className="l">首作品</span>
          </div>
        </header>
        <ProgressBar status={status} progress={progress} />
        {error && <div className="alert">⚠ {error}</div>}
        {tracks.length === 0 ? (
          <div className="editorial-empty">
            <span className="ee-orb" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l11-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="17" cy="16" r="3" />
              </svg>
            </span>
            <h2>把文字谱成音乐</h2>
            <p>输入风格标签(可附歌词),由 ACE-Step 3.5B 生成原创音乐 —— 纯音乐或带唱词皆可。</p>
          </div>
        ) : (
          <motion.div
            className="track-list"
            initial="initial"
            animate="enter"
            variants={{ enter: { transition: { staggerChildren: reduced ? 0 : 0.05 } } }}
          >
            {tracks.map((t, i) => (
              <motion.div
                className="track-card"
                key={t.id}
                variants={{
                  initial: { opacity: 0, y: reduced ? 0 : 12 },
                  enter: { opacity: 1, y: 0, transition: springSoft },
                }}
              >
                <div className="track-card-head">
                  <span className="track-no">{String(tracks.length - i).padStart(2, "0")}</span>
                  <span className="track-meta">
                    <span className="track-tags" title={t.tags}>
                      {t.tags}
                    </span>
                    <span className="track-sub">ACE-Step · 原创音乐</span>
                  </span>
                  <a className="track-dl" href={t.url} download aria-label="下载音轨">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
                    </svg>
                  </a>
                </div>
                <div className="track-player">
                  <audio controls preload="none" src={t.url} />
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </main>
    </div>
  );
}

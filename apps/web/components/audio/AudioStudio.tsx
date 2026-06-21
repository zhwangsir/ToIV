"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ProgressBar } from "@/components/generate/ProgressBar";
import { OptimizeButton } from "@/components/ui/OptimizeButton";
import { generateAudio, imageUrl, jobEventsUrl } from "@/lib/api";
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
        <div className="stage-head">
          <h1>
            文生 <span className="grad">音乐</span>
          </h1>
          <span className="count">{tracks.length} 首</span>
        </div>
        <ProgressBar status={status} progress={progress} />
        {error && <div className="alert">⚠ {error}</div>}
        {tracks.length === 0 ? (
          <div className="hero-canvas">
            <div className="hero-orb" aria-hidden="true" />
            <h2>把文字谱成音乐</h2>
            <p>输入风格标签(可加歌词),由 ACE-Step 生成原创音乐。</p>
          </div>
        ) : (
          <div className="track-list">
            {tracks.map((t) => (
              <div className="track-card" key={t.id}>
                <div className="track-tags" title={t.tags}>
                  {t.tags}
                </div>
                <audio controls preload="none" src={t.url} />
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

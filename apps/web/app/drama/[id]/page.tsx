"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Heart,
  RotateCcw,
  Share2,
  MessageSquare,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { useDramaAnalytics } from "@/hooks/useDramaAnalytics";
import type { DramaChapter } from "@/lib/drama";
import styles from "./DramaPlayer.module.css";

const CHAPTERS: DramaChapter[] = [
  { id: "act1", title: "开局", start: 0, color: "#f59e0b" },
  { id: "act2", title: "发展", start: 20, color: "#6366f1" },
  { id: "act3", title: "转折", start: 45, color: "#c084fc" },
  { id: "act4", title: "高潮", start: 70, color: "#34d399" },
];

const RATES = [1, 1.25, 1.5, 2];

function formatTime(sec: number): string {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function DramaPlayerPage() {
  const params = useParams<{ id: string }>();
  const dramaId = params?.id ?? "unknown";

  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [rateIndex, setRateIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDanmuOn, setIsDanmuOn] = useState(false);
  const [liked, setLiked] = useState(false);
  const [goodAt, setGoodAt] = useState<number | null>(null);
  const [boringAt, setBoringAt] = useState<number | null>(null);
  const [seekStart, setSeekStart] = useState<number>(0);

  const videoUrl = useMemo(
    () => `/api/drama/video/${dramaId}.mp4`,
    [dramaId]
  );

  const analytics = useDramaAnalytics({
    dramaId,
    videoUrl,
    chapters: CHAPTERS,
    totalDuration: duration || 90,
  });

  useEffect(() => {
    const onFullscreenChange = () => {
      const fs = Boolean(document.fullscreenElement);
      setIsFullscreen(fs);
      analytics.trackFullscreenChange(fs);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [analytics]);

  const getCurrentTime = () => videoRef.current?.currentTime ?? 0;

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
    } else {
      v.pause();
    }
  };

  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
  };

  const handlePlay = () => {
    setIsPlaying(true);
    analytics.trackPlay(getCurrentTime());
  };

  const handlePause = () => {
    setIsPlaying(false);
    analytics.trackPause(getCurrentTime());
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    analytics.trackTimeUpdate(v.currentTime);
  };

  const handleEnded = () => {
    setIsPlaying(false);
    analytics.trackCompleted(getCurrentTime());
  };

  const handleWaiting = () => {
    analytics.trackBuffering(getCurrentTime());
  };

  const handleSeeking = () => {
    const v = videoRef.current;
    if (!v) return;
    setSeekStart(v.currentTime);
  };

  const handleSeeked = () => {
    const v = videoRef.current;
    if (!v) return;
    analytics.trackSeek(seekStart, v.currentTime);
  };

  const handleRateChange = () => {
    const v = videoRef.current;
    if (!v) return;
    analytics.trackRateChange(v.playbackRate);
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !progressRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = ratio * duration;
    analytics.trackSeek(v.currentTime, target);
    v.currentTime = target;
  };

  const seekToChapter = (start: number) => {
    const v = videoRef.current;
    if (!v) return;
    analytics.trackSeek(v.currentTime, start);
    v.currentTime = start;
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const val = parseFloat(e.target.value);
    v.volume = val;
    setVolume(val);
    setIsMuted(val === 0);
  };

  const cycleRate = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = (rateIndex + 1) % RATES.length;
    v.playbackRate = RATES[next];
    setRateIndex(next);
  };

  const toggleFullscreen = async () => {
    const container = videoRef.current?.parentElement;
    if (!container) return;
    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // ignore
    }
  };

  const handleLike = () => {
    setLiked((p) => !p);
    analytics.trackInteraction("like", getCurrentTime());
  };

  const handleReplay = () => {
    const v = videoRef.current;
    if (!v) return;
    analytics.trackInteraction("replay", v.currentTime);
    v.currentTime = 0;
    void v.play();
  };

  const handleShare = async () => {
    const url = window.location.href;
    analytics.trackInteraction("share_click", getCurrentTime(), { share_type: "copy" });
    if (navigator.share) {
      try {
        await navigator.share({ title: "AI 短剧", url });
        return;
      } catch {
        // fallback
      }
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // ignore
    }
  };

  const handleMarkGood = () => {
    const t = getCurrentTime();
    setGoodAt(t);
    analytics.trackInteraction("mark_good", t);
  };

  const handleMarkBoring = () => {
    const t = getCurrentTime();
    setBoringAt(t);
    analytics.trackInteraction("mark_boring", t);
  };

  const progressPercent = duration ? (currentTime / duration) * 100 : 0;

  return (
    <main className={styles.playerPage}>
      <div className={styles.ambientGlow} aria-hidden="true" />
      <section className={styles.playerCard}>
        <div
          className={`${styles.videoStage} ${!isPlaying ? styles.isPaused : ""}`}
        >
          <video
            ref={videoRef}
            className={styles.video}
            src={videoUrl}
            preload="metadata"
            playsInline
            onLoadedMetadata={handleLoadedMetadata}
            onPlay={handlePlay}
            onPause={handlePause}
            onTimeUpdate={handleTimeUpdate}
            onEnded={handleEnded}
            onWaiting={handleWaiting}
            onSeeking={handleSeeking}
            onSeeked={handleSeeked}
            onRateChange={handleRateChange}
          />

          {(!isPlaying || currentTime === 0) && (
            <button
              className={`${styles.centerPlay} ${styles.visible}`}
              onClick={togglePlay}
              aria-label={isPlaying ? "暂停" : "播放"}
            >
              <span className={styles.centerPlayButton}>
                <Play size={32} fill="currentColor" />
              </span>
            </button>
          )}

          <div className={styles.topBar}>
            <h1 className={styles.title}>AI 短剧 · {dramaId}</h1>
            <button
              className={`${styles.iconButton} ${isDanmuOn ? styles.active : ""}`}
              onClick={() => setIsDanmuOn((p) => !p)}
              aria-label="弹幕开关"
            >
              <MessageSquare size={18} />
            </button>
          </div>

          <div className={styles.controlsLayer}>
            <div
              ref={progressRef}
              className={styles.progressWrap}
              onClick={handleProgressClick}
            >
              <div className={styles.progressRail}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${progressPercent}%` }}
                >
                  <div className={styles.progressThumb} />
                </div>
                {CHAPTERS.map((ch) => (
                  <div
                    key={ch.id}
                    className={styles.chapterMarker}
                    style={{
                      left: `${duration ? (ch.start / duration) * 100 : 0}%`,
                      ["--marker-color" as string]: ch.color,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      seekToChapter(ch.start);
                    }}
                  >
                    <span className={styles.chapterTooltip}>{ch.title}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.controlRow}>
              <div className={styles.controlGroup}>
                <button
                  className={styles.iconButton}
                  onClick={togglePlay}
                  aria-label={isPlaying ? "暂停" : "播放"}
                >
                  {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                </button>
                <button
                  className={styles.iconButton}
                  onClick={toggleMute}
                  aria-label={isMuted ? "取消静音" : "静音"}
                >
                  {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className={styles.volumeSlider}
                  aria-label="音量"
                />
                <span className={styles.timeLabel}>
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
              </div>

              <div className={styles.controlGroup}>
                <button className={styles.rateButton} onClick={cycleRate}>
                  {RATES[rateIndex]}x
                </button>
                <button
                  className={styles.iconButton}
                  onClick={toggleFullscreen}
                  aria-label={isFullscreen ? "退出全屏" : "全屏"}
                >
                  {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.interactionBar}>
          <button
            className={`${styles.interactionButton} ${liked ? styles.active : ""}`}
            onClick={handleLike}
          >
            <Heart size={16} fill={liked ? "currentColor" : "none"} />
            点赞
          </button>
          <button
            className={`${styles.interactionButton} ${styles.good} ${goodAt !== null ? styles.active : ""}`}
            onClick={handleMarkGood}
          >
            <ThumbsUp size={16} />
            这里好看
          </button>
          <button
            className={`${styles.interactionButton} ${styles.boring} ${boringAt !== null ? styles.active : ""}`}
            onClick={handleMarkBoring}
          >
            <ThumbsDown size={16} />
            无聊
          </button>
          <button className={styles.interactionButton} onClick={handleReplay}>
            <RotateCcw size={16} />
            重播
          </button>
          <button className={styles.interactionButton} onClick={handleShare}>
            <Share2 size={16} />
            分享
          </button>
        </div>
      </section>
    </main>
  );
}

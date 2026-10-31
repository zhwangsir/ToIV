"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DramaChapter, DramaEvent, DramaEventType } from "@/lib/drama";

const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 5000;
const USER_ID_KEY = "toiv_drama_user_id";

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getAnonymousUserId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = window.localStorage.getItem(USER_ID_KEY);
    if (!id) {
      id = generateId();
      window.localStorage.setItem(USER_ID_KEY, id);
    }
    return id;
  } catch {
    return generateId();
  }
}

function getDeviceInfo() {
  return {
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
    screen:
      typeof window !== "undefined"
        ? `${window.screen.width}x${window.screen.height}`
        : "",
    language:
      typeof navigator !== "undefined" ? navigator.language || "" : "",
    platform:
      typeof navigator !== "undefined" ? navigator.platform || "" : "",
  };
}

interface UseDramaAnalyticsOptions {
  dramaId: string;
  videoUrl: string;
  chapters: DramaChapter[];
  totalDuration: number;
}

export function useDramaAnalytics({
  dramaId,
  videoUrl,
  chapters,
  totalDuration,
}: UseDramaAnalyticsOptions) {
  const sessionIdRef = useRef<string>(generateId());
  const userIdRef = useRef<string>(getAnonymousUserId());
  const queueRef = useRef<DramaEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pageEnterRef = useRef<number>(Date.now());
  const hasPlayedRef = useRef<boolean>(false);
  const lastHeartbeatRef = useRef<number>(-1);
  const lastChapterRef = useRef<string | null>(null);
  const lastTimeRef = useRef<number>(0);
  const isFlushingRef = useRef<boolean>(false);

  const [isReady, setIsReady] = useState(true);

  useEffect(() => {
    flushTimerRef.current = setInterval(() => {
      void flush(false);
    }, FLUSH_INTERVAL_MS);

    const onBeforeUnload = () => {
      const lastTime = lastTimeRef.current;
      const isCompleted = lastTime >= totalDuration - 1;
      if (!isCompleted) {
        track("drop_off", {
          last_time: lastTime,
          duration: totalDuration,
          reason: "page_unload",
        });
      }
      flush(true);
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      void flush(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dramaId, videoUrl, totalDuration]);

  const track = useCallback(
    (eventType: DramaEventType, payload?: Record<string, unknown>) => {
      const event: DramaEvent = {
        event_id: generateId(),
        session_id: sessionIdRef.current,
        user_id: userIdRef.current,
        drama_id: dramaId,
        event_type: eventType,
        current_time: payload?.current_time as number | undefined,
        duration: totalDuration,
        payload,
        client_ts: Date.now(),
      };
      queueRef.current.push(event);
      if (queueRef.current.length >= BATCH_SIZE) {
        void flush(false);
      }
    },
    [dramaId, totalDuration]
  );

  const flush = useCallback(
    async (useBeacon: boolean) => {
      if (isFlushingRef.current || queueRef.current.length === 0) return;
      isFlushingRef.current = true;
      const batch = queueRef.current.splice(0, queueRef.current.length);

      const body = JSON.stringify({
        events: batch,
        device: getDeviceInfo(),
        video_url: videoUrl,
      });
      const url = "/api/drama/event";

      try {
        if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        } else {
          await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
          });
        }
      } catch (err) {
        // 失败时回灌队列(避免无限膨胀,只保留最近 50 条)
        queueRef.current = [...batch, ...queueRef.current].slice(-50);
      } finally {
        isFlushingRef.current = false;
      }
    },
    [videoUrl]
  );

  const resolveChapter = useCallback(
    (time: number): string | null => {
      let matched: DramaChapter | null = null;
      for (const ch of chapters) {
        if (time >= ch.start) matched = ch;
      }
      return matched?.id ?? null;
    },
    [chapters]
  );

  const trackPlay = useCallback(
    (currentTime: number) => {
      if (!hasPlayedRef.current) {
        hasPlayedRef.current = true;
        track("first_play_delay", {
          delay_ms: Date.now() - pageEnterRef.current,
          current_time: currentTime,
        });
      }
      track("play", { current_time: currentTime });
    },
    [track]
  );

  const trackPause = useCallback(
    (currentTime: number) => {
      track("pause", { current_time: currentTime });
    },
    [track]
  );

  const trackSeek = useCallback(
    (fromTime: number, toTime: number) => {
      track("seek", {
        from_time: fromTime,
        to_time: toTime,
        delta: toTime - fromTime,
      });
    },
    [track]
  );

  const trackTimeUpdate = useCallback(
    (currentTime: number) => {
      const second = Math.floor(currentTime);
      if (second === lastHeartbeatRef.current) return;
      lastHeartbeatRef.current = second;
      lastTimeRef.current = currentTime;

      track("timeupdate", { current_time: currentTime, second });

      const chapterId = resolveChapter(currentTime);
      if (chapterId && chapterId !== lastChapterRef.current) {
        if (lastChapterRef.current) {
          track("chapter_exit", {
            chapter_id: lastChapterRef.current,
            exit_time: currentTime,
          });
        }
        track("chapter_enter", {
          chapter_id: chapterId,
          start_time: currentTime,
        });
        lastChapterRef.current = chapterId;
      }
    },
    [resolveChapter, track]
  );

  const trackCompleted = useCallback(
    (currentTime: number) => {
      track("completed", { current_time: currentTime });
    },
    [track]
  );

  const trackRateChange = useCallback(
    (rate: number) => {
      track("rate_change", { playback_rate: rate });
    },
    [track]
  );

  const trackFullscreenChange = useCallback(
    (isFullscreen: boolean) => {
      track("fullscreen_change", { is_fullscreen: isFullscreen });
    },
    [track]
  );

  const trackBuffering = useCallback(
    (currentTime: number) => {
      track("buffering", { current_time: currentTime });
    },
    [track]
  );

  const trackInteraction = useCallback(
    (
      type: "like" | "replay" | "mark_good" | "mark_boring" | "share_click",
      currentTime: number,
      extra?: Record<string, unknown>
    ) => {
      track(type, { current_time: currentTime, ...extra });
    },
    [track]
  );

  return useMemo(
    () => ({
      sessionId: sessionIdRef.current,
      userId: userIdRef.current,
      isReady,
      trackPlay,
      trackPause,
      trackSeek,
      trackTimeUpdate,
      trackCompleted,
      trackRateChange,
      trackFullscreenChange,
      trackBuffering,
      trackInteraction,
      flush,
    }),
    [
      isReady,
      trackPlay,
      trackPause,
      trackSeek,
      trackTimeUpdate,
      trackCompleted,
      trackRateChange,
      trackFullscreenChange,
      trackBuffering,
      trackInteraction,
      flush,
    ]
  );
}

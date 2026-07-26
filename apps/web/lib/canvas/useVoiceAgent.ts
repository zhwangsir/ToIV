/** 语音 Agent hook —— 封装录音 / 上传 / SSE 接收 / TTS 播放。
 *
 * 流程:
 *  1. startRecording():MediaRecorder 录制 audio/webm( Safari 兜底 audio/mp4)
 *  2. stopRecording():打包 Blob → POST /api/agent/voice (FormData: audio + canvas_id)
 *  3. SSE 订阅 /api/agent/voice/events?canvas_id=... → 收 transcript / agent_text / voice 事件
 *  4. 收到 voice 事件 → 自动播放 TTS(支持打断:新音频覆盖旧音频)
 *
 * 状态机:idle → recording → processing → playing → idle
 *
 * 注:此 hook 不依赖画布 store,只暴露状态与动作;VoiceBar 负责 UI 渲染。
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, authHeaders, getToken } from "@/lib/api";

export type VoiceAgentState = "idle" | "recording" | "processing" | "playing";

// 录音最大时长(毫秒),到点自动停止并进入上传流程
const MAX_RECORD_MS = 60_000;
// 上传失败重试延迟(网络错误 / 5xx 时自动重试 1 次)
const UPLOAD_RETRY_DELAY_MS = 1000;
// 录音格式候选:优先 webm/opus(Chrome/Firefox),兜底 mp4(Safari),再兜底浏览器默认
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"];

/** 是否为用户主动中断(AbortError 不算错误) */
function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface VoiceTurn {
  id: string;
  transcript: string;
  agentText: string;
  audioUrl?: string;
  at: number;
}

export interface VoiceAgentEvent {
  type: string;
  content?: string;
  url?: string;
}

interface UseVoiceAgentOptions {
  canvasId: string | null;
  enabled: boolean;
  onEvent?: (ev: VoiceAgentEvent) => void;
}

export function useVoiceAgent({ canvasId, enabled, onEvent }: UseVoiceAgentOptions) {
  const [state, setState] = useState<VoiceAgentState>("idle");
  const [transcript, setTranscript] = useState("");
  const [agentText, setAgentText] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<VoiceTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  // 录音最大时长定时器(60s 自动停止)
  const maxRecordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Esc 取消标记:true 时 onstop 丢弃录音不上传
  const cancelRequestedRef = useRef(false);

  // 当前轮的转录 / Agent 文本 / 音频 URL(refs,避免 SSE 闭包陈旧)
  const curTranscriptRef = useRef("");
  const curAgentTextRef = useRef("");
  const curAudioUrlRef = useRef<string | null>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  // ---------- 播放 TTS(打断旧音频)----------
  const playAudio = useCallback((url: string) => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
    }
    const el = new Audio(url);
    el.onplay = () => setState("playing");
    el.onended = () => setState("idle");
    el.onerror = () => setState("idle");
    audioElRef.current = el;
    el.play().catch(() => {
      // 自动播放被浏览器拒绝 → 回到 idle,等用户下一次交互
      setState("idle");
    });
  }, []);

  const stopAudio = useCallback(() => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = "";
      audioElRef.current = null;
    }
    setState("idle");
  }, []);

  // ---------- 音量可视化 ----------
  const startVolumeMeter = useCallback((stream: MediaStream) => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        setVolume(sum / data.length / 255);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // 静默失败(浏览器不支持 AudioContext)
    }
  }, []);

  const stopVolumeMeter = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setVolume(0);
  }, []);

  // ---------- 上传音频 ----------
  const uploadAudio = useCallback(
    async (blob: Blob) => {
      if (!canvasId) {
        setState("idle");
        return;
      }
      // 取消上一次未完成的上传(防并发)
      if (uploadAbortRef.current) {
        uploadAbortRef.current.abort();
      }
      const controller = new AbortController();
      uploadAbortRef.current = controller;
      // 按实际录制格式选扩展名(webm / mp4)
      const filename = blob.type.includes("mp4") ? "voice.mp4" : "voice.webm";

      const doUpload = async (): Promise<void> => {
        const fd = new FormData();
        fd.append("audio", blob, filename);
        fd.append("canvas_id", canvasId);
        const res = await fetch(`${API_BASE}/api/agent/voice`, {
          method: "POST",
          headers: authHeaders(),
          body: fd,
          signal: controller.signal,
        });
        if (!res.ok) {
          // 带 status 抛错,便于上层区分 4xx(不重试)与 5xx/网络错误(重试)
          const err = new Error(`语音上传失败 (${res.status})`) as Error & {
            status?: number;
          };
          err.status = res.status;
          throw err;
        }
        // 后端通过 SSE 推送后续 transcript / agent_text / voice 事件
      };

      try {
        await doUpload();
      } catch (e) {
        // abort 不算错误(用户主动开始新录音)
        if (isAbortError(e)) return;
        const status = (e as { status?: number }).status;
        // 4xx 是请求本身问题,重试无意义;网络错误(无 status)/ 5xx 自动重试 1 次
        const retryable = status === undefined || status >= 500;
        if (!retryable) {
          setError((e as Error).message);
          setState("idle");
          return;
        }
        await sleep(UPLOAD_RETRY_DELAY_MS);
        if (controller.signal.aborted) return;
        try {
          await doUpload();
        } catch (e2) {
          if (isAbortError(e2)) return;
          setError((e2 as Error).message);
          setState("idle");
        }
      } finally {
        if (uploadAbortRef.current === controller) {
          uploadAbortRef.current = null;
        }
      }
    },
    [canvasId]
  );

  // ---------- 录音控制 ----------
  const clearMaxRecordTimer = useCallback(() => {
    if (maxRecordTimerRef.current) {
      clearTimeout(maxRecordTimerRef.current);
      maxRecordTimerRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    clearMaxRecordTimer();
    const mr = mediaRecorderRef.current;
    if (!mr || mr.state === "inactive") return;
    mr.stop();
    mediaRecorderRef.current = null;
    stopVolumeMeter();
  }, [stopVolumeMeter, clearMaxRecordTimer]);

  const startRecording = useCallback(async () => {
    if (state === "recording") return;
    setError(null);
    // 重置当前轮
    curTranscriptRef.current = "";
    curAgentTextRef.current = "";
    curAudioUrlRef.current = null;
    setTranscript("");
    setAgentText("");
    setAudioUrl(null);
    try {
      // 打断当前播放的 TTS(用户开始说话,旧 TTS 应立即停)
      if (state === "playing") {
        stopAudio();
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // 格式嗅探:优先 audio/webm;codecs=opus,兜底 audio/mp4(Safari),
      // 都不支持时不传 mimeType,用浏览器默认格式
      const mimeType = MIME_CANDIDATES.find((t) =>
        MediaRecorder.isTypeSupported(t)
      );
      const mr = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const blobType = mr.mimeType || mimeType || "audio/webm";
      cancelRequestedRef.current = false;
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        // 关闭麦克风流
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        // Esc 取消:丢弃本次录音,不上传
        if (cancelRequestedRef.current) {
          cancelRequestedRef.current = false;
          chunksRef.current = [];
          setState("idle");
          return;
        }
        const blob = new Blob(chunksRef.current, { type: blobType });
        setState("processing");
        uploadAudio(blob);
      };
      mr.start();
      mediaRecorderRef.current = mr;
      // 60s 上限:到点自动停止(走正常 onstop → 上传流程)
      clearMaxRecordTimer();
      maxRecordTimerRef.current = setTimeout(() => {
        maxRecordTimerRef.current = null;
        stopRecording();
      }, MAX_RECORD_MS);
      setState("recording");
      startVolumeMeter(stream);
    } catch (e) {
      // 麦克风已打开但 MediaRecorder 构造失败时,释放 stream 避免占用
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setError((e as Error).message ?? "麦克风无法访问");
    }
  }, [state, startVolumeMeter, uploadAudio, stopAudio, clearMaxRecordTimer, stopRecording]);

  // 取消录音(Esc):停止并丢弃,不进入上传流程
  const cancelRecording = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (!mr || mr.state === "inactive") return;
    cancelRequestedRef.current = true;
    stopRecording();
  }, [stopRecording]);

  // ---------- SSE 订阅语音 Agent 事件 ----------
  useEffect(() => {
    if (!enabled || !canvasId) return;
    const token = getToken();
    const url = `${API_BASE}/api/agent/voice/events?canvas_id=${encodeURIComponent(
      canvasId
    )}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as VoiceAgentEvent;
        if (ev.type === "transcript" && ev.content) {
          curTranscriptRef.current = ev.content;
          setTranscript(ev.content);
        } else if (ev.type === "agent_text" && ev.content) {
          curAgentTextRef.current += ev.content;
          setAgentText(curAgentTextRef.current);
        } else if (ev.type === "voice" && ev.url) {
          curAudioUrlRef.current = ev.url;
          setAudioUrl(ev.url);
          playAudio(ev.url);
        } else if (ev.type === "done") {
          // 归档到历史(最多保留 20 轮)
          if (curTranscriptRef.current || curAgentTextRef.current) {
            const turn: VoiceTurn = {
              id:
                typeof crypto !== "undefined" && crypto.randomUUID
                  ? crypto.randomUUID()
                  : String(Date.now()),
              transcript: curTranscriptRef.current,
              agentText: curAgentTextRef.current,
              audioUrl: curAudioUrlRef.current ?? undefined,
              at: Date.now(),
            };
            setHistory((h) => [...h, turn].slice(-20));
          }
          curTranscriptRef.current = "";
          curAgentTextRef.current = "";
          curAudioUrlRef.current = null;
          setTranscript("");
          setAgentText("");
          setAudioUrl(null);
          setState((s) => (s === "processing" ? "idle" : s));
        }
        onEventRef.current?.(ev);
      } catch {
        // 忽略解析失败的心跳等
      }
    };
    es.onerror = () => {
      // EventSource 内置自动重连,不在此处手动处理
    };
    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [enabled, canvasId, playAudio]);

  // ---------- 卸载清理 ----------
  useEffect(() => {
    return () => {
      clearMaxRecordTimer();
      stopVolumeMeter();
      eventSourceRef.current?.close();
      if (audioElRef.current) {
        audioElRef.current.pause();
        audioElRef.current.src = "";
        audioElRef.current = null;
      }
      // 停止 MediaRecorder(如果在录音中)并释放麦克风流;
      // 置取消标记,避免 onstop 在卸载后还触发上传
      cancelRequestedRef.current = true;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      // 卸载时取消未完成的上传
      uploadAbortRef.current?.abort();
    };
  }, [stopVolumeMeter, clearMaxRecordTimer]);

  return {
    state,
    transcript,
    agentText,
    audioUrl,
    history,
    error,
    volume,
    startRecording,
    stopRecording,
    cancelRecording,
    stopAudio,
  };
}

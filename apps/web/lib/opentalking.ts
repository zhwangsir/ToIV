"use client";

import { authHeaders, getToken } from "./api";

// 同源走后端代理:所有 OpenTalking 调用经 /api/opentalking/*
// 后端 routes/opentalking.py 做反向代理 + JWT 鉴权 + shape 转换(avatars/models)
// 前端不再直连 127.0.0.1:4403,避免 CORS + 绕过鉴权
const OT_BASE = "/api/opentalking";

export type ModelInfo = {
  id: string;
  backend: string;
  status: string;
  reason: string | null;
};

export type ModelsResponse = {
  models: ModelInfo[];
  default_model: string;
};

export type AvatarSummary = {
  id: string;
  name: string | null;
  model_type: string;
  width: number;
  height: number;
  person_mode: string;
  is_custom: boolean;
};

export type AvatarsResponse = {
  avatars: AvatarSummary[];
};

export type CreateSessionRequest = {
  avatar_id?: string;
  model?: string;
  tts_provider?: string;
  stt_provider?: string;
  tts_voice?: string;
  llm_system_prompt?: string;
  user_id?: string;
  agent_enabled?: boolean;
  memory_enabled?: boolean;
  knowledge_enabled?: boolean;
};

export type CreateSessionResponse = {
  session_id: string;
  status: string;
  model: string;
  avatar_id: string;
  tts_provider: string;
  stt_provider: string;
};

export type SpeakRequest = {
  text: string;
  voice?: string;
  tts_provider?: string;
};

export type SessionState =
  | "created"
  | "initializing"
  | "ready"
  | "speaking"
  | "idle"
  | "expired"
  | "error";

/** 连接状态机:对齐 OpenTalking 的 ConnectionStatus 六态。 */
export type ConnectionStatus =
  | "idle" // 未连接
  | "connecting" // 连接中
  | "queued" // 排队中
  | "live" // 已连接
  | "expiring" // 即将到期
  | "error"; // 连接错误

export type SseEvent =
  | { type: "speech.started"; data: { session_id: string; text: string } }
  | { type: "subtitle.chunk"; data: { session_id: string; text: string; is_final: boolean } }
  | { type: "speech.ended"; data: { session_id: string; text: string } }
  | { type: "session.state_changed"; data: { session_id: string; old_state: string; new_state: SessionState } }
  | { type: "error"; data: { session_id: string; code: string; message: string } }
  | { type: "ping"; data: unknown };

class ApiError extends Error {
  status: number;
  detail: string | null;
  constructor(status: number, detail: string | null) {
    super(detail || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : null;
    } catch {}
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

/** 统一 fetch 封装:自动带 JWT header(同源代理,不再直连 4403)。 */
async function otFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${OT_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...authHeaders(),
    },
  });
}

export async function otGetModels(): Promise<ModelsResponse> {
  const res = await otFetch(`/models`);
  return handleResponse<ModelsResponse>(res);
}

export async function otGetAvatars(): Promise<AvatarsResponse> {
  const res = await otFetch(`/avatars`);
  return handleResponse<AvatarsResponse>(res);
}

export async function otGetHealth(): Promise<Record<string, unknown>> {
  const res = await otFetch(`/health`);
  return handleResponse<Record<string, unknown>>(res);
}

export async function otGetStatus(): Promise<{ enabled: boolean; reachable: boolean; model?: string; tts_provider?: string }> {
  // /status 无需鉴权(后端 opentalking.py 的 ot_status 未加 Depends)
  const res = await fetch(`${OT_BASE}/status`);
  return handleResponse(res);
}

export async function otCreateSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
  const res = await otFetch(`/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // 全本地化:STT 走 workstation SenseVoice,TTS 走 IndexTTS2(:9200 经 shim)
      // agent/memory/knowledge 由调用方显式传入(后端契约默认全 false)
      tts_provider: "indextts",
      stt_provider: "sensevoice",
      user_id: "toiv-user",
      ...req,
    }),
  });
  return handleResponse<CreateSessionResponse>(res);
}

export async function otStartSession(sessionId: string): Promise<{ status?: string }> {
  const res = await otFetch(`/sessions/${sessionId}/start`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, null);
  // start 响应带会话状态(quicktalk 缓存命中时直接 ready),供调用方补齐 WebRTC 启动
  return res.json().catch(() => ({}));
}

export async function otSpeak(sessionId: string, req: SpeakRequest): Promise<void> {
  const res = await otFetch(`/sessions/${sessionId}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new ApiError(res.status, null);
}

export async function otInterrupt(sessionId: string): Promise<void> {
  const res = await otFetch(`/sessions/${sessionId}/interrupt`, { method: "POST" });
  if (!res.ok) throw new ApiError(res.status, null);
}

export type SpeakAudioResponse = {
  session_id: string;
  status: string;
  /** STT 识别出的文本(引擎返回,前端据此回填用户消息) */
  text: string;
};

/** 语音输入:上传麦克风音频 → 引擎 STT → 自动走 speak 流水线(LLM→TTS→数字人)。 */
export async function otSpeakAudio(
  sessionId: string,
  blob: Blob,
  filename = "speech.webm",
): Promise<SpeakAudioResponse> {
  const form = new FormData();
  form.append("file", blob, filename);
  // 不手动设 Content-Type:浏览器自动带 multipart boundary
  const res = await otFetch(`/sessions/${sessionId}/speak_audio`, {
    method: "POST",
    body: form,
  });
  return handleResponse<SpeakAudioResponse>(res);
}

export type SseCleanup = () => void;

export function otConnectSse(
  sessionId: string,
  handlers: {
    onSpeechStarted?: (text: string) => void;
    onSubtitle?: (text: string, isFinal: boolean) => void;
    onSpeechEnded?: (text: string) => void;
    onStateChanged?: (state: SessionState) => void;
    onError?: (code: string, message: string) => void;
    /** SSE 通道断开后回调一次(重连成功后会重新武装)。 */
    onDisconnect?: () => void;
  },
): SseCleanup {
  // EventSource 无法带 Authorization header,复用后端 deps.py 支持的 ?token= 查询参数
  const token = getToken();
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  const es = new EventSource(`${OT_BASE}/sessions/${sessionId}/events${tokenQuery}`);

  const handleEvent = (type: string, rawData: MessageEvent["data"]) => {
    try {
      const data = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      switch (type) {
        case "speech.started":
          handlers.onSpeechStarted?.(data.text ?? "");
          break;
        case "subtitle.chunk":
          handlers.onSubtitle?.(data.text ?? "", data.is_final ?? false);
          break;
        case "speech.ended":
          handlers.onSpeechEnded?.(data.text ?? "");
          break;
        case "session.state_changed":
          handlers.onStateChanged?.(data.new_state as SessionState);
          break;
        case "error":
          handlers.onError?.(data.code ?? "unknown", data.message ?? "Unknown error");
          break;
      }
    } catch {}
  };

  const eventTypes = [
    "speech.started",
    "speech.media_started",
    "subtitle.chunk",
    "speech.ended",
    "session.state_changed",
    "session.queued",
    "session.expiring",
    "session.expired",
    "error",
    "ping",
    "message",
  ];

  for (const name of eventTypes) {
    es.addEventListener(name, ((e: MessageEvent) => handleEvent(name, e.data)) as EventListener);
  }

  // EventSource 断线会自动重连,期间反复触发 onerror:
  // 仅在已成功建立过连接后,对每段断开只通知一次(onopen 重新武装),
  // 避免重连风暴刷 toast;从未打开过则交给会话创建/启动的错误路径提示。
  let hadOpen = false;
  let notified = false;
  es.onopen = () => {
    hadOpen = true;
    notified = false;
  };
  es.onerror = () => {
    if (!hadOpen || notified) return;
    notified = true;
    handlers.onDisconnect?.();
  };

  return () => es.close();
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

async function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 8000): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }
    function onStateChange() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", onStateChange);
  });
}

export type OtPlaybackHandle = {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
};

export async function otStartWebRTC(
  sessionId: string,
  videoEl: HTMLVideoElement,
): Promise<OtPlaybackHandle> {
  let iceServers = DEFAULT_ICE_SERVERS;
  try {
    const iceRes = await otFetch(`/sessions/webrtc/ice-config`);
    if (iceRes.ok) {
      const iceConfig = await iceRes.json();
      if (Array.isArray(iceConfig.iceServers) && iceConfig.iceServers.length > 0) {
        iceServers = iceConfig.iceServers;
      }
    }
  } catch {}

  const pc = new RTCPeerConnection({ iceServers });
  const mediaStream = new MediaStream();
  videoEl.srcObject = mediaStream;
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  // iOS Safari 兼容:同时设 webkit-playsinline(虽然 React 类型未声明,但运行时有效)
  (videoEl as HTMLVideoElement & { webkitPlaysInline?: boolean }).webkitPlaysInline = true;
  videoEl.muted = false;

  pc.ontrack = (ev) => {
    if (ev.track && !mediaStream.getTracks().some((t) => t.id === ev.track.id)) {
      mediaStream.addTrack(ev.track);
    }
    videoEl.play().catch(() => {
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    });
  };

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  const answer = await otFetch(`/sessions/${sessionId}/webrtc/offer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: pc.localDescription?.sdp ?? "",
      type: pc.localDescription?.type ?? "offer",
    }),
  }).then((r) => r.json());

  await pc.setRemoteDescription(new RTCSessionDescription(answer));

  return { pc, remoteStream: mediaStream };
}

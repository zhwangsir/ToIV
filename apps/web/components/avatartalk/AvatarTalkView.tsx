"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { getToken } from "@/lib/api";
import { genId } from "@/lib/id";
import {
  otGetModels,
  otGetAvatars,
  otGetStatus,
  otCreateSession,
  otStartSession,
  otSpeak,
  otSpeakAudio,
  otInterrupt,
  otConnectSse,
  otStartWebRTC,
  type SessionState,
  type ConnectionStatus,
  type ModelInfo,
  type AvatarSummary,
} from "@/lib/opentalking";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  isFinal?: boolean;
  timestamp: Date;
};

/** 引擎探活结果(对齐后端 GET /api/opentalking/status)。 */
type EngineStatus = {
  enabled: boolean;
  reachable: boolean;
  model?: string;
};

/** pill 展示元数据:Badge tone + 过渡态脉冲。 */
type PillMeta = { label: string; tone: BadgeTone; pulse?: boolean };

/** 无会话时 pill 按引擎探活三态展示:已连接 / 引擎离线 / 未配置。 */
function engineToPillMeta(engine: EngineStatus | null): PillMeta {
  if (!engine) return CONNECTION_META.idle; // 首次探测中
  if (!engine.enabled) {
    return { label: "未配置", tone: "neutral" };
  }
  if (!engine.reachable) {
    return { label: "引擎离线", tone: "err" };
  }
  return {
    label: engine.model ? `已连接 ${engine.model}` : "已连接",
    tone: "ok",
  };
}

// ── 连接状态 → 展示元数据(Badge tone/标签),三态与探活 pill 一致 ──
const CONNECTION_META: Record<ConnectionStatus, PillMeta> = {
  idle: { label: "未连接", tone: "neutral" },
  connecting: { label: "连接中", tone: "run", pulse: true },
  queued: { label: "排队中", tone: "run", pulse: true },
  live: { label: "已连接", tone: "ok" },
  expiring: { label: "即将到期", tone: "warn" },
  error: { label: "连接错误", tone: "err" },
};

// SessionState → ConnectionStatus 映射(简化前端状态机)
function sessionToConnection(s: SessionState): ConnectionStatus {
  switch (s) {
    case "created":
    case "idle":
      return "idle";
    case "initializing":
      return "connecting";
    case "ready":
    case "speaking":
      return "live";
    case "expired":
      return "expiring";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/** 构建 avatar 预览图 URL(同源代理 + ?token= 鉴权,img 标签可用)。 */
function avatarPreviewUrl(id: string): string {
  const token = getToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `/api/opentalking/avatars/${encodeURIComponent(id)}/preview${q}`;
}

/** 选一个浏览器支持、引擎 ffmpeg 也能解码的录音 mime。 */
function pickAudioMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t));
}

export function AvatarTalkView() {
  const toast = useToast();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>("created");
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [avatars, setAvatars] = useState<AvatarSummary[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [loadingAvatars, setLoadingAvatars] = useState(true);
  const [modelsUnreachable, setModelsUnreachable] = useState(false);
  const [selectedAvatar, setSelectedAvatar] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [ttsVoice, setTtsVoice] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 语音输入:录音中 / 上传识别中(STT 期间锁定输入区)
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const cleanupSseRef = useRef<(() => void) | null>(null);
  // WebRTC 只启动一次:SSE ready 事件与 start 响应都可能触发,避免重复建连
  const webrtcStartedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // 引擎探活:首屏 + 每 30s 轮询,卸载清理;失败按「引擎离线」处理
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      otGetStatus()
        .then((s) => {
          if (cancelled) return;
          setEngineStatus({
            enabled: Boolean(s?.enabled),
            reachable: Boolean(s?.reachable),
            model: typeof s?.model === "string" ? s.model : undefined,
          });
        })
        .catch(() => {
          // 探活本身失败(网络错/后端 5xx)按引擎离线展示
          if (!cancelled) setEngineStatus({ enabled: true, reachable: false });
        });
    };
    probe();
    const timer = window.setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // 初始加载:models + avatars,带防御式兜底
  useEffect(() => {
    let cancelled = false;
    otGetModels()
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.models) ? res.models : [];
        setModels(list);
        // 只在可用模型里挑默认值:不可用的(not_configured 等)选中必然 400。
        const available = list.filter((m) => m.status === "available");
        if (res?.default_model && available.some((m) => m.id === res.default_model)) {
          setSelectedModel(res.default_model);
        } else if (available.length > 0) {
          setSelectedModel(available[0].id);
        } else {
          setSelectedModel("");
        }
      })
      .catch(() => {
        // 不塞假模型:引擎不可达时展示空态,由探活 pill 与空态文案说明
        if (cancelled) return;
        setModels([]);
        setSelectedModel("");
        setModelsUnreachable(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    otGetAvatars()
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.avatars) ? res.avatars : [];
        setAvatars(list);
        if (list.length > 0) setSelectedAvatar(list[0].id);
      })
      .catch(() => {
        // 静默失败:用户可手动选或留空走默认
      })
      .finally(() => {
        if (!cancelled) setLoadingAvatars(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, subtitle]);

  useEffect(() => {
    return () => {
      if (cleanupSseRef.current) cleanupSseRef.current();
      if (pcRef.current) pcRef.current.close();
    };
  }, []);

  const connectionStatus = useMemo(
    () => (isConnecting ? "connecting" : sessionToConnection(sessionState)),
    [isConnecting, sessionState],
  );

  // pill 状态机:进行中会话(含连接中)优先按会话状态,无会话时按引擎探活三态
  const pillMeta = useMemo(
    () =>
      isConnecting || sessionId !== null
        ? CONNECTION_META[connectionStatus]
        : engineToPillMeta(engineStatus),
    [isConnecting, sessionId, connectionStatus, engineStatus],
  );

  const startSession = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    setMessages([]);
    setSubtitle("");

    try {
      const session = await otCreateSession({
        avatar_id: selectedAvatar || undefined,
        model: selectedModel || undefined,
        tts_voice: ttsVoice.trim() || undefined,
        llm_system_prompt: systemPrompt.trim() || undefined,
        agent_enabled: agentEnabled,
        memory_enabled: memoryEnabled,
        knowledge_enabled: knowledgeEnabled,
      });

      setSessionId(session.session_id);
      webrtcStartedRef.current = false;
      const startWebRTCOnce = (sessionId: string) => {
        if (webrtcStartedRef.current || !videoRef.current) return;
        webrtcStartedRef.current = true;
        otStartWebRTC(sessionId, videoRef.current)
          .then(({ pc }) => {
            pcRef.current = pc;
            // answer 后的 ICE 连通失败不会 reject,监听状态把失败 surfaced 给用户
            pc.oniceconnectionstatechange = () => {
              if (pc.iceConnectionState === "failed") {
                setError("WebRTC 媒体连接失败(ICE),请检查网络后重试");
              }
            };
          })
          .catch((err) => {
            webrtcStartedRef.current = false;
            console.warn("WebRTC failed:", err);
            setError(`WebRTC 连接失败: ${err instanceof Error ? err.message : String(err)}`);
          });
      };

      const cleanup = otConnectSse(session.session_id, {
        onSpeechStarted: () => {
          setIsSpeaking(true);
          setSubtitle("");
        },
        onSubtitle: (text, isFinal) => {
          setSubtitle(text);
          if (isFinal && text) {
            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1];
              if (lastMsg && lastMsg.role === "assistant" && !lastMsg.isFinal) {
                return [...prev.slice(0, -1), { ...lastMsg, text, isFinal: true }];
              }
              return [
                ...prev,
                { id: genId(), role: "assistant", text, isFinal: true, timestamp: new Date() },
              ];
            });
          }
        },
        onSpeechEnded: (text) => {
          setIsSpeaking(false);
          setSubtitle("");
          if (text) {
            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1];
              if (lastMsg && lastMsg.role === "assistant") {
                return [...prev.slice(0, -1), { ...lastMsg, text, isFinal: true }];
              }
              return [
                ...prev,
                { id: genId(), role: "assistant", text, isFinal: true, timestamp: new Date() },
              ];
            });
          }
        },
        onStateChanged: (state) => {
          setSessionState(state);
          if (state === "ready") startWebRTCOnce(session.session_id);
        },
        onError: (code, message) => {
          setError(`${code}: ${message}`);
          setIsSpeaking(false);
        },
        onDisconnect: () => {
          // SSE 通道断开:会话状态置为错误,pill 反映并 toast 提示
          setSessionState("error");
          setIsSpeaking(false);
          setError("连接已断开");
          toast.error("连接已断开");
        },
      });

      cleanupSseRef.current = cleanup;

      const started = await otStartSession(session.session_id);
      // quicktalk/musetalk start 同步返回 ready,SSE 的 ready 事件可能已错过 →
      // 主动补状态(否则状态 pill 永远卡在「未连接」)与 WebRTC 启动
      if (started?.status === "ready") {
        setSessionState("ready");
        startWebRTCOnce(session.session_id);
      }
      setIsConnecting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接失败");
      setIsConnecting(false);
    }
  }, [selectedAvatar, selectedModel, ttsVoice, systemPrompt, agentEnabled, memoryEnabled, knowledgeEnabled, toast]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !sessionId || isSpeaking) return;
    const text = input.trim();
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: genId(), role: "user", text, isFinal: true, timestamp: new Date() },
    ]);
    try {
      await otSpeak(sessionId, { text });
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
    }
  }, [input, sessionId, isSpeaking]);

  const handleInterrupt = useCallback(async () => {
    if (sessionId) {
      await otInterrupt(sessionId);
      setIsSpeaking(false);
      setSubtitle("");
    }
  }, [sessionId]);

  /** 释放麦克风资源(录音中止/会话结束/组件卸载共用)。 */
  const releaseMic = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (mr) {
      // 丢弃式停止:先摘掉回调,避免 stop 触发 onstop 上传已放弃的录音
      mr.onstop = null;
      mr.ondataavailable = null;
      if (mr.state !== "inactive") {
        try {
          mr.stop();
        } catch {
          /* 已停止 */
        }
      }
    }
    mediaRecorderRef.current = null;
    if (micStreamRef.current) {
      for (const t of micStreamRef.current.getTracks()) t.stop();
      micStreamRef.current = null;
    }
    audioChunksRef.current = [];
    setIsRecording(false);
  }, []);

  /** 语音输入:点一下开始录音,再点一下停止 → 上传 STT → 识别文本作为用户消息进入 speak 流水线。 */
  const handleMicToggle = useCallback(async () => {
    if (!sessionId || isSpeaking || isTranscribing) return;

    // —— 停止并上传 ——
    if (isRecording) {
      const mr = mediaRecorderRef.current;
      if (!mr) {
        releaseMic();
        return;
      }
      setIsRecording(false);
      setIsTranscribing(true);
      mr.onstop = () => {
        void (async () => {
          const mime = mr.mimeType || "audio/webm";
          const blob = new Blob(audioChunksRef.current, { type: mime });
          releaseMic();
          try {
            if (blob.size === 0) throw new Error("没有录到声音,请重试");
            const ext = mime.includes("mp4") ? "mp4" : "webm";
            const r = await otSpeakAudio(sessionId, blob, `speech.${ext}`);
            const text = (r.text || "").trim();
            if (text) {
              setMessages((prev) => [
                ...prev,
                { id: genId(), role: "user", text, isFinal: true, timestamp: new Date() },
              ]);
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : "语音识别失败");
          } finally {
            setIsTranscribing(false);
          }
        })();
      };
      mr.stop();
      return;
    }

    // —— 开始录音 ——
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("当前浏览器不支持麦克风录音");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickAudioMime();
      const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      micStreamRef.current = stream;
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mr.start();
      setIsRecording(true);
    } catch {
      releaseMic();
      setError("无法访问麦克风,请检查浏览器授权");
    }
  }, [sessionId, isSpeaking, isRecording, isTranscribing, releaseMic]);

  // 卸载兜底:释放麦克风
  useEffect(() => releaseMic, [releaseMic]);

  const handleEnd = useCallback(() => {
    releaseMic();
    setIsTranscribing(false);
    if (cleanupSseRef.current) cleanupSseRef.current();
    if (pcRef.current) pcRef.current.close();
    cleanupSseRef.current = null;
    pcRef.current = null;
    webrtcStartedRef.current = false;
    setSessionId(null);
    setSessionState("created");
    setIsSpeaking(false);
    setSubtitle("");
    setError(null);
  }, [releaseMic]);

  const hasSession = sessionId !== null;
  const selectedAvatarInfo = avatars.find((a) => a.id === selectedAvatar);
  // 引擎探活:已启用但不可达 → 空态显示离线文案而非引导语
  const engineOffline = !!engineStatus && engineStatus.enabled && !engineStatus.reachable;

  return (
    <div className="at-view">
      {/* ── 左:SceneStage 舞台(近黑底,数字人画面是主角) ── */}
      <div className="at-stage">
        <video
          ref={videoRef}
          className="at-video"
          autoPlay
          playsInline
          muted={false}
        />

        {!hasSession && (
          <div className="at-placeholder">
            <div className="at-placeholder-icon">
              <Icon name="user" size={48} strokeWidth={1.5} />
            </div>
            <p className="at-placeholder-title">数字人实时对话</p>
            <p className="at-placeholder-desc">
              {engineOffline
                ? "引擎离线,请稍后再试"
                : selectedAvatarInfo
                  ? `已选: ${selectedAvatarInfo.name || selectedAvatarInfo.id}`
                  : (
                    <>
                      <span className="at-placeholder-hint-desktop">
                        从右侧选择数字人形象开始对话
                      </span>
                      <span className="at-placeholder-hint-mobile">
                        从下方选择数字人形象开始对话
                      </span>
                    </>
                  )}
            </p>
          </div>
        )}

        {/* 连接状态 pill(右上,Badge 承载):会话进行中按会话状态,否则按引擎探活 */}
        <Badge
          tone={pillMeta.tone}
          dotPulse={pillMeta.pulse}
          title={pillMeta.label}
          className="at-status-badge"
        >
          {pillMeta.label}
        </Badge>

        {/* 说话指示器(左上) */}
        {hasSession && isSpeaking && (
          <Badge
            tone="ok"
            dot={false}
            className="at-speaking-badge"
          >
            <span className="at-speaking-wave" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>正在说话</span>
          </Badge>
        )}

        {/* 字幕条(底部) */}
        {subtitle && hasSession && (
          <div className="at-subtitle-bar">
            <p className="at-subtitle-text">{subtitle}</p>
          </div>
        )}

        {/* 错误条(底部居中) */}
        {error && (
          <div className="at-error-bar">
            <Icon name="error" size={14} />
            <span>{error}</span>
            <button className="at-error-dismiss" onClick={() => setError(null)} aria-label="关闭">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
      </div>

      {/* ── 右:控制面板 ── */}
      <div className="at-panel">
        <div className="at-panel-header">
          <div className="at-panel-title-wrap">
            <h2 className="at-panel-title">数字人</h2>
            <span className="at-panel-subtitle">
              {hasSession ? "对话进行中" : "配置并开始"}
            </span>
          </div>
        </div>

        <div className="at-panel-body">
          {!hasSession ? (
            <SetupPanel
              avatars={avatars}
              models={models}
              loadingAvatars={loadingAvatars}
              loadingModels={loadingModels}
              modelsUnreachable={modelsUnreachable}
              selectedAvatar={selectedAvatar}
              selectedModel={selectedModel}
              onSelectAvatar={setSelectedAvatar}
              onSelectModel={setSelectedModel}
              ttsVoice={ttsVoice}
              onTtsVoiceChange={setTtsVoice}
              systemPrompt={systemPrompt}
              onSystemPromptChange={setSystemPrompt}
              agentEnabled={agentEnabled}
              onAgentEnabledChange={setAgentEnabled}
              memoryEnabled={memoryEnabled}
              onMemoryEnabledChange={setMemoryEnabled}
              knowledgeEnabled={knowledgeEnabled}
              onKnowledgeEnabledChange={setKnowledgeEnabled}
              onStart={startSession}
              isConnecting={isConnecting}
            />
          ) : (
            <ConversationPanel
              messages={messages}
              subtitle={subtitle}
              isSpeaking={isSpeaking}
              input={input}
              onInputChange={setInput}
              onSend={handleSend}
              onInterrupt={handleInterrupt}
              onEnd={handleEnd}
              isRecording={isRecording}
              isTranscribing={isTranscribing}
              onMicToggle={handleMicToggle}
              messagesEndRef={messagesEndRef}
            />
          )}
        </div>
      </div>

    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// SetupPanel:会话配置(Avatar 卡片网格 + Model 胶囊 + 开始按钮)
// ────────────────────────────────────────────────────────────────

interface SetupPanelProps {
  avatars: AvatarSummary[];
  models: ModelInfo[];
  loadingAvatars: boolean;
  loadingModels: boolean;
  /** 模型接口请求失败(引擎不可达),区别于「引擎在线但无可用模型」。 */
  modelsUnreachable: boolean;
  selectedAvatar: string;
  selectedModel: string;
  onSelectAvatar: (id: string) => void;
  onSelectModel: (id: string) => void;
  ttsVoice: string;
  onTtsVoiceChange: (v: string) => void;
  systemPrompt: string;
  onSystemPromptChange: (v: string) => void;
  agentEnabled: boolean;
  onAgentEnabledChange: (v: boolean) => void;
  memoryEnabled: boolean;
  onMemoryEnabledChange: (v: boolean) => void;
  knowledgeEnabled: boolean;
  onKnowledgeEnabledChange: (v: boolean) => void;
  onStart: () => void;
  isConnecting: boolean;
}

function SetupPanel({
  avatars,
  models,
  loadingAvatars,
  loadingModels,
  modelsUnreachable,
  selectedAvatar,
  selectedModel,
  onSelectAvatar,
  onSelectModel,
  ttsVoice,
  onTtsVoiceChange,
  systemPrompt,
  onSystemPromptChange,
  agentEnabled,
  onAgentEnabledChange,
  memoryEnabled,
  onMemoryEnabledChange,
  knowledgeEnabled,
  onKnowledgeEnabledChange,
  onStart,
  isConnecting,
}: SetupPanelProps) {
  // 不可用(未配置)模型默认折叠,避免「没配全」的误导观感
  const [showUnavailableModels, setShowUnavailableModels] = useState(false);
  return (
    <div className="at-setup">
      {/* Avatar 卡片网格 */}
      <section className="at-setup-section">
        <div className="at-section-head">
          <h3 className="at-section-title">形象</h3>
          <span className="at-section-count">
            {loadingAvatars ? "加载中" : `${avatars.length} 个可用`}
          </span>
        </div>
        <div className="at-avatar-grid">
          {loadingAvatars
            ? Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="at-avatar-card at-avatar-card-skeleton" />
              ))
            : avatars.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`at-avatar-card${
                    a.id === selectedAvatar ? " is-selected" : ""
                  }`}
                  onClick={() => onSelectAvatar(a.id)}
                >
                  <div className="at-avatar-preview">
                    <img
                      src={avatarPreviewUrl(a.id)}
                      alt={a.name || a.id}
                      loading="lazy"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.opacity = "0";
                      }}
                    />
                  </div>
                  <div className="at-avatar-info">
                    <span className="at-avatar-name">{a.name || a.id}</span>
                    {a.is_custom && <span className="at-avatar-tag">自定义</span>}
                  </div>
                </button>
              ))}
        </div>
      </section>

      {/* Model 胶囊选择器 */}
      <section className="at-setup-section">
        <div className="at-section-head">
          <h3 className="at-section-title">模型</h3>
          <span className="at-section-count">
            {loadingModels
              ? "加载中"
              : modelsUnreachable
                ? "不可用"
                : `${models.filter((m) => m.status === "available").length} 个可用`}
          </span>
        </div>
        <div className="at-model-chips">
          {loadingModels
            ? Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="at-model-chip at-model-chip-skeleton" />
              ))
            : models
                .filter((m) => m.status === "available")
                .map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`at-model-chip${m.id === selectedModel ? " is-selected" : ""}`}
                    onClick={() => onSelectModel(m.id)}
                    title={m.reason || undefined}
                  >
                    <span className="at-model-chip-name">{m.id}</span>
                    <span className="at-model-chip-backend">{m.backend}</span>
                    <span className="at-model-chip-dot is-on" />
                  </button>
                ))}
        </div>
        {!loadingModels && modelsUnreachable && (
          <p className="at-models-empty">引擎不可达,模型列表不可用</p>
        )}
        {!loadingModels &&
          !modelsUnreachable &&
          !models.some((m) => m.status === "available") && (
            <p className="at-models-empty">请在 opentalking 服务端配置模型</p>
          )}
        {!loadingModels && models.some((m) => m.status !== "available") && (
          <>
            <button
              type="button"
              className="at-models-toggle"
              onClick={() => setShowUnavailableModels((v) => !v)}
            >
              {showUnavailableModels ? "收起" : "未配置模型"}(
              {models.filter((m) => m.status !== "available").length})
            </button>
            {showUnavailableModels && (
              <div className="at-model-chips">
                {models
                  .filter((m) => m.status !== "available")
                  .map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="at-model-chip is-unavailable"
                      disabled
                      title={m.reason || undefined}
                    >
                      <span className="at-model-chip-name">{m.id}</span>
                      <span className="at-model-chip-backend">{m.backend}</span>
                      <span className="at-model-chip-dot is-off" />
                    </button>
                  ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* 对话配置(可选,接入 CreateSession 契约) */}
      <section className="at-setup-section">
        <div className="at-section-head">
          <h3 className="at-section-title">对话配置</h3>
          <span className="at-section-count">可选</span>
        </div>
        <Field label="TTS 音色">
          <Input
            type="text"
            value={ttsVoice}
            onChange={(e) => onTtsVoiceChange(e.target.value)}
            placeholder="默认音色"
          />
        </Field>
        <Field label="系统提示词">
          <Textarea
            rows={3}
            value={systemPrompt}
            onChange={(e) => onSystemPromptChange(e.target.value)}
            placeholder="可选:自定义数字人的人格与口吻"
          />
        </Field>
        <div className="at-switch-row">
          <span className="at-switch-row-label">智能体(Agent)</span>
          <Switch
            checked={agentEnabled}
            onChange={onAgentEnabledChange}
            ariaLabel="智能体(Agent)"
          />
        </div>
        <div className="at-switch-row">
          <span className="at-switch-row-label">记忆</span>
          <Switch
            checked={memoryEnabled}
            onChange={onMemoryEnabledChange}
            ariaLabel="记忆"
          />
        </div>
        <div className="at-switch-row">
          <span className="at-switch-row-label">知识库</span>
          <Switch
            checked={knowledgeEnabled}
            onChange={onKnowledgeEnabledChange}
            ariaLabel="知识库"
          />
        </div>
      </section>

      <div className="at-setup-footer">
        <Button
          variant="primary"
          className="at-start-btn"
          onClick={onStart}
          disabled={isConnecting || loadingModels || loadingAvatars || !selectedAvatar || !selectedModel}
          loading={isConnecting}
          icon={<Icon name="playing" size={16} />}
        >
          {isConnecting ? "连接中..." : "开始对话"}
        </Button>
      </div>

    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// ConversationPanel:对话进行中(消息流 + 输入区)
// ────────────────────────────────────────────────────────────────

interface ConversationPanelProps {
  messages: ChatMessage[];
  subtitle: string;
  isSpeaking: boolean;
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onInterrupt: () => void;
  onEnd: () => void;
  /** 语音输入:录音中 / 识别中 / 点击切换录音 */
  isRecording: boolean;
  isTranscribing: boolean;
  onMicToggle: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

function ConversationPanel({
  messages,
  subtitle,
  isSpeaking,
  input,
  onInputChange,
  onSend,
  onInterrupt,
  onEnd,
  isRecording,
  isTranscribing,
  onMicToggle,
  messagesEndRef,
}: ConversationPanelProps) {
  return (
    <div className="at-conv">
      <div className="at-messages">
        {messages.length === 0 && (
          <div className="at-conv-empty">
            <p className="at-conv-empty-text">开始和数字人对话吧</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`at-msg at-msg-${msg.role}${!msg.isFinal ? " is-streaming" : ""}`}
          >
            <div className="at-msg-avatar">
              {msg.role === "user" ? (
                <Icon name="user" size={12} />
              ) : (
                <Icon name="sparkles" size={12} />
              )}
            </div>
            <div className="at-msg-bubble">{msg.text}</div>
          </div>
        ))}

        {subtitle && isSpeaking && (
          <div className="at-msg at-msg-assistant is-streaming">
            <div className="at-msg-avatar">
              <Icon name="sparkles" size={12} />
            </div>
            <div className="at-msg-bubble">{subtitle}</div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="at-composer">
        <Button
          variant="danger"
          className="at-composer-btn"
          onClick={onEnd}
          title="结束对话"
          aria-label="结束对话"
          icon={<Icon name="phone-off" size={16} />}
        />
        <Input
          type="text"
          className="at-composer-input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && onSend()}
          placeholder={
            isSpeaking
              ? "数字人正在说话..."
              : isRecording
                ? "录音中,再点麦克风结束..."
                : isTranscribing
                  ? "识别中..."
                  : "输入消息或点麦克风说话..."
          }
          disabled={isSpeaking || isRecording || isTranscribing}
        />
        <Button
          variant={isRecording ? "danger" : "ghost"}
          className={`at-composer-btn${isRecording ? " at-mic-recording" : ""}`}
          onClick={onMicToggle}
          disabled={isSpeaking || isTranscribing}
          title={isRecording ? "结束录音并识别" : isTranscribing ? "识别中..." : "语音输入"}
          aria-label={isRecording ? "结束录音" : "语音输入"}
          icon={
            isTranscribing ? (
              <span className="loading-spinner">
                <Icon name="loading" size={14} />
              </span>
            ) : (
              <Icon name="mic" size={16} />
            )
          }
        />
        {isSpeaking ? (
          <Button
            variant="danger"
            className="at-composer-btn"
            onClick={onInterrupt}
            title="中断"
            aria-label="中断"
            icon={<Icon name="square" size={14} />}
          />
        ) : (
          <Button
            variant="primary"
            className="at-composer-btn"
            onClick={onSend}
            disabled={!input.trim()}
            title="发送"
            aria-label="发送"
            icon={<Icon name="send" size={16} />}
          />
        )}
      </div>

    </div>
  );
}

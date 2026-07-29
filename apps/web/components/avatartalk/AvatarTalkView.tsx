"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { getToken } from "@/lib/api";
import {
  otGetModels,
  otGetAvatars,
  otCreateSession,
  otStartSession,
  otSpeak,
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

// ── 连接状态 → 展示元数据(颜色/标签/图标),对齐 OpenTalking TopBar 配色但用 ToIV tokens ──
const CONNECTION_META: Record<
  ConnectionStatus,
  { label: string; dotClass: string; pillClass: string }
> = {
  idle: {
    label: "未连接",
    dotClass: "at-dot-idle",
    pillClass: "at-pill-idle",
  },
  connecting: {
    label: "连接中",
    dotClass: "at-dot-connecting",
    pillClass: "at-pill-connecting",
  },
  queued: {
    label: "排队中",
    dotClass: "at-dot-queued",
    pillClass: "at-pill-queued",
  },
  live: {
    label: "已连接",
    dotClass: "at-dot-live",
    pillClass: "at-pill-live",
  },
  expiring: {
    label: "即将到期",
    dotClass: "at-dot-expiring",
    pillClass: "at-pill-expiring",
  },
  error: {
    label: "连接错误",
    dotClass: "at-dot-error",
    pillClass: "at-pill-error",
  },
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

export function AvatarTalkView() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>("created");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [avatars, setAvatars] = useState<AvatarSummary[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [loadingAvatars, setLoadingAvatars] = useState(true);
  const [selectedAvatar, setSelectedAvatar] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("mock");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const cleanupSseRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
        if (cancelled) return;
        setModels([{ id: "mock", backend: "mock", status: "available", reason: null }]);
        setSelectedModel("mock");
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

  const startSession = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    setMessages([]);
    setSubtitle("");

    try {
      const session = await otCreateSession({
        avatar_id: selectedAvatar || undefined,
        model: selectedModel || "mock",
      });

      setSessionId(session.session_id);

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
                { id: crypto.randomUUID(), role: "assistant", text, isFinal: true, timestamp: new Date() },
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
                { id: crypto.randomUUID(), role: "assistant", text, isFinal: true, timestamp: new Date() },
              ];
            });
          }
        },
        onStateChanged: (state) => {
          setSessionState(state);
          if (state === "ready" && videoRef.current) {
            otStartWebRTC(session.session_id, videoRef.current)
              .then(({ pc }) => {
                pcRef.current = pc;
              })
              .catch((err) => console.warn("WebRTC failed:", err));
          }
        },
        onError: (code, message) => {
          setError(`${code}: ${message}`);
          setIsSpeaking(false);
        },
      });

      cleanupSseRef.current = cleanup;

      await otStartSession(session.session_id);
      setIsConnecting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接失败");
      setIsConnecting(false);
    }
  }, [selectedAvatar, selectedModel]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !sessionId || isSpeaking) return;
    const text = input.trim();
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text, isFinal: true, timestamp: new Date() },
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

  const handleEnd = useCallback(() => {
    if (cleanupSseRef.current) cleanupSseRef.current();
    if (pcRef.current) pcRef.current.close();
    cleanupSseRef.current = null;
    pcRef.current = null;
    setSessionId(null);
    setSessionState("created");
    setIsSpeaking(false);
    setSubtitle("");
    setError(null);
  }, []);

  const hasSession = sessionId !== null;
  const connMeta = CONNECTION_META[connectionStatus];
  const selectedAvatarInfo = avatars.find((a) => a.id === selectedAvatar);

  return (
    <div className="at-view studio-dark-zone">
      {/* ── 左:SceneStage 舞台(工作室深色区) ── */}
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
              {selectedAvatarInfo
                ? `已选: ${selectedAvatarInfo.name || selectedAvatarInfo.id}`
                : "从右侧选择数字人形象开始对话"}
            </p>
          </div>
        )}

        {/* 连接状态 pill(玻璃拟态,右上) */}
        <div className={`at-status-pill ${connMeta.pillClass}`} title={connMeta.label}>
          <span className={`at-status-dot ${connMeta.dotClass}`} />
          <span>{connMeta.label}</span>
        </div>

        {/* 说话指示器(玻璃拟态,左上) */}
        {hasSession && isSpeaking && (
          <div className="at-speaking-pill">
            <span className="at-speaking-wave">
              <span />
              <span />
              <span />
            </span>
            <span>正在说话</span>
          </div>
        )}

        {/* 字幕条(玻璃拟态,底部) */}
        {subtitle && hasSession && (
          <div className="at-subtitle-bar">
            <p className="at-subtitle-text">{subtitle}</p>
          </div>
        )}

        {/* 错误条(玻璃拟态,底部居中) */}
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

      {/* ── 右:控制面板(中性灰 surface) ── */}
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
              selectedAvatar={selectedAvatar}
              selectedModel={selectedModel}
              onSelectAvatar={setSelectedAvatar}
              onSelectModel={setSelectedModel}
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
              messagesEndRef={messagesEndRef}
            />
          )}
        </div>
      </div>

      <style jsx>{`
        .at-view {
          display: grid;
          grid-template-columns: 1fr 400px;
          height: 100%;
          background: var(--studio-bg, #0a0a0a);
          overflow: hidden;
        }

        /* ── SceneStage 舞台 ── */
        .at-stage {
          position: relative;
          background: var(--studio-bg, #0a0a0a);
          overflow: hidden;
          min-width: 0;
        }
        .at-video {
          width: 100%;
          height: 100%;
          object-fit: contain;
          background: transparent;
        }

        /* 占位空态 */
        .at-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-3);
          color: var(--studio-text-dim, #808080);
          pointer-events: none;
        }
        .at-placeholder-icon {
          width: 96px;
          height: 96px;
          border-radius: var(--radius-full);
          background: var(--studio-surface, #1a1a1a);
          border: 1px solid var(--studio-border, #2a2a2a);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--studio-text-dim, #808080);
          margin-bottom: var(--space-2);
        }
        .at-placeholder-title {
          font-family: var(--font-display);
          font-size: var(--text-xl);
          font-weight: 500;
          color: var(--studio-text, #e0e0e0);
          letter-spacing: -0.02em;
        }
        .at-placeholder-desc {
          font-size: var(--text-sm);
          color: var(--studio-text-dim, #808080);
          max-width: 320px;
          text-align: center;
          line-height: var(--leading-md);
        }

        /* ── 玻璃拟态浮层(延续 DynamicIsland 设计语言) ── */
        .at-status-pill,
        .at-speaking-pill,
        .at-subtitle-bar,
        .at-error-bar {
          background: rgba(255, 255, 255, 0.82);
          backdrop-filter: blur(40px) saturate(180%);
          -webkit-backdrop-filter: blur(40px) saturate(180%);
          border: 1px solid rgba(147, 197, 253, 0.18);
          box-shadow:
            0 4px 20px rgba(0, 0, 0, 0.08),
            0 0 0 0.5px rgba(0, 0, 0, 0.04) inset,
            0 1px 0 rgba(255, 255, 255, 0.9) inset;
        }

        /* 连接状态 pill(右上) */
        .at-status-pill {
          position: absolute;
          top: var(--space-4);
          right: var(--space-4);
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-full);
          font-size: var(--text-xs);
          font-weight: 600;
          color: var(--color-text-primary, #1a1a1a);
          z-index: 10;
        }
        .at-status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .at-dot-idle { background: var(--color-text-tertiary, #999); }
        .at-dot-connecting {
          background: var(--color-warning, #d97706);
          animation: at-pulse 1.2s ease-in-out infinite;
        }
        .at-dot-queued {
          background: var(--color-warning, #d97706);
          animation: at-pulse 1.5s ease-in-out infinite;
        }
        .at-dot-live {
          background: var(--color-success, #16a34a);
          box-shadow: 0 0 8px rgba(22, 163, 74, 0.5);
        }
        .at-dot-expiring { background: var(--color-warning, #d97706); }
        .at-dot-error { background: var(--color-error, #dc2626); }

        .at-pill-idle { color: var(--color-text-secondary, #666); }
        .at-pill-connecting,
        .at-pill-queued,
        .at-pill-expiring { color: var(--color-warning, #d97706); }
        .at-pill-live { color: var(--color-success, #16a34a); }
        .at-pill-error { color: var(--color-error, #dc2626); }

        @keyframes at-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }

        /* 说话指示器(左上) */
        .at-speaking-pill {
          position: absolute;
          top: var(--space-4);
          left: var(--space-4);
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-full);
          font-size: var(--text-xs);
          font-weight: 600;
          color: var(--color-success, #16a34a);
          z-index: 10;
          animation: at-fade-in var(--duration-base) var(--ease-standard);
        }
        .at-speaking-wave {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          height: 12px;
        }
        .at-speaking-wave span {
          width: 2px;
          height: 100%;
          background: var(--color-success, #16a34a);
          border-radius: 1px;
          animation: at-wave 1s ease-in-out infinite;
        }
        .at-speaking-wave span:nth-child(2) { animation-delay: 0.15s; }
        .at-speaking-wave span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes at-wave {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1); }
        }

        /* 字幕条(底部) */
        .at-subtitle-bar {
          position: absolute;
          left: var(--space-4);
          right: var(--space-4);
          bottom: var(--space-5);
          padding: var(--space-3) var(--space-4);
          border-radius: var(--radius-xl);
          z-index: 10;
          animation: at-slide-up var(--duration-base) var(--ease-standard);
        }
        .at-subtitle-text {
          margin: 0;
          font-size: var(--text-md);
          font-weight: 500;
          line-height: var(--leading-md);
          color: var(--color-text-primary, #1a1a1a);
          text-align: center;
        }

        /* 错误条(底部居中) */
        .at-error-bar {
          position: absolute;
          left: 50%;
          bottom: var(--space-5);
          transform: translateX(-50%);
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          max-width: 90%;
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-full);
          font-size: var(--text-xs);
          font-weight: 500;
          color: var(--color-error, #dc2626);
          z-index: 11;
          animation: at-slide-up var(--duration-base) var(--ease-standard);
        }
        .at-error-dismiss {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          border-radius: var(--radius-full);
          color: inherit;
          opacity: 0.6;
          cursor: pointer;
          transition: opacity var(--duration-fast) var(--ease-standard);
        }
        .at-error-dismiss:hover { opacity: 1; }

        @keyframes at-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes at-slide-up {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .at-error-bar { animation: at-slide-up-center var(--duration-base) var(--ease-standard); }
        @keyframes at-slide-up-center {
          from { opacity: 0; transform: translateX(-50%) translateY(8px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }

        /* ── 右侧控制面板 ── */
        .at-panel {
          display: flex;
          flex-direction: column;
          background: var(--color-bg-surface, #fff);
          border-left: 1px solid var(--color-border-subtle, #f0f0f0);
          min-width: 0;
          overflow: hidden;
        }
        .at-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--space-4) var(--space-4) var(--space-3);
          border-bottom: 1px solid var(--color-border-subtle, #f0f0f0);
          flex-shrink: 0;
        }
        .at-panel-title-wrap {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .at-panel-title {
          margin: 0;
          font-family: var(--font-display);
          font-size: var(--text-lg);
          font-weight: 500;
          color: var(--color-text-primary, #1a1a1a);
          line-height: 1.2;
          letter-spacing: -0.02em;
        }
        .at-panel-subtitle {
          font-size: var(--text-xs);
          color: var(--color-text-tertiary, #999);
        }
        .at-panel-body {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
        }

        /* ── 响应式:窄屏堆叠 ── */
        @media (max-width: 900px) {
          .at-view {
            grid-template-columns: 1fr;
            grid-template-rows: 1fr 320px;
          }
          .at-panel {
            border-left: none;
            border-top: 1px solid var(--color-border-subtle, #f0f0f0);
          }
        }
      `}</style>
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
  selectedAvatar: string;
  selectedModel: string;
  onSelectAvatar: (id: string) => void;
  onSelectModel: (id: string) => void;
  onStart: () => void;
  isConnecting: boolean;
}

function SetupPanel({
  avatars,
  models,
  loadingAvatars,
  loadingModels,
  selectedAvatar,
  selectedModel,
  onSelectAvatar,
  onSelectModel,
  onStart,
  isConnecting,
}: SetupPanelProps) {
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
            {loadingModels ? "加载中" : `${models.length} 个`}
          </span>
        </div>
        <div className="at-model-chips">
          {loadingModels
            ? Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="at-model-chip at-model-chip-skeleton" />
              ))
            : models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`at-model-chip${m.id === selectedModel ? " is-selected" : ""}${
                    m.status !== "available" ? " is-unavailable" : ""
                  }`}
                  onClick={() => m.status === "available" && onSelectModel(m.id)}
                  disabled={m.status !== "available"}
                  title={m.reason || undefined}
                >
                  <span className="at-model-chip-name">{m.id}</span>
                  <span className="at-model-chip-backend">{m.backend}</span>
                  <span
                    className={`at-model-chip-dot${
                      m.status === "available" ? " is-on" : " is-off"
                    }`}
                  />
                </button>
              ))}
        </div>
      </section>

      <div className="at-setup-footer">
        <button
          className="at-start-btn"
          onClick={onStart}
          disabled={isConnecting || loadingModels || loadingAvatars || !selectedAvatar || !selectedModel}
        >
          {isConnecting ? (
            <>
              <Icon name="loading" size={16} className="icon-loading-spin" />
              连接中...
            </>
          ) : (
            <>
              <Icon name="playing" size={16} />
              开始对话
            </>
          )}
        </button>
      </div>

      <style jsx>{`
        .at-setup {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          padding: var(--space-4);
          overflow-y: auto;
          flex: 1;
          min-height: 0;
        }

        .at-setup-section {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .at-section-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
        }
        .at-section-title {
          margin: 0;
          font-size: var(--text-sm);
          font-weight: 600;
          color: var(--color-text-primary, #1a1a1a);
          letter-spacing: -0.01em;
        }
        .at-section-count {
          font-size: var(--text-xs);
          color: var(--color-text-tertiary, #999);
        }

        /* Avatar 卡片网格 */
        .at-avatar-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: var(--space-2);
        }
        .at-avatar-card {
          display: flex;
          flex-direction: column;
          background: var(--color-bg-surface, #fff);
          border: 1px solid var(--color-border-subtle, #f0f0f0);
          border-radius: var(--radius-lg, 8px);
          overflow: hidden;
          cursor: pointer;
          padding: 0;
          text-align: left;
          transition:
            border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard);
        }
        .at-avatar-card:hover {
          border-color: var(--color-border, #eaeaea);
          box-shadow: var(--shadow-sm);
          transform: translateY(-1px);
        }
        .at-avatar-card.is-selected {
          border-color: var(--color-accent, #1a1a1a);
          border-width: 2px;
          box-shadow: var(--shadow-md);
        }
        .at-avatar-preview {
          aspect-ratio: 4 / 3;
          background: var(--color-bg-subtle, #f5f5f5);
          overflow: hidden;
        }
        .at-avatar-preview img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          transition: transform var(--duration-base) var(--ease-standard);
        }
        .at-avatar-card:hover .at-avatar-preview img {
          transform: scale(1.03);
        }
        .at-avatar-info {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-1);
          padding: var(--space-2) var(--space-2);
        }
        .at-avatar-name {
          font-size: var(--text-xs);
          font-weight: 500;
          color: var(--color-text-primary, #1a1a1a);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
          flex: 1;
        }
        .at-avatar-tag {
          flex-shrink: 0;
          padding: 1px var(--space-1);
          background: var(--color-accent-soft, rgba(26,26,26,0.06));
          border-radius: var(--radius-sm, 4px);
          font-size: 10px;
          font-weight: 500;
          color: var(--color-text-secondary, #666);
        }

        .at-avatar-card-skeleton {
          height: 120px;
          background: var(--color-bg-subtle, #f5f5f5);
          animation: at-shimmer 1.5s ease-in-out infinite;
        }
        @keyframes at-shimmer {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        /* Model 胶囊选择器 */
        .at-model-chips {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-2);
        }
        .at-model-chip {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) var(--space-2);
          background: var(--color-bg-subtle, #f5f5f5);
          border: 1px solid transparent;
          border-radius: var(--radius-full, 9999px);
          font-size: var(--text-xs);
          font-weight: 500;
          color: var(--color-text-secondary, #666);
          cursor: pointer;
          transition: all var(--duration-fast) var(--ease-standard);
        }
        .at-model-chip:hover {
          background: var(--color-bg-inset, #f0f0f0);
          color: var(--color-text-primary, #1a1a1a);
        }
        .at-model-chip.is-selected {
          background: var(--color-accent, #1a1a1a);
          color: var(--color-text-inverse, #fff);
        }
        .at-model-chip.is-unavailable {
          opacity: 0.55;
        }
        .at-model-chip-name {
          font-family: var(--font-mono);
          font-weight: 600;
        }
        .at-model-chip-backend {
          font-size: 10px;
          opacity: 0.7;
        }
        .at-model-chip.is-selected .at-model-chip-backend {
          opacity: 0.6;
        }
        .at-model-chip-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .at-model-chip-dot.is-on {
          background: var(--color-success, #16a34a);
        }
        .at-model-chip-dot.is-off {
          background: var(--color-text-tertiary, #999);
        }
        .at-model-chip-skeleton {
          width: 80px;
          height: 24px;
          border-radius: var(--radius-full);
          animation: at-shimmer 1.5s ease-in-out infinite;
        }

        /* 开始按钮 */
        .at-setup-footer {
          margin-top: auto;
          padding-top: var(--space-3);
          border-top: 1px solid var(--color-border-subtle, #f0f0f0);
        }
        .at-start-btn {
          width: 100%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          background: var(--color-accent, #1a1a1a);
          color: var(--color-text-inverse, #fff);
          border: none;
          border-radius: var(--radius-lg, 8px);
          font-size: var(--text-md);
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition:
            background var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .at-start-btn:hover:not(:disabled) {
          background: var(--color-accent-hover, #333);
          transform: translateY(-1px);
          box-shadow: var(--shadow-md);
        }
        .at-start-btn:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
      `}</style>
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
        <button
          className="at-composer-btn at-composer-end"
          onClick={onEnd}
          title="结束对话"
        >
          <Icon name="phone-off" size={16} />
        </button>
        <input
          type="text"
          className="at-composer-input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && onSend()}
          placeholder={isSpeaking ? "数字人正在说话..." : "输入消息..."}
          disabled={isSpeaking}
        />
        {isSpeaking ? (
          <button
            className="at-composer-btn at-composer-interrupt"
            onClick={onInterrupt}
            title="中断"
          >
            <Icon name="square" size={14} />
          </button>
        ) : (
          <button
            className="at-composer-btn at-composer-send"
            onClick={onSend}
            disabled={!input.trim()}
            title="发送"
          >
            <Icon name="send" size={16} />
          </button>
        )}
      </div>

      <style jsx>{`
        .at-conv {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }

        /* 消息流 */
        .at-messages {
          flex: 1;
          overflow-y: auto;
          padding: var(--space-4);
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .at-conv-empty {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .at-conv-empty-text {
          font-size: var(--text-sm);
          color: var(--color-text-tertiary, #999);
        }

        .at-msg {
          display: flex;
          gap: var(--space-2);
          align-items: flex-start;
          animation: at-msg-in var(--duration-base) var(--ease-standard);
        }
        @keyframes at-msg-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .at-msg-user {
          flex-direction: row-reverse;
        }
        .at-msg-avatar {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          background: var(--color-bg-subtle, #f5f5f5);
          color: var(--color-text-tertiary, #999);
        }
        .at-msg-assistant .at-msg-avatar {
          background: var(--color-accent, #1a1a1a);
          color: var(--color-text-inverse, #fff);
        }
        .at-msg-bubble {
          max-width: 75%;
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-lg, 8px);
          font-size: var(--text-sm);
          line-height: var(--leading-md);
          word-break: break-word;
        }
        .at-msg-user .at-msg-bubble {
          background: var(--color-accent, #1a1a1a);
          color: var(--color-text-inverse, #fff);
          border-bottom-right-radius: var(--radius-sm, 4px);
        }
        .at-msg-assistant .at-msg-bubble {
          background: var(--color-bg-subtle, #f5f5f5);
          color: var(--color-text-primary, #1a1a1a);
          border-bottom-left-radius: var(--radius-sm, 4px);
        }
        .at-msg.is-streaming .at-msg-bubble {
          opacity: 0.75;
        }

        /* 输入区 */
        .at-composer {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          border-top: 1px solid var(--color-border-subtle, #f0f0f0);
          flex-shrink: 0;
        }
        .at-composer-input {
          flex: 1;
          height: 36px;
          padding: 0 var(--space-3);
          background: var(--color-bg-subtle, #f5f5f5);
          border: 1px solid transparent;
          border-radius: var(--radius-full, 9999px);
          font-size: var(--text-sm);
          font-family: inherit;
          color: var(--color-text-primary, #1a1a1a);
          outline: none;
          transition:
            border-color var(--duration-fast) var(--ease-standard),
            background var(--duration-fast) var(--ease-standard);
        }
        .at-composer-input:focus {
          border-color: var(--color-accent, #1a1a1a);
          background: var(--color-bg-surface, #fff);
        }
        .at-composer-input:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .at-composer-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border-radius: var(--radius-full, 9999px);
          border: none;
          cursor: pointer;
          flex-shrink: 0;
          transition: all var(--duration-fast) var(--ease-standard);
        }
        .at-composer-send {
          background: var(--color-accent, #1a1a1a);
          color: var(--color-text-inverse, #fff);
        }
        .at-composer-send:hover:not(:disabled) {
          background: var(--color-accent-hover, #333);
          transform: scale(1.05);
        }
        .at-composer-send:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .at-composer-interrupt {
          background: var(--color-error-soft, rgba(220,38,38,0.08));
          color: var(--color-error, #dc2626);
        }
        .at-composer-interrupt:hover {
          background: var(--color-error, #dc2626);
          color: var(--color-text-inverse, #fff);
        }
        .at-composer-end {
          background: var(--color-bg-subtle, #f5f5f5);
          color: var(--color-text-tertiary, #999);
        }
        .at-composer-end:hover {
          background: var(--color-error-soft, rgba(220,38,38,0.08));
          color: var(--color-error, #dc2626);
        }
      `}</style>
    </div>
  );
}

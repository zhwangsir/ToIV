"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { usePoll } from "@/hooks/usePoll";
import { avatarAssetImageUrl, listAvatarAssets, type AvatarAsset } from "@/lib/api";
import {
  createLiveBanned,
  createLiveKB,
  deleteLiveBanned,
  deleteLiveKB,
  getLiveSessionStatus,
  ingestLive,
  listLiveBanned,
  listLiveEvents,
  listLiveKB,
  liveEventStatusMeta,
  parseTriggerWords,
  patchLiveKB,
  startLiveSession,
  stopLiveSession,
  type LiveBannedWord,
  type LiveEvent,
  type LiveKB,
  type LiveSessionStatus,
} from "@/lib/liveAssistant";

/**
 * 直播助手(数字人 M5):播报控制台 + 知识库 + 违禁词。
 *
 * 布局复用 at-body 双栏骨架:左栏控制台(会话控制 / 手动摄入 / 事件流),
 * 右栏管理区(知识库 CRUD + 违禁词标签)。状态全本地 useState + 轮询,
 * 事件流 4s 轮询(usePoll,页面隐藏自动暂停)。
 */
export function LiveAssistantPanel() {
  // ── 形象模板(开播必选:images[0] 句柄即 avatar_image/avatar_worker) ──
  const [templates, setTemplates] = useState<AvatarAsset[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  // ── 会话状态 ──
  const [session, setSession] = useState<LiveSessionStatus>({ active: false, session_id: null });
  const [sessionBusy, setSessionBusy] = useState(false);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  // 初始四路加载失败(2026-08-30 UX 批 C):列出失败的板块,不再静默吞掉
  const [initError, setInitError] = useState<string | null>(null);

  // ── 手动摄入(模拟弹幕) ──
  const [ingestText, setIngestText] = useState("");
  const [ingestAuthor, setIngestAuthor] = useState("");
  const [ingesting, setIngesting] = useState(false);

  // ── 事件流 ──
  const [events, setEvents] = useState<LiveEvent[]>([]);

  // ── 知识库 ──
  const [kbList, setKbList] = useState<LiveKB[]>([]);
  const [kbLoaded, setKbLoaded] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);
  const [kbConfirmDeleteId, setKbConfirmDeleteId] = useState<string | null>(null);
  // 新建表单
  const [kbWords, setKbWords] = useState("");
  const [kbReplyType, setKbReplyType] = useState<"text" | "video">("text");
  const [kbReplyText, setKbReplyText] = useState("");
  const [kbReplyUrl, setKbReplyUrl] = useState("");
  const [kbPriority, setKbPriority] = useState(100);
  const [kbSubmitting, setKbSubmitting] = useState(false);

  // ── 违禁词 ──
  const [banned, setBanned] = useState<LiveBannedWord[]>([]);
  const [bannedLoaded, setBannedLoaded] = useState(false);
  const [bannedInput, setBannedInput] = useState("");
  const [bannedBusy, setBannedBusy] = useState(false);
  // 删除确认门(2026-08-30 UX 批 C):单个违禁词删除先 Modal 确认,不再点了就删
  const [confirmDeleteBanned, setConfirmDeleteBanned] = useState<LiveBannedWord | null>(null);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  // 初始加载:形象模板 / 会话状态 / KB / 违禁词(各自失败互不影响,失败板块名透出 + 重试)
  const loadInitial = useCallback(() => {
    let cancelled = false;
    setInitError(null);
    /** 失败板块累计进 initError(「、」拼接),四路互不影响 */
    const markFailed = (label: string) => {
      if (!cancelled) setInitError((prev) => (prev ? `${prev}、${label}` : label));
    };
    listAvatarAssets()
      .then((list) => {
        if (cancelled) return;
        const arr = Array.isArray(list) ? list : [];
        setTemplates(arr);
        if (arr.length > 0) setSelectedTemplateId((prev) => prev || arr[0].id);
      })
      .catch(() => markFailed("形象模板"))
      .finally(() => !cancelled && setTemplatesLoaded(true));
    getLiveSessionStatus()
      .then((s) => !cancelled && setSession(s))
      .catch(() => markFailed("会话状态"));
    listLiveKB()
      .then((list) => !cancelled && setKbList(Array.isArray(list) ? list : []))
      .catch(() => markFailed("知识库"))
      .finally(() => !cancelled && setKbLoaded(true));
    listLiveBanned()
      .then((list) => !cancelled && setBanned(Array.isArray(list) ? list : []))
      .catch(() => markFailed("违禁词"))
      .finally(() => !cancelled && setBannedLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => loadInitial(), [loadInitial]);

  // 事件流轮询(4s;失败保持旧列表,不打扰)
  usePoll(
    async () => {
      const list = await listLiveEvents(50);
      setEvents(Array.isArray(list) ? list : []);
    },
    { intervalMs: 4_000, enabled: true },
  );

  // ── 会话控制 ──
  const handleSessionToggle = useCallback(async () => {
    if (sessionBusy) return;
    setConsoleError(null);
    setSessionBusy(true);
    try {
      if (session.active) {
        const s = await stopLiveSession();
        setSession(s);
      } else {
        const img = selectedTemplate?.images[0];
        if (!img) {
          setConsoleError("请先选择开播形象(形象模板)");
          return;
        }
        const s = await startLiveSession({ avatar_image: img.filename, avatar_worker: img.worker });
        setSession(s);
      }
    } catch (e) {
      setConsoleError(e instanceof Error ? e.message : "会话操作失败");
    } finally {
      setSessionBusy(false);
    }
  }, [session.active, sessionBusy, selectedTemplate]);

  // ── 手动摄入 ──
  const handleIngest = useCallback(async () => {
    const text = ingestText.trim();
    if (!text || ingesting) return;
    setConsoleError(null);
    setIngesting(true);
    try {
      const ev = await ingestLive({ text, author: ingestAuthor.trim() });
      // 轮询会兜底,这里先乐观置顶保证即时反馈
      setEvents((prev) => [ev, ...prev.filter((e) => e.id !== ev.id)]);
      setIngestText("");
    } catch (e) {
      setConsoleError(e instanceof Error ? e.message : "互动摄入失败");
    } finally {
      setIngesting(false);
    }
  }, [ingestText, ingestAuthor, ingesting]);

  // ── 知识库 ──
  const handleKbToggle = useCallback(
    async (kb: LiveKB, enabled: boolean) => {
      // 乐观更新,失败回滚
      setKbList((prev) => prev.map((k) => (k.id === kb.id ? { ...k, enabled } : k)));
      try {
        await patchLiveKB(kb.id, { enabled });
      } catch (e) {
        setKbList((prev) => prev.map((k) => (k.id === kb.id ? { ...k, enabled: kb.enabled } : k)));
        setKbError(e instanceof Error ? e.message : "知识库更新失败");
      }
    },
    [],
  );

  const handleKbDelete = useCallback(async (id: string) => {
    try {
      await deleteLiveKB(id);
      setKbList((prev) => prev.filter((k) => k.id !== id));
      setKbConfirmDeleteId(null);
    } catch (e) {
      setKbError(e instanceof Error ? e.message : "知识库删除失败");
    }
  }, []);

  const handleKbCreate = useCallback(async () => {
    const words = parseTriggerWords(kbWords);
    if (words.length === 0) {
      setKbError("请至少填写一个触发词(逗号分隔)");
      return;
    }
    if (kbReplyType === "text" && !kbReplyText.trim()) {
      setKbError("文本回复内容不能为空");
      return;
    }
    if (kbReplyType === "video" && !kbReplyUrl.trim()) {
      setKbError("视频回复需填写资产 URL");
      return;
    }
    setKbError(null);
    setKbSubmitting(true);
    try {
      const created = await createLiveKB({
        trigger_words: words,
        reply_type: kbReplyType,
        reply_text: kbReplyType === "text" ? kbReplyText.trim() : "",
        reply_asset_url: kbReplyType === "video" ? kbReplyUrl.trim() : "",
        priority: Number.isFinite(kbPriority) ? Math.round(kbPriority) : 100,
        enabled: true,
      });
      setKbList((prev) => [...prev, created].sort((a, b) => a.priority - b.priority));
      setKbWords("");
      setKbReplyText("");
      setKbReplyUrl("");
      setKbPriority(100);
    } catch (e) {
      setKbError(e instanceof Error ? e.message : "知识库创建失败");
    } finally {
      setKbSubmitting(false);
    }
  }, [kbWords, kbReplyType, kbReplyText, kbReplyUrl, kbPriority]);

  // ── 违禁词 ──
  const handleBannedAdd = useCallback(async () => {
    const word = bannedInput.trim();
    if (!word || bannedBusy) return;
    setBannedBusy(true);
    try {
      const created = await createLiveBanned(word);
      setBanned((prev) => [...prev, created]);
      setBannedInput("");
    } catch (e) {
      setKbError(e instanceof Error ? e.message : "违禁词添加失败");
    } finally {
      setBannedBusy(false);
    }
  }, [bannedInput, bannedBusy]);

  const handleBannedDelete = useCallback(async (id: string) => {
    try {
      await deleteLiveBanned(id);
      setBanned((prev) => prev.filter((w) => w.id !== id));
    } catch (e) {
      setKbError(e instanceof Error ? e.message : "违禁词删除失败");
    }
  }, []);

  const sessionActive = session.active;

  return (
    <>
      {/* ── 左:播报控制台 ── */}
      <div className="at-live">
        {/* 初始加载失败(形象模板/会话状态/知识库/违禁词):ErrorBar + 条外重试 */}
        {initError && (
          <div className="at-live-init-error">
            <ErrorBar
              message={`${initError}加载失败,部分功能不可用`}
              onClose={() => setInitError(null)}
            />
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="refresh" size={13} />}
              onClick={() => loadInitial()}
            >
              重试
            </Button>
          </div>
        )}
        {/* 会话控制行 */}
        <section className="at-live-control">
          <div className="at-live-control-row">
            <Select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              disabled={sessionActive || sessionBusy || templates.length === 0}
              aria-label="开播形象"
              className="at-live-avatar-select"
            >
              {templates.length === 0 && (
                <option value="">{templatesLoaded ? "暂无形象模板" : "加载中…"}</option>
              )}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.green_screen ? "(绿幕)" : ""}
                </option>
              ))}
            </Select>
            <Button
              variant={sessionActive ? "danger" : "primary"}
              loading={sessionBusy}
              icon={<Icon name={sessionActive ? "square" : "radio"} size={15} />}
              disabled={!sessionActive && !selectedTemplate}
              onClick={() => void handleSessionToggle()}
            >
              {sessionActive ? "结束直播" : "开始直播"}
            </Button>
            <Badge tone={sessionActive ? "ok" : "neutral"} dotPulse={sessionActive}>
              {sessionActive ? "直播中" : "未开播"}
            </Badge>
          </div>
          {selectedTemplate && (
            <div className="at-live-control-row at-live-control-meta">
              <div className="at-live-avatar-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={avatarAssetImageUrl(selectedTemplate.id, 0)} alt={selectedTemplate.name} loading="lazy" decoding="async" />
              </div>
              <span className="at-live-control-hint">
                已选形象「{selectedTemplate.name}」;互动回复将经此数字人口播
              </span>
            </div>
          )}
          {consoleError && <ErrorBar message={consoleError} onClose={() => setConsoleError(null)} />}
        </section>

        {/* 手动摄入(模拟弹幕) */}
        <section className="at-live-ingest">
          <div className="at-live-ingest-row">
            <Input
              type="text"
              value={ingestAuthor}
              maxLength={100}
              placeholder="观众昵称(可选)"
              aria-label="观众昵称"
              className="at-live-ingest-author"
              disabled={ingesting}
              onChange={(e) => setIngestAuthor(e.target.value)}
            />
            <Input
              type="text"
              value={ingestText}
              maxLength={2000}
              placeholder="输入一条弹幕,测试互动回复…"
              aria-label="弹幕内容"
              disabled={ingesting}
              onChange={(e) => setIngestText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void handleIngest()}
            />
            <Button
              variant="primary"
              loading={ingesting}
              icon={<Icon name="send" size={14} />}
              disabled={!ingestText.trim()}
              onClick={() => void handleIngest()}
            >
              摄入
            </Button>
          </div>
        </section>

        {/* 事件流(新→旧) */}
        <section className="at-live-events" aria-label="互动事件流">
          {events.length === 0 ? (
            <div className="at-live-events-empty">
              <Icon name="chat" size={22} strokeWidth={1.5} />
              <p>暂无互动事件;摄入一条弹幕试试</p>
            </div>
          ) : (
            events.map((ev) => {
              const meta = liveEventStatusMeta(ev.status);
              return (
                <article key={ev.id} className="at-live-event">
                  <div className="at-live-event-head">
                    <span className="at-live-event-author">{ev.author || "观众"}</span>
                    <Badge tone={meta.tone} dot={false}>
                      {meta.label}
                    </Badge>
                  </div>
                  <p className="at-live-event-text">{ev.text}</p>
                  {ev.reply_text && (
                    <p className="at-live-event-reply">
                      {ev.reply_type === "video" ? "视频回复:" : "回复:"}
                      {ev.reply_text}
                    </p>
                  )}
                </article>
              );
            })
          )}
        </section>
      </div>

      {/* ── 右:知识库 + 违禁词 ── */}
      <div className="at-panel">
        <div className="at-panel-body">
          <div className="at-gen-form">
            {/* 知识库 */}
            <section className="at-gen-section">
              <div className="at-section-head">
                <h3 className="at-section-title">知识库</h3>
                <span className="at-section-count">
                  {!kbLoaded ? "加载中" : `${kbList.length} 条,按优先级升序`}
                </span>
              </div>
              {kbList.length > 0 && (
                <div className="at-kb-list">
                  {kbList.map((kb) => (
                    <div key={kb.id} className={`at-kb-row${kb.enabled ? "" : " is-disabled"}`}>
                      <div className="at-kb-main">
                        <div className="at-kb-words">
                          {kb.trigger_words.map((w) => (
                            <span key={w} className="at-kb-word">
                              {w}
                            </span>
                          ))}
                        </div>
                        <p className="at-kb-reply" title={kb.reply_type === "text" ? kb.reply_text : kb.reply_asset_url}>
                          {kb.reply_type === "text" ? kb.reply_text : `视频:${kb.reply_asset_url}`}
                        </p>
                        <div className="at-kb-meta">
                          <Badge tone={kb.reply_type === "video" ? "accent" : "neutral"} dot={false}>
                            {kb.reply_type === "video" ? "视频" : "文本"}
                          </Badge>
                          <span className="at-kb-priority">优先级 {kb.priority}</span>
                        </div>
                      </div>
                      <div className="at-kb-actions">
                        <Switch
                          checked={kb.enabled}
                          onChange={(v) => void handleKbToggle(kb, v)}
                          ariaLabel={`启用「${kb.trigger_words[0] ?? kb.id}」`}
                        />
                        {kbConfirmDeleteId === kb.id ? (
                          <>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => void handleKbDelete(kb.id)}
                            >
                              确认
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setKbConfirmDeleteId(null)}>
                              取消
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Icon name="delete" size={13} />}
                            aria-label="删除知识库条目"
                            onClick={() => setKbConfirmDeleteId(kb.id)}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {kbLoaded && kbList.length === 0 && (
                <p className="at-models-empty">暂无知识库:添加触发词与回复,命中弹幕自动应答</p>
              )}

              {/* 新建表单 */}
              <Field label="触发词" hint="逗号分隔,弹幕包含任一即命中">
                <Input
                  type="text"
                  value={kbWords}
                  placeholder="如:价格,多少钱,优惠"
                  aria-label="触发词"
                  disabled={kbSubmitting}
                  onChange={(e) => setKbWords(e.target.value)}
                />
              </Field>
              <Field label="回复类型">
                <div className="at-seg" role="tablist" aria-label="回复类型">
                  {(
                    [
                      { key: "text", label: "文本" },
                      { key: "video", label: "视频" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={kbReplyType === t.key}
                      className={`at-seg-btn${kbReplyType === t.key ? " is-active" : ""}`}
                      disabled={kbSubmitting}
                      onClick={() => setKbReplyType(t.key)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </Field>
              {kbReplyType === "text" ? (
                <Field label="回复文本">
                  <Textarea
                    rows={2}
                    value={kbReplyText}
                    maxLength={2000}
                    placeholder="命中后数字人口播的内容"
                    disabled={kbSubmitting}
                    onChange={(e) => setKbReplyText(e.target.value)}
                  />
                </Field>
              ) : (
                <Field label="视频资产 URL" hint="粘贴作品库产物地址">
                  <Input
                    type="text"
                    value={kbReplyUrl}
                    placeholder="/api/images?filename=…"
                    disabled={kbSubmitting}
                    onChange={(e) => setKbReplyUrl(e.target.value)}
                  />
                </Field>
              )}
              <Field label="优先级" hint="数字越小越先匹配,默认 100">
                <Input
                  type="number"
                  min={0}
                  max={9999}
                  step={1}
                  value={kbPriority}
                  disabled={kbSubmitting}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) setKbPriority(n);
                  }}
                />
              </Field>
              {kbError && (
                <p className="at-gen-warn" role="alert">
                  {kbError}
                </p>
              )}
              <Button
                variant="secondary"
                loading={kbSubmitting}
                icon={<Icon name="plus" size={14} />}
                disabled={!kbWords.trim()}
                onClick={() => void handleKbCreate()}
              >
                添加知识库条目
              </Button>
            </section>

            {/* 违禁词 */}
            <section className="at-gen-section">
              <div className="at-section-head">
                <h3 className="at-section-title">违禁词</h3>
                <span className="at-section-count">
                  {!bannedLoaded ? "加载中" : `${banned.length} 个`}
                </span>
              </div>
              {banned.length > 0 && (
                <div className="at-banned-tags">
                  {banned.map((w) => (
                    <span key={w.id} className="at-banned-tag">
                      {w.word}
                      <button
                        type="button"
                        className="at-banned-tag-x"
                        aria-label={`删除违禁词 ${w.word}`}
                        onClick={() => setConfirmDeleteBanned(w)}
                      >
                        <Icon name="close" size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {bannedLoaded && banned.length === 0 && (
                <p className="at-models-empty">暂无违禁词:命中的弹幕与回复会被直接拦截</p>
              )}
              <div className="at-gen-inline">
                <Input
                  type="text"
                  value={bannedInput}
                  maxLength={100}
                  placeholder="添加违禁词"
                  aria-label="违禁词"
                  disabled={bannedBusy}
                  onChange={(e) => setBannedInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleBannedAdd()}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={bannedBusy}
                  icon={<Icon name="plus" size={14} />}
                  disabled={!bannedInput.trim()}
                  onClick={() => void handleBannedAdd()}
                >
                  添加
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* 删除违禁词确认(ui/Modal,与 KB 两步确认同语义,防误删拦截规则) */}
      <Modal
        open={!!confirmDeleteBanned}
        onClose={() => setConfirmDeleteBanned(null)}
        title="删除违禁词"
        danger
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDeleteBanned(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="delete" size={14} />}
              onClick={() => confirmDeleteBanned && void handleBannedDelete(confirmDeleteBanned.id)}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          删除违禁词「{confirmDeleteBanned?.word}」?之后包含该词的弹幕与回复将不再被拦截。
        </p>
      </Modal>
    </>
  );
}

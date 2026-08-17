"use client";

/**
 * LibTV 式短剧工作台 —— 阶段②资产(Team B,契约见 ./types.ts StageStubProps)。
 *
 * - 角色卡片墙:定妆三视图(正/侧/背小图切换,img 带尺寸属性)、角色名、
 *   描述截断、被引用计数(遍历 shots.characters 按角色名统计,可点击跳到
 *   首个引用镜头)、操作(生成三视图 dp.generateReference / 编辑 dp.patchCharacter
 *   / 删除 dp.deleteCharacter —— 删除走 ui/Modal 确认门)。
 * - 候选/确认分区(Jellyfish 范式,零后端改动):组件挂载后新出现的角色
 *   (autorun 抽取等 source 未知来源)入「候选区」(视觉降级 + 接受/忽略);
 *   候选与忽略集合按项目持久化到 localStorage。接受=移到正式区;忽略=隐藏,
 *   可经「已忽略」恢复。
 * - 场景/道具资产库:dp 自带资产库 API(loadAssets/assets/applyAsset/deleteAsset),
 *   收叠区按需加载,卡片化(缩略图/名称/类目/应用[角色类]/删除[Modal 确认门])。
 * - 顶部工具条:「添加角色」inline 表单(dp.createCharacter)+ 角色数统计。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { imageUrl, type DramaAsset, type DramaCharacterItem } from "@/lib/api";
import { loadJSON, saveJSON } from "@/lib/storage";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useAutoResize } from "@/hooks/useAutoResize";
import type { StageStubProps } from "./types";

const KIND_LABEL: Record<string, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  style: "风格",
};

type LibTab = "all" | "scene" | "prop" | "character";
const LIB_TABS: { key: LibTab; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "scene", label: "场景" },
  { key: "prop", label: "道具" },
  { key: "character", label: "角色" },
];

const VIEWS = [
  { key: "front", label: "正" },
  { key: "side", label: "侧" },
  { key: "back", label: "背" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];

function viewUrl(c: DramaCharacterItem, view: ViewKey): string {
  if (view === "side") return c.reference_side;
  if (view === "back") return c.reference_back;
  return c.reference_front;
}

/** 单张角色卡(候选态视觉降级 + 接受/忽略;正式态三视图/编辑/删除) */
function CharacterCard({
  c,
  candidate,
  refCount,
  refShotId,
  busy,
  onGenerateRef,
  onEdit,
  onDelete,
  onAccept,
  onIgnore,
  onJump,
}: {
  c: DramaCharacterItem;
  candidate: boolean;
  refCount: number;
  refShotId: string | null;
  busy: boolean;
  onGenerateRef: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAccept: () => void;
  onIgnore: () => void;
  onJump: (sid: string) => void;
}) {
  const [view, setView] = useState<ViewKey>("front");
  const thumb = viewUrl(c, view) || c.ref_image;
  const viewLabel = VIEWS.find((v) => v.key === view)?.label ?? "正";

  return (
    <article className={`wb-char${candidate ? " is-candidate" : ""}`}>
      <div className="wb-char-thumb">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl(thumb)}
            alt={`${c.name} ${viewLabel}面定妆`}
            width={176}
            height={176}
            loading="lazy"
          />
        ) : (
          <div className="wb-char-nothumb">
            <Icon name="user" size={26} strokeWidth={1.1} />
            <span>未定妆</span>
          </div>
        )}
        {candidate && <span className="wb-char-flag">候选</span>}
      </div>
      <div className="wb-char-views" role="tablist" aria-label="三视图切换">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            className={`wb-char-view${view === v.key ? " is-active" : ""}`}
            disabled={!viewUrl(c, v.key)}
            title={viewUrl(c, v.key) ? `${v.label}面` : `${v.label}面未生成`}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="wb-char-name" title={c.name}>
        {c.name}
      </div>
      {c.description && (
        <div className="wb-char-desc" title={c.description}>
          {c.description}
        </div>
      )}
      <div className="wb-char-meta">
        {refCount > 0 ? (
          <button
            type="button"
            className="wb-char-refs"
            title="被引用镜头数,点击跳到首个引用镜头"
            onClick={() => refShotId && onJump(refShotId)}
          >
            <Icon name="film" size={12} />
            被 {refCount} 镜引用
          </button>
        ) : (
          <span className="wb-char-refs is-zero">
            <Icon name="film" size={12} />
            未被引用
          </span>
        )}
      </div>
      <div className="wb-char-ops">
        {candidate ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onAccept}
            >
              <Icon name="check" size={13} />
              接受
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onIgnore}>
              <Icon name="close" size={13} />
              忽略
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              title="生成三视图(正/侧/背)锁定一致性"
              onClick={onGenerateRef}
            >
              <Icon name="wand" size={13} />
              {busy ? "生成中…" : "生成三视图"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={`编辑角色 ${c.name}`}
              onClick={onEdit}
            >
              <Icon name="pencil" size={13} />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={`删除角色 ${c.name}`}
              onClick={onDelete}
            >
              <Icon name="delete" size={13} />
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function StageAssets(props: StageStubProps) {
  const { dp, onOpenProduce } = props;
  const { show: showToast } = useToast();
  const pid = dp.current?.id ?? "default";

  // ── 添加角色 inline 表单 ──
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [adding, setAdding] = useState(false);

  // ── 候选/忽略集合(按项目持久化,零后端改动)──
  const candKey = `toiv_wb_candidates_${pid}`;
  const ignKey = `toiv_wb_ignored_${pid}`;
  const [candidates, setCandidates] = useState<string[]>(() =>
    loadJSON<string[]>(candKey, []),
  );
  const [ignored, setIgnored] = useState<string[]>(() =>
    loadJSON<string[]>(ignKey, []),
  );
  const [showIgnored, setShowIgnored] = useState(false);
  // 已知角色 id(挂载时现存角色视为正式);用户经表单新建的角色也直接入正式
  const knownRef = useRef<Set<string> | null>(null);
  const formalAddsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    saveJSON(candKey, candidates);
  }, [candKey, candidates]);
  useEffect(() => {
    saveJSON(ignKey, ignored);
  }, [ignKey, ignored]);

  // 新出现且来源未知的角色 → 候选区
  useEffect(() => {
    const ids = dp.characters.map((c) => c.id);
    if (knownRef.current === null) {
      knownRef.current = new Set(ids);
      return;
    }
    const known = knownRef.current;
    const fresh = ids.filter((id) => !known.has(id));
    knownRef.current = new Set(ids);
    if (fresh.length === 0) return;
    const realFresh = fresh.filter((id) => !formalAddsRef.current.has(id));
    if (realFresh.length === 0) return;
    setCandidates((prev) => {
      const next = [...prev];
      for (const id of realFresh) {
        if (!next.includes(id) && !ignored.includes(id)) next.push(id);
      }
      return next;
    });
  }, [dp.characters, ignored]);

  // ── 被引用计数(shots.characters 按角色名统计)──
  const refStats = useMemo(() => {
    const byName = new Map(dp.characters.map((c) => [c.name, c.id]));
    const count = new Map<string, number>();
    const firstSid = new Map<string, string>();
    for (const s of dp.shots) {
      for (const n of s.characters ?? []) {
        const cid = byName.get(n);
        if (!cid) continue;
        count.set(cid, (count.get(cid) ?? 0) + 1);
        if (!firstSid.has(cid)) firstSid.set(cid, s.id);
      }
    }
    return { count, firstSid };
  }, [dp.characters, dp.shots]);

  const candidateChars = dp.characters.filter(
    (c) => candidates.includes(c.id) && !ignored.includes(c.id),
  );
  const formalChars = dp.characters.filter(
    (c) => !candidates.includes(c.id) && !ignored.includes(c.id),
  );
  const ignoredChars = dp.characters.filter((c) => ignored.includes(c.id));

  // ── 编辑/删除确认门 ──
  const [editing, setEditing] = useState<DramaCharacterItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  // 角色外观描述自动增高(Modal 内长文本不再 rows=4 截断)
  const editDescRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoResize(editDescRef, editDesc);
  const [delChar, setDelChar] = useState<{ id: string; name: string } | null>(
    null,
  );

  const openEdit = (c: DramaCharacterItem) => {
    setEditing(c);
    setEditName(c.name);
    setEditDesc(c.description ?? "");
  };

  const submitEdit = async () => {
    if (!editing || editBusy) return;
    const nextName = editName.trim();
    if (!nextName) return;
    setEditBusy(true);
    try {
      await dp.patchCharacter(editing.id, {
        name: nextName,
        description: editDesc.trim(),
      });
      setEditing(null);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "更新角色失败");
    } finally {
      setEditBusy(false);
    }
  };

  const addCharacter = async () => {
    const n = name.trim();
    if (!n || adding) return;
    setAdding(true);
    try {
      const created = await dp.createCharacter({ name: n, description: desc.trim() });
      formalAddsRef.current.add(created.id);
      if (knownRef.current) knownRef.current.add(created.id);
      setName("");
      setDesc("");
      setAddOpen(false);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "添加角色失败");
    } finally {
      setAdding(false);
    }
  };

  // ── 资产库(场景/道具,收叠按需加载)──
  const [libOpen, setLibOpen] = useState(false);
  const [libTab, setLibTab] = useState<LibTab>("all");
  const [busyApply, setBusyApply] = useState<string | null>(null);
  const [delAsset, setDelAsset] = useState<{ id: string; name: string } | null>(
    null,
  );

  useEffect(() => {
    if (libOpen && dp.assets === null && !dp.assetsLoading) {
      void dp.loadAssets();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libOpen]);

  const libAssets = (dp.assets ?? []).filter(
    (a) => libTab === "all" || a.kind === libTab,
  );

  if (!dp.current) {
    return <div className="wb-assets-loading">项目加载中…</div>;
  }

  return (
    <div className="wb-assets">
      {/* ── 顶部工具条 ── */}
      <div className="wb-assets-bar">
        <span className="wb-assets-stat">
          <Icon name="users" size={14} />
          角色 {formalChars.length}
          {candidateChars.length > 0 && ` · 候选 ${candidateChars.length}`}
        </span>
        <span className="wb-assets-bar-spacer" />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setAddOpen((v) => !v)}
          aria-expanded={addOpen}
        >
          <Icon name="plus" size={14} />
          添加角色
        </button>
      </div>

      {addOpen && (
        <form
          className="wb-assets-addform"
          onSubmit={(e) => {
            e.preventDefault();
            void addCharacter();
          }}
        >
          <input
            className="wb-input"
            placeholder="角色名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            aria-label="角色名"
          />
          <input
            className="wb-input"
            placeholder="外观描述(可选)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            aria-label="外观描述"
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={!name.trim() || adding}
          >
            {adding ? "添加中…" : "添加"}
          </button>
        </form>
      )}

      {/* ── 候选确认筐(Jellyfish)── */}
      {candidateChars.length > 0 && (
        <section className="wb-assets-sec" aria-label="候选角色">
          <header className="wb-assets-sec-head">
            <Icon name="sparkles" size={13} />
            候选角色({candidateChars.length})
            <span className="wb-assets-sec-hint">
              新来源角色先入候选筐,接受后进入正式资产
            </span>
          </header>
          <div className="wb-assets-grid">
            {candidateChars.map((c) => (
              <CharacterCard
                key={c.id}
                c={c}
                candidate
                refCount={refStats.count.get(c.id) ?? 0}
                refShotId={refStats.firstSid.get(c.id) ?? null}
                busy={dp.busyRef === c.id}
                onGenerateRef={() => void dp.generateReference(c.id, c.name)}
                onEdit={() => openEdit(c)}
                onDelete={() => setDelChar({ id: c.id, name: c.name })}
                onAccept={() =>
                  setCandidates((prev) => prev.filter((id) => id !== c.id))
                }
                onIgnore={() => {
                  setCandidates((prev) => prev.filter((id) => id !== c.id));
                  setIgnored((prev) =>
                    prev.includes(c.id) ? prev : [...prev, c.id],
                  );
                }}
                onJump={onOpenProduce}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── 正式角色卡片墙 ── */}
      <section className="wb-assets-sec" aria-label="角色资产">
        <header className="wb-assets-sec-head">
          <Icon name="users" size={13} />
          角色资产({formalChars.length})
        </header>
        {formalChars.length === 0 ? (
          <div className="wb-assets-empty">
            <Icon name="user" size={22} strokeWidth={1.2} />
            暂无角色。点右上「添加角色」创建,定妆三视图可锁定跨镜一致性。
          </div>
        ) : (
          <div className="wb-assets-grid">
            {formalChars.map((c) => (
              <CharacterCard
                key={c.id}
                c={c}
                candidate={false}
                refCount={refStats.count.get(c.id) ?? 0}
                refShotId={refStats.firstSid.get(c.id) ?? null}
                busy={dp.busyRef === c.id}
                onGenerateRef={() => void dp.generateReference(c.id, c.name)}
                onEdit={() => openEdit(c)}
                onDelete={() => setDelChar({ id: c.id, name: c.name })}
                onAccept={() => {}}
                onIgnore={() => {}}
                onJump={onOpenProduce}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── 已忽略(可恢复)── */}
      {ignoredChars.length > 0 && (
        <section className="wb-assets-sec" aria-label="已忽略角色">
          <header className="wb-assets-sec-head">
            <Icon name="close" size={13} />
            已忽略({ignoredChars.length})
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowIgnored((v) => !v)}
              aria-expanded={showIgnored}
            >
              {showIgnored ? "收起" : "展开"}
            </button>
          </header>
          {showIgnored && (
            <div className="wb-assets-ignored">
              {ignoredChars.map((c) => (
                <span key={c.id} className="wb-assets-ignored-item">
                  {c.name}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setIgnored((prev) => prev.filter((id) => id !== c.id))
                    }
                  >
                    恢复
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── 场景/道具资产库(收叠,按需加载)── */}
      <section className="wb-assets-sec" aria-label="场景道具资产库">
        <header className="wb-assets-sec-head">
          <Icon name="box" size={13} />
          场景/道具资产库
          <span className="wb-assets-sec-hint">跨项目复用</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setLibOpen((v) => !v)}
            aria-expanded={libOpen}
          >
            <Icon name={libOpen ? "chevron-up" : "chevron-down"} size={13} />
            {libOpen ? "收起" : "打开资产库"}
          </button>
        </header>
        {libOpen && (
          <>
            <div className="wb-assets-libtabs" role="tablist" aria-label="资产类目">
              {LIB_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={libTab === t.key}
                  className={`wb-script-chip${libTab === t.key ? " is-active" : ""}`}
                  onClick={() => setLibTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {dp.assetsLoading && (
              <div className="wb-assets-empty">
                <Icon name="loading" size={16} /> 资产库加载中…
              </div>
            )}
            {!dp.assetsLoading && libAssets.length === 0 && (
              <div className="wb-assets-empty">
                <Icon name="box" size={20} strokeWidth={1.2} />
                该类目暂无资产
              </div>
            )}
            {!dp.assetsLoading && libAssets.length > 0 && (
              <div className="wb-assets-grid">
                {libAssets.map((a: DramaAsset) => {
                  const thumb = a.reference_front || a.ref_image;
                  return (
                    <article key={a.id} className="wb-char">
                      <div className="wb-char-thumb">
                        {thumb ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={imageUrl(thumb)}
                            alt={a.name}
                            width={176}
                            height={176}
                            loading="lazy"
                          />
                        ) : (
                          <div className="wb-char-nothumb">
                            <Icon name="box" size={24} strokeWidth={1.1} />
                            <span>无缩略图</span>
                          </div>
                        )}
                        <span className="wb-char-flag">
                          {KIND_LABEL[a.kind] ?? a.kind}
                        </span>
                      </div>
                      <div className="wb-char-name" title={a.name}>
                        {a.name}
                      </div>
                      {a.description && (
                        <div className="wb-char-desc" title={a.description}>
                          {a.description}
                        </div>
                      )}
                      <div className="wb-char-ops">
                        {a.kind === "character" && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busyApply === a.id}
                            title="作为角色应用到当前项目"
                            onClick={() => {
                              setBusyApply(a.id);
                              void dp.applyAsset(a.id, a.name).finally(() =>
                                setBusyApply(null),
                              );
                            }}
                          >
                            {busyApply === a.id ? "应用中…" : "应用到项目"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={`删除资产 ${a.name}`}
                          onClick={() => setDelAsset({ id: a.id, name: a.name })}
                        >
                          <Icon name="delete" size={13} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>

      {/* ── 编辑角色 Modal ── */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="编辑角色"
        preventClose={editBusy}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={editBusy}
              disabled={!editName.trim()}
              onClick={() => void submitEdit()}
            >
              保存
            </Button>
          </>
        }
      >
        <div className="wb-assets-editform">
          <label className="wb-assets-field">
            <span>角色名</span>
            <input
              className="wb-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={30}
            />
          </label>
          <label className="wb-assets-field">
            <span>外观描述</span>
            <textarea
              ref={editDescRef}
              className="wb-input"
              rows={4}
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
            />
          </label>
        </div>
      </Modal>

      {/* ── 删除角色确认门 ── */}
      <Modal
        open={!!delChar}
        onClose={() => setDelChar(null)}
        title="删除角色"
        danger
        footer={
          <>
            <Button variant="secondary" onClick={() => setDelChar(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="delete" size={14} />}
              onClick={() => {
                if (delChar) void dp.deleteCharacter(delChar.id, delChar.name);
                setDelChar(null);
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="wb-assets-modalnote">
          删除角色「{delChar?.name}」?此操作不可撤销。
        </p>
      </Modal>

      {/* ── 删除资产确认门 ── */}
      <Modal
        open={!!delAsset}
        onClose={() => setDelAsset(null)}
        title="删除资产"
        danger
        footer={
          <>
            <Button variant="secondary" onClick={() => setDelAsset(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="delete" size={14} />}
              onClick={() => {
                if (delAsset) void dp.deleteAsset(delAsset.id, delAsset.name);
                setDelAsset(null);
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="wb-assets-modalnote">
          删除资产「{delAsset?.name}」?此操作不可撤销。
        </p>
      </Modal>
    </div>
  );
}

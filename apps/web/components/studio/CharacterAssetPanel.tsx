"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getStudioCharacterAsset,
  imageUrl,
  putStudioCharacterAsset,
  renderStudioCharacterAssetCard,
  studioCharacterAssetCoveragePlan,
  type StudioCharacter,
  type StudioCharacterAsset,
  type StudioCharacterAssetAnchor,
  type StudioCharacterAssetCoveragePlan,
  type StudioCharacterSheetStyle,
} from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { useToast } from "@/components/ui/Toast";

/** 锚点 kind 词表(与 api character_asset.ANCHOR_KINDS 单一真源对齐)。 */
export const ANCHOR_KIND_LABELS: Record<string, string> = {
  identity: "身份",
  hair: "发型",
  eyes: "瞳色",
  face: "脸型",
  skin: "肤色",
  body: "体型",
  costume: "服装",
  accessory: "配饰",
  weapon: "武器",
  color: "色彩",
  creature: "种族特征",
};

const ENFORCE_LABELS: Record<string, string> = {
  prompt: "正向",
  "prompt+negative": "正负",
  gate: "门禁",
};

const ANGLE_LABELS: Record<string, string> = {
  front: "正",
  side: "侧",
  back: "背",
};
const FRAMING_LABELS: Record<string, string> = {
  full_body: "全身",
  medium_closeup: "中近景",
  over_shoulder: "过肩",
  extreme_closeup: "特写",
};
const LIGHTING_LABELS: Record<string, string> = {
  day: "日光",
  night: "夜戏",
  rain_backlit: "雨夜逆光",
  indoor_warm: "室内暖光",
};

const KIND_OPTIONS = Object.keys(ANCHOR_KIND_LABELS);
const ENFORCE_OPTIONS = ["prompt", "prompt+negative", "gate"];

type Props = {
  open: boolean;
  onClose: () => void;
  characters: StudioCharacter[];
  initialCharacterId?: string;
};

function Chip({
  label,
  tone,
  title,
}: {
  label: string;
  tone?: "ok" | "gap";
  title?: string;
}) {
  return (
    <span
      className={`studio-asset-chip${tone === "gap" ? " is-gap" : ""}`}
      title={title}
    >
      {label}
    </span>
  );
}

/**
 * 角色资产面板(L2 Character Asset Definition):
 * 锚点数据化编辑 / 色板 / 覆盖登记与缺口 / 展示卡渲染 / 补拍计划。
 * 协议 docs/ops/CHARACTER_ASSET_PROTOCOL.md(2026-10-06)。
 */
export function CharacterAssetPanel({
  open,
  onClose,
  characters,
  initialCharacterId,
}: Props) {
  const toast = useToast();
  const [cid, setCid] = useState(initialCharacterId || characters[0]?.id || "");
  const [style, setStyle] = useState<StudioCharacterSheetStyle>("anime");
  const [asset, setAsset] = useState<StudioCharacterAsset | null>(null);
  const [anchors, setAnchors] = useState<StudioCharacterAssetAnchor[]>([]);
  const [profile, setProfile] = useState({
    role: "",
    personality: "",
    speech_style: "",
    background: "",
  });
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const [plan, setPlan] = useState<StudioCharacterAssetCoveragePlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const character = useMemo(
    () => characters.find((c) => c.id === cid) || null,
    [characters, cid],
  );

  const load = useCallback(async () => {
    if (!cid || !character) return;
    setBusy("load");
    setError(null);
    try {
      const a = await getStudioCharacterAsset(cid, style);
      setAsset(a);
      setAnchors(a.identity_anchors || []);
      setProfile({
        role: a.profile?.role || "",
        personality: a.profile?.personality || "",
        speech_style: a.profile?.speech_style || "",
        background: a.profile?.background || "",
      });
      if (a.materialized_now) toast.success("已从存量面板回填资产 v1");
    } catch (e) {
      setError(e instanceof Error ? e.message : "资产读取失败");
    } finally {
      setBusy(null);
    }
  }, [cid, character, style, toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const save = async () => {
    if (!cid) return;
    setBusy("save");
    setError(null);
    try {
      const a = await putStudioCharacterAsset(cid, {
        style,
        identity_anchors: anchors,
        profile,
      });
      setAsset(a);
      toast.success(`资产 v${a.version} 已保存`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "资产保存失败");
    } finally {
      setBusy(null);
    }
  };

  const renderCard = async () => {
    if (!cid) return;
    setBusy("card");
    setError(null);
    try {
      const res = await renderStudioCharacterAssetCard(cid, style);
      setCardUrl(res.card_url);
      toast.success("展示卡已渲染");
    } catch (e) {
      setError(e instanceof Error ? e.message : "展示卡渲染失败");
    } finally {
      setBusy(null);
    }
  };

  const loadPlan = async () => {
    if (!cid) return;
    setBusy("plan");
    setError(null);
    try {
      setPlan(await studioCharacterAssetCoveragePlan(cid, style));
    } catch (e) {
      setError(e instanceof Error ? e.message : "覆盖计划获取失败");
    } finally {
      setBusy(null);
    }
  };

  const setAnchor = (i: number, patch: Partial<StudioCharacterAssetAnchor>) => {
    setAnchors((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  };

  const palette = [
    asset?.color_palette?.primary,
    asset?.color_palette?.secondary,
    asset?.color_palette?.accent,
    ...(asset?.color_palette?.extras || []),
  ].filter((x): x is string => !!x);

  const cov = asset?.coverage || {};
  const gaps = plan?.gaps;
  const chipRow = (
    have: string[] | undefined,
    labels: Record<string, string>,
    gapList: string[] | undefined,
  ) => (
    <div className="studio-asset-chips" data-testid="studio-asset-chips">
      {(have || []).map((k) => (
        <Chip key={k} label={labels[k] || k} tone="ok" />
      ))}
      {(gapList || []).map((k) => (
        <Chip key={k} label={`${labels[k] || k}·缺`} tone="gap" title="覆盖缺口,补拍计划可出 job" />
      ))}
      {!(have || []).length && !(gapList || []).length && (
        <span className="studio-asset-empty">—</span>
      )}
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="角色资产(Character Asset)"
      width={720}
      footer={
        <div className="studio-asset-footer">
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={!!busy || !cid}
            data-testid="studio-asset-save"
          >
            <Icon name={busy === "save" ? "loading" : "check"} size={12} />
            保存锚点与档案
          </Button>
        </div>
      }
    >
      <div className="studio-asset" data-testid="studio-asset-panel">
        <div className="studio-asset-toolbar">
          <label className="studio-asset-field">
            <span>角色</span>
            <Select
              value={cid}
              onChange={(e) => {
                setCid(e.target.value);
                setAsset(null);
                setCardUrl(null);
                setPlan(null);
              }}
              data-testid="studio-asset-character"
            >
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id.slice(0, 8)}
                </option>
              ))}
            </Select>
          </label>
          <label className="studio-asset-field">
            <span>风格</span>
            <Select
              value={style}
              onChange={(e) => {
                setStyle(e.target.value as StudioCharacterSheetStyle);
                setAsset(null);
                setCardUrl(null);
                setPlan(null);
              }}
              data-testid="studio-asset-style"
            >
              <option value="anime">二次元</option>
              <option value="ancient_realistic">古风写实</option>
            </Select>
          </label>
          <div className="studio-asset-version" data-testid="studio-asset-version">
            {asset ? (
              <>
                v{asset.version}
                {asset.derived_from
                  ? ` ← v${asset.derived_from.base_version}(${asset.derived_from.regen_reason})`
                  : ""}
              </>
            ) : (
              "未加载"
            )}
          </div>
          <Button variant="ghost" onClick={() => void load()} disabled={!!busy}>
            <Icon name={busy === "load" ? "loading" : "refresh"} size={12} />
            刷新
          </Button>
        </div>

        {error && <ErrorBar message={error} onClose={() => setError(null)} />}

        {asset && (
          <>
            <section className="studio-asset-section" data-testid="studio-asset-anchors">
              <h4>
                识别锚点 Identity Anchors
                <span className="studio-asset-hint">换装/换画风不变的身份特征;enforce=门禁者走 QA</span>
              </h4>
              <div className="studio-asset-anchor-rows">
                {anchors.map((a, i) => (
                  <div key={i} className="studio-asset-anchor-row">
                    <Select
                      value={a.kind}
                      onChange={(e) => setAnchor(i, { kind: e.target.value })}
                      aria-label="锚点类型"
                    >
                      {KIND_OPTIONS.map((k) => (
                        <option key={k} value={k}>
                          {ANCHOR_KIND_LABELS[k]}
                        </option>
                      ))}
                    </Select>
                    <Input
                      value={a.desc}
                      onChange={(e) => setAnchor(i, { desc: e.target.value })}
                      placeholder="锚点描述(注入生成提示词)"
                      aria-label="锚点描述"
                    />
                    <Select
                      value={a.enforce}
                      onChange={(e) => setAnchor(i, { enforce: e.target.value })}
                      aria-label="约束方式"
                    >
                      {ENFORCE_OPTIONS.map((k) => (
                        <option key={k} value={k}>
                          {ENFORCE_LABELS[k]}
                        </option>
                      ))}
                    </Select>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setAnchors((p) => p.filter((_, idx) => idx !== i))}
                      aria-label="删除锚点"
                      disabled={anchors.length <= 1}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  setAnchors((p) => [...p, { kind: "costume", desc: "", enforce: "prompt+negative" }])
                }
                disabled={anchors.length >= 10}
                data-testid="studio-asset-anchor-add"
              >
                <Icon name="plus" size={12} /> 加锚点
              </button>
            </section>

            <section className="studio-asset-section" data-testid="studio-asset-coverage">
              <h4>
                覆盖登记 Coverage
                <Button variant="ghost" onClick={() => void loadPlan()} disabled={!!busy} data-testid="studio-asset-plan-btn">
                  <Icon name={busy === "plan" ? "loading" : "list-ordered"} size={12} />
                  补拍计划
                </Button>
              </h4>
              <div className="studio-asset-cov-row">
                <span className="studio-asset-cov-label">角度</span>
                {chipRow(cov.angles, ANGLE_LABELS, gaps?.angles)}
              </div>
              <div className="studio-asset-cov-row">
                <span className="studio-asset-cov-label">景别</span>
                {chipRow(cov.framings, FRAMING_LABELS, gaps?.framings)}
              </div>
              <div className="studio-asset-cov-row">
                <span className="studio-asset-cov-label">光照</span>
                {chipRow(cov.lightings, LIGHTING_LABELS, gaps?.lightings)}
              </div>
              {plan && plan.plan.length > 0 && (
                <ul className="studio-asset-plan" data-testid="studio-asset-plan">
                  {plan.plan.map((j) => (
                    <li key={`${j.kind}-${j.key}`}>
                      <Chip label={`${j.kind}/${j.key}`} tone="gap" />
                      <code>{j.positive}</code>
                    </li>
                  ))}
                </ul>
              )}
              {plan && plan.plan.length === 0 && (
                <p className="studio-asset-empty">短剧默认画像已全覆盖</p>
              )}
            </section>

            <section className="studio-asset-section" data-testid="studio-asset-palette">
              <h4>色彩系统 Palette</h4>
              {palette.length > 0 ? (
                <div className="studio-asset-swatches">
                  {palette.map((hx) => (
                    <span key={hx} className="studio-asset-swatch" title={hx}>
                      <i style={{ background: hx }} />
                      {hx}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="studio-asset-empty">尚无色板(生成设定卡后自动采样)</p>
              )}
            </section>

            <section className="studio-asset-section" data-testid="studio-asset-expr">
              <h4>表情 / 口型</h4>
              <div className="studio-asset-chips">
                {(asset.expressions?.emotions || []).map((e) => (
                  <Chip key={e} label={e} tone="ok" />
                ))}
                {(asset.expressions?.mouth_series || []).map((m) => (
                  <Chip key={m} label={`口型 ${m}`} tone="ok" />
                ))}
              </div>
            </section>

            <section className="studio-asset-section" data-testid="studio-asset-profile">
              <h4>身份档案 Profile</h4>
              <div className="studio-asset-profile-grid">
                <label>
                  <span>身份</span>
                  <Input
                    value={profile.role}
                    onChange={(e) => setProfile((p) => ({ ...p, role: e.target.value }))}
                  />
                </label>
                <label>
                  <span>性格</span>
                  <Input
                    value={profile.personality}
                    onChange={(e) => setProfile((p) => ({ ...p, personality: e.target.value }))}
                  />
                </label>
                <label>
                  <span>口吻</span>
                  <Input
                    value={profile.speech_style}
                    onChange={(e) => setProfile((p) => ({ ...p, speech_style: e.target.value }))}
                  />
                </label>
              </div>
              <label className="studio-asset-profile-bg">
                <span>背景</span>
                <Textarea
                  rows={2}
                  value={profile.background}
                  onChange={(e) => setProfile((p) => ({ ...p, background: e.target.value }))}
                />
              </label>
              {(asset.canonical_prompt?.negative_constraints || []).length > 0 && (
                <div className="studio-asset-chips" data-testid="studio-asset-neg">
                  {(asset.canonical_prompt!.negative_constraints || []).map((n) => (
                    <Chip key={n} label={`负:${n}`} tone="gap" />
                  ))}
                </div>
              )}
            </section>

            <section className="studio-asset-section" data-testid="studio-asset-card-sec">
              <h4>
                展示卡(对外传播形态)
                <Button variant="ghost" onClick={() => void renderCard()} disabled={!!busy} data-testid="studio-asset-card-btn">
                  <Icon name={busy === "card" ? "loading" : "image"} size={12} />
                  渲染展示卡
                </Button>
              </h4>
              {cardUrl ? (
                <a href={imageUrl(cardUrl)} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageUrl(cardUrl)}
                    alt="角色资产展示卡"
                    className="studio-asset-card-img"
                    data-testid="studio-asset-card-img"
                  />
                </a>
              ) : (
                <p className="studio-asset-empty">资产集的模板渲染视图;点击上方按钮生成</p>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

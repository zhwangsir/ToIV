"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  generateStudioCharacterSheet,
  imageUrl,
  listStudioCharacterSheets,
  regenerateStudioCharacterSheetPanels,
  replaceStudioCharacterSheetPanel,
  type StudioCharacter,
  type StudioCharacterSheetStyle,
  type StudioCharacterSheetResult,
  type StudioCharacterSheetListItem,
} from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { useToast } from "@/components/ui/Toast";

/** 可点选单格(与 LAYOUT 近似比例,用于预览热区)。 */
const PANEL_HOTSPOTS: {
  key: string;
  label: string;
  /** 相对整卡 0–1 */
  box: [number, number, number, number];
}[] = [
  { key: "portrait", label: "立绘", box: [0.02, 0.015, 0.30, 0.37] },
  { key: "front", label: "三视图·正", box: [0.38, 0.04, 0.18, 0.48] },
  { key: "side", label: "三视图·侧", box: [0.57, 0.04, 0.18, 0.48] },
  { key: "back", label: "三视图·背", box: [0.76, 0.04, 0.18, 0.48] },
  { key: "faces", label: "面部", box: [0.02, 0.56, 0.32, 0.16] },
  { key: "expressions", label: "表情", box: [0.35, 0.56, 0.40, 0.16] },
  { key: "costume", label: "服饰", box: [0.02, 0.73, 0.49, 0.16] },
];

const PANEL_LABEL: Record<string, string> = Object.fromEntries(
  PANEL_HOTSPOTS.map((h) => [h.key, h.label]),
);

function panelLabel(key: string | null): string {
  if (!key) return "未选";
  return PANEL_LABEL[key] || key;
}

type Props = {
  open: boolean;
  onClose: () => void;
  characters: StudioCharacter[];
  initialCharacterId?: string;
  onChanged?: () => Promise<void>;
};

export function CharacterSheetEditor({
  open,
  onClose,
  characters,
  initialCharacterId,
  onChanged,
}: Props) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [cid, setCid] = useState(initialCharacterId || characters[0]?.id || "");
  const [style, setStyle] = useState<StudioCharacterSheetStyle>("anime");
  const [sheets, setSheets] = useState<StudioCharacterSheetListItem[]>([]);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [panelUrls, setPanelUrls] = useState<Record<string, string>>({});
  const [locked, setLocked] = useState<Record<string, boolean>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<null | (() => Promise<void>)>(null);
  const [role, setRole] = useState("");
  const [personality, setPersonality] = useState("");
  const [designNotes, setDesignNotes] = useState("");
  const [heightCm, setHeightCm] = useState("168");

  const character = useMemo(
    () => characters.find((c) => c.id === cid) || null,
    [characters, cid],
  );

  const refreshList = useCallback(async () => {
    if (!cid) return;
    try {
      const res = await listStudioCharacterSheets(cid);
      setSheets(res.sheets || []);
      const hit = (res.sheets || []).find((s) => s.style === style);
      if (hit) {
        setSheetUrl(hit.sheet_url);
        setPanelUrls(hit.panel_urls || {});
      } else if (!sheetUrl) {
        setSheetUrl(null);
        setPanelUrls({});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "列表失败");
    }
  }, [cid, style, sheetUrl]);

  useEffect(() => {
    if (!open) return;
    if (initialCharacterId) setCid(initialCharacterId);
  }, [open, initialCharacterId]);

  useEffect(() => {
    if (!open || !character) return;
    const desc = (character.description || "").trim();
    setRole(desc.split(/[，,/|]/)[0]?.trim() || "");
    setPersonality("");
    setDesignNotes(desc);
    setHeightCm("168");
  }, [open, character?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !cid) return;
    void refreshList();
  }, [open, cid, style]); // eslint-disable-line react-hooks/exhaustive-deps

  const runWithRetry = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setRetryAction(() => async () => {
      await runWithRetry(label, fn);
    });
    try {
      await fn();
      setRetryAction(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : `${label}失败`;
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const onCreate = () =>
    runWithRetry("生成", async () => {
      if (!cid) throw new Error("请先选角色");
      const meta = {
        role: role.trim() || undefined,
        personality: personality.trim() || undefined,
        design_notes: designNotes.trim() || undefined,
        height_cm: Number(heightCm) > 0 ? Number(heightCm) : undefined,
      };
      const res: StudioCharacterSheetResult = await generateStudioCharacterSheet(cid, {
        style,
        ...meta,
        // 12:01:绝不默写 reference_images
        apply_to_video_refs: false,
      });
      setSheetUrl(res.sheet_url);
      setPanelUrls(res.panel_urls || {});
      toast.success(style === "anime" ? "二次元卡就绪" : "古风卡就绪");
      await refreshList();
      await onChanged?.();
    });

  const onRegenSelected = () =>
    runWithRetry("单格重生", async () => {
      if (!cid || !selectedKey) throw new Error("先点一格");
      if (locked[selectedKey]) throw new Error("该格已锁定");
      const meta = {
        role: role.trim() || undefined,
        personality: personality.trim() || undefined,
        design_notes: designNotes.trim() || undefined,
        height_cm: Number(heightCm) > 0 ? Number(heightCm) : undefined,
      };
      const res = await regenerateStudioCharacterSheetPanels(cid, {
        style,
        keys: [selectedKey],
        lock_from_sheet: true,
        ...meta,
        apply_to_video_refs: false,
      });
      setSheetUrl(res.sheet_url);
      setPanelUrls(res.panel_urls || {});
      toast.success(`${panelLabel(selectedKey)} 已重生成`);
      await refreshList();
      await onChanged?.();
    });

  const onPickUpload = () => {
    if (!selectedKey) {
      setError("先点一格再替换");
      return;
    }
    if (locked[selectedKey]) {
      setError("该格已锁定");
      return;
    }
    fileRef.current?.click();
  };

  const onFile = (file: File | undefined) => {
    if (!file || !selectedKey || !cid) return;
    void runWithRetry("替换", async () => {
      const buf = await file.arrayBuffer();
      const b64 = btoa(
        Array.from(new Uint8Array(buf), (c) => String.fromCharCode(c)).join(""),
      );
      const res = await replaceStudioCharacterSheetPanel(cid, {
        style,
        key: selectedKey,
        image_b64: b64,
      });
      setSheetUrl(res.sheet_url);
      setPanelUrls(res.panel_urls || {});
      toast.success(`${panelLabel(selectedKey)} 已替换`);
      await refreshList();
      await onChanged?.();
    });
  };

  const onExport = () => {
    if (!sheetUrl) {
      setError("暂无整卡");
      return;
    }
    const a = document.createElement("a");
    a.href = imageUrl(sheetUrl);
    a.download = `char_sheet_${character?.name || cid}_${style}.png`;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.click();
    toast.success("已导出");
  };

  const toggleLock = () => {
    if (!selectedKey) return;
    setLocked((prev) => ({ ...prev, [selectedKey]: !prev[selectedKey] }));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="角色设定卡"
      width={920}
      preventClose={!!busy}
      footer={
        <div className="studio-sheet-editor-footer">
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={onClose}>
            关闭
          </Button>
          <Button
            size="sm"
            disabled={!!busy || !cid}
            onClick={() => void onCreate()}
            data-testid="sheet-editor-create"
          >
            <Icon name={busy === "生成" ? "loading" : "sparkles"} size={12} />
            新建
          </Button>
        </div>
      }
    >
      <div className="studio-sheet-editor" data-testid="studio-sheet-editor">
        <div className="studio-sheet-editor-toolbar">
          <label className="studio-sheet-field">
            <span>角色</span>
            <select
              value={cid}
              disabled={!!busy}
              onChange={(e) => setCid(e.target.value)}
              data-testid="sheet-editor-character"
            >
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="studio-sheet-field">
            <span>风格</span>
            <select
              value={style}
              disabled={!!busy}
              onChange={(e) => setStyle(e.target.value as StudioCharacterSheetStyle)}
              data-testid="sheet-editor-style"
            >
              <option value="anime">二次元</option>
              <option value="ancient_realistic">古风</option>
            </select>
          </label>
          <label className="studio-sheet-field">
            <span>身高</span>
            <input
              type="number"
              min={140}
              max={200}
              value={heightCm}
              disabled={!!busy}
              onChange={(e) => setHeightCm(e.target.value)}
              data-testid="sheet-editor-height"
            />
          </label>
          <label className="studio-sheet-field studio-sheet-field-wide">
            <span>身份</span>
            <input
              type="text"
              value={role}
              disabled={!!busy}
              placeholder="便利店员"
              onChange={(e) => setRole(e.target.value)}
              data-testid="sheet-editor-role"
            />
          </label>
          <label className="studio-sheet-field studio-sheet-field-wide">
            <span>性格</span>
            <input
              type="text"
              value={personality}
              disabled={!!busy}
              placeholder="温柔果断"
              onChange={(e) => setPersonality(e.target.value)}
              data-testid="sheet-editor-personality"
            />
          </label>
          <label className="studio-sheet-field studio-sheet-field-notes">
            <span>设计说明</span>
            <textarea
              rows={2}
              value={designNotes}
              disabled={!!busy}
              placeholder="3–5 行，写入设定卡"
              onChange={(e) => setDesignNotes(e.target.value)}
              data-testid="sheet-editor-notes"
            />
          </label>
          <div className="studio-look-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!!busy || !selectedKey}
              onClick={() => void onRegenSelected()}
              data-testid="sheet-editor-regen"
              title="单格重生成"
            >
              <Icon name={busy === "单格重生" ? "loading" : "refresh"} size={12} />
              重生
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!!busy || !selectedKey}
              onClick={onPickUpload}
              data-testid="sheet-editor-replace"
              title="替换为上传图"
            >
              <Icon name="upload" size={12} />
              替换
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!selectedKey}
              onClick={toggleLock}
              data-testid="sheet-editor-lock"
              title="锁定格"
            >
              <Icon name="lock" size={12} />
              {selectedKey && locked[selectedKey] ? "已锁" : "锁定"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!sheetUrl}
              onClick={onExport}
              data-testid="sheet-editor-export"
              title="导出 PNG"
            >
              <Icon name="download" size={12} />
              导出
            </button>
          </div>
        </div>

        {error && (
          <div className="studio-sheet-editor-error">
            <ErrorBar message={error} onClose={() => setError(null)} />
            {retryAction && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void retryAction()}
                data-testid="sheet-editor-retry"
              >
                重试
              </Button>
            )}
          </div>
        )}

        <div className="studio-sheet-editor-body">
          <div className="studio-sheet-preview-wrap" data-testid="sheet-editor-preview">
            {sheetUrl ? (
              <div className="studio-sheet-preview-frame">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl(sheetUrl)} alt="设定卡" className="studio-sheet-preview-img" />
                {PANEL_HOTSPOTS.map((h) => {
                  const [x, y, w, hgt] = h.box;
                  const active = selectedKey === h.key;
                  const isLocked = !!locked[h.key];
                  return (
                    <button
                      key={h.key}
                      type="button"
                      className={`studio-sheet-hotspot${active ? " is-active" : ""}${isLocked ? " is-locked" : ""}`}
                      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${hgt * 100}%` }}
                      onClick={() => setSelectedKey(h.key)}
                      data-testid={`sheet-hotspot-${h.key}`}
                      title={h.label}
                    >
                      <span>{h.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="studio-sheet-preview-empty">选角色与风格后点「新建」</div>
            )}
          </div>
          <aside className="studio-sheet-side">
            <div className="studio-label">已有卡</div>
            <ul className="studio-sheet-list">
              {sheets.length === 0 && <li className="studio-muted">暂无</li>}
              {sheets.map((s) => (
                <li key={s.style}>
                  <button
                    type="button"
                    className={`studio-sheet-list-item${s.style === style ? " is-active" : ""}`}
                    onClick={() => {
                      setStyle(s.style);
                      setSheetUrl(s.sheet_url);
                      setPanelUrls(s.panel_urls || {});
                    }}
                  >
                    {s.style === "anime" ? "二次元" : "古风"}
                  </button>
                </li>
              ))}
            </ul>
            <div className="studio-label">当前格</div>
            <div className="studio-muted" data-testid="sheet-editor-selected">
              {panelLabel(selectedKey)}
              {selectedKey && locked[selectedKey] ? " · 已锁" : ""}
            </div>
            {selectedKey && panelUrls[selectedKey] && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl(panelUrls[selectedKey])}
                alt={panelLabel(selectedKey)}
                className="studio-sheet-cell-thumb"
              />
            )}
          </aside>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            onFile(f);
          }}
        />
      </div>
    </Modal>
  );
}

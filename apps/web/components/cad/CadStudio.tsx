"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useActivity } from "@/components/nav/ActivityContext";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useFauxProgress } from "@/hooks/useFauxProgress";
import { cadAxon, cadRender, cadUpload, imageUrl } from "@/lib/api";
import type { CadGeometry } from "@/lib/api";
import { trackJob } from "@/lib/trackJob";

interface OutputDef {
  key: string;
  label: string;
  control: boolean;
}

const OUTPUTS: OutputDef[] = [
  { key: "colored_plan", label: "彩平图", control: true },
  { key: "aerial_day", label: "航拍 · 日", control: true },
  { key: "aerial_dusk", label: "航拍 · 黄昏", control: true },
  { key: "aerial_night", label: "航拍 · 夜", control: true },
  { key: "interior", label: "室内实景", control: false },
  { key: "axon", label: "轴测 / 3D", control: true },
];

const STYLE_PRESETS = ["", "luxury", "old money", "minimalist", "industrial", "nordic", "modern"];
const STYLE_LABELS: Record<string, string> = {
  "": "默认",
  luxury: "轻奢",
  "old money": "老钱风",
  minimalist: "极简",
  industrial: "工业",
  nordic: "北欧",
  modern: "现代",
};

function sdxlDims(w: number, h: number): { w: number; h: number } {
  if (!w || !h) return { w: 1344, h: 768 };
  const long = 1344;
  if (w >= h) return { w: long, h: Math.max(512, Math.round((long * h) / w / 8) * 8) };
  return { w: Math.max(512, Math.round((long * w) / h / 8) * 8), h: long };
}

export function CadStudio() {
  const [controlUrl, setControlUrl] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<CadGeometry | null>(null);
  const [srcDims, setSrcDims] = useState({ w: 0, h: 0 });
  const [segments, setSegments] = useState(0);
  const [space, setSpace] = useState("modern data center facility");
  const [style, setStyle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const { setActivity, clearActivity } = useActivity();
  // 上传 + 服务端转换(DWG→几何→线稿)无中间进度 → 估算条给进度感
  const convertPct = useFauxProgress(uploading, 6000);

  useEffect(() => () => esRef.current?.close(), []);

  // 把本地出图态映射到灵动岛活动(全局可见):busy→running,结束→done 脉冲后收回。
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      const label = OUTPUTS.find((o) => o.key === busy)?.label ?? "生成设计图";
      const det = busy !== "axon" && progress !== null;
      setActivity({
        kind: "image",
        label,
        value: det ? progress : null,
        max: det ? 100 : null,
        phase: "running",
      });
      wasBusy.current = true;
    } else if (wasBusy.current) {
      wasBusy.current = false;
      setActivity({ kind: "image", label: "设计图完成", value: 100, max: 100, phase: "done" });
      const id = window.setTimeout(() => clearActivity(), 760);
      return () => window.clearTimeout(id);
    }
  }, [busy, progress, setActivity, clearActivity]);

  const onFile = useCallback(async (file: File) => {
    setUploading(true);
    setError(null);
    setResults({});
    setGeometry(null);
    try {
      const r = await cadUpload(file);
      setControlUrl(r.control_url);
      setGeometry(r.geometry);
      setSrcDims({ w: r.width, h: r.height });
      setSegments(r.n_segments);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }, []);

  const runOutput = useCallback(
    async (out: OutputDef) => {
      if (busy || !controlUrl) return;
      setBusy(out.key);
      setError(null);
      setProgress(null);
      try {
        if (out.key === "axon") {
          if (!geometry || (geometry.walls.length === 0 && geometry.racks.length === 0)) {
            throw new Error("此图无墙体/设备几何(图片输入无 3D)");
          }
          const r = await cadAxon(geometry);
          setResults((p) => ({ ...p, axon: imageUrl(r.url) }));
        } else {
          const dims = out.control ? sdxlDims(srcDims.w, srcDims.h) : { w: 1344, h: 768 };
          const res = await cadRender({
            control_url: controlUrl,
            preset: out.key,
            space,
            style,
            width: dims.w,
            height: dims.h,
          });
          const paths = await trackJob(res, {
            onProgress: (p) => setProgress(p.pct),
            register: (es) => {
              esRef.current = es;
            },
          });
          const first = paths[0];
          if (!first) throw new Error("没有产出图片");
          setResults((p) => ({ ...p, [out.key]: imageUrl(first) }));
        }
      } catch (e) {
        setError(`${out.label}:${(e as Error).message}`);
      } finally {
        setBusy(null);
        setProgress(null);
      }
    },
    [busy, controlUrl, geometry, srcDims, space, style],
  );

  const runAll = useCallback(async () => {
    for (const out of OUTPUTS) {
      if (out.key === "axon" && (!geometry || geometry.walls.length === 0)) continue;
      await runOutput(out);
    }
  }, [geometry, runOutput]);

  const busyLabel = busy ? OUTPUTS.find((o) => o.key === busy)?.label ?? "" : "";

  return (
    <div className="cad-studio">
      <header className="cad-head">
        <h2>
          工程图 → 设计 <span className="grad">AI 一键出全套</span>
        </h2>
        <p className="cad-sub">上传 DWG / DXF / 平面图 → 彩平图 · 4K 航拍 · 室内实景 · 轴测 3D,风格自由切换</p>
      </header>

      {error && <div className="alert cad-alert">⚠ {error}</div>}

      {!controlUrl ? (
        <div className="cad-upload">
          <label className={`cad-drop${uploading ? " busy" : ""}`}>
            <input
              type="file"
              accept=".dwg,.dxf,.png,.jpg,.jpeg,.webp"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = "";
              }}
            />
            <span className="cad-drop-icon" aria-hidden="true">
              ⊕
            </span>
            <span className="cad-drop-title">{uploading ? "解析图纸中…" : "上传图纸"}</span>
            <span className="cad-drop-hint">DWG / DXF / 平面图片,拖入或点击</span>
          </label>
          {uploading && (
            <ProgressBar
              active
              value={convertPct}
              tone="cool"
              label="解析图纸中…(DWG → 几何 → 线稿)"
              className="cad-convert-progress"
            />
          )}
        </div>
      ) : (
        <div className="cad-work">
          <aside className="cad-source">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl(controlUrl)} alt="转换线稿" className="cad-source-img" />
            <div className="cad-source-meta">
              {segments.toLocaleString()} 线段
              {geometry && geometry.w > 0 ? ` · 约 ${Math.round(geometry.w)}×${Math.round(geometry.h)}m` : ""}
            </div>
            <button
              type="button"
              className="manju-ghost-btn"
              onClick={() => {
                setControlUrl(null);
                setResults({});
              }}
            >
              ↻ 换图纸
            </button>
          </aside>

          <div className="cad-main">
            <div className="cad-controls">
              <div className="field">
                <label htmlFor="cad-space">空间类型</label>
                <input
                  id="cad-space"
                  value={space}
                  onChange={(e) => setSpace(e.target.value)}
                  placeholder="如:modern data center / luxury apartment / office"
                />
              </div>
              <div className="field">
                <label>风格</label>
                <div className="cad-styles">
                  {STYLE_PRESETS.map((s) => (
                    <button
                      key={s || "default"}
                      type="button"
                      className={style === s ? "active" : ""}
                      onClick={() => setStyle(s)}
                    >
                      {STYLE_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="cad-outputs">
              {OUTPUTS.map((out) => (
                <button
                  key={out.key}
                  type="button"
                  className="cad-out-btn"
                  disabled={!!busy}
                  aria-busy={busy === out.key}
                  onClick={() => void runOutput(out)}
                >
                  {busy === out.key ? "生成中…" : out.label}
                </button>
              ))}
              <button type="button" className="cad-out-btn primary" disabled={!!busy} onClick={() => void runAll()}>
                ⚡ 全套生成
              </button>
            </div>

            {busy && (
              <ProgressBar
                active
                tone="cool"
                value={busy === "axon" ? null : progress}
                label={busy === "axon" ? "渲染轴测体量…" : `正在生成「${busyLabel}」…`}
                className="cad-run-progress"
              />
            )}

            <div className="cad-gallery">
              {OUTPUTS.filter((o) => results[o.key]).map((o) => (
                <figure key={o.key} className="cad-result">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={results[o.key]} alt={o.label} loading="lazy" />
                  <figcaption>{o.label}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

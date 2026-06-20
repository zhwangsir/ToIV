"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PromptForm } from "@/components/generate/PromptForm";
import { ProgressBar } from "@/components/generate/ProgressBar";
import { ResultGallery } from "@/components/generate/ResultGallery";
import {
  generateTxt2img,
  imageUrl,
  jobEventsUrl,
  listModels,
} from "@/lib/api";
import type {
  GenResult,
  GenStatus,
  ModelsResponse,
  Progress,
  Txt2ImgParams,
} from "@/lib/types";

const DEFAULT_PARAMS: Txt2ImgParams = {
  positive: "",
  negative: "blurry, lowres, deformed, watermark",
  ckpt_name: "DreamShaper_8_pruned.safetensors",
  width: 512,
  height: 512,
  steps: 20,
  cfg: 7,
  sampler: "euler",
  scheduler: "normal",
};

export default function Home() {
  const [params, setParams] = useState<Txt2ImgParams>(DEFAULT_PARAMS);
  const [seedInput, setSeedInput] = useState("");
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [status, setStatus] = useState<GenStatus>("idle");
  const [progress, setProgress] = useState<Progress>({ value: 0, max: 0 });
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<GenResult[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    listModels()
      .then((m) => {
        setModels(m);
        // 用 ComfyUI 实际可用值校正默认项
        setParams((p) => ({
          ...p,
          ckpt_name: m.checkpoints[0] ?? p.ckpt_name,
        }));
      })
      .catch((e: Error) => setError(e.message));
    return () => esRef.current?.close();
  }, []);

  const patch = useCallback(
    (p: Partial<Txt2ImgParams>) => setParams((prev) => ({ ...prev, ...p })),
    [],
  );

  const onSubmit = useCallback(async () => {
    esRef.current?.close();
    doneRef.current = false;
    setError(null);
    setStatus("queued");
    setProgress({ value: 0, max: 0 });

    const seed = seedInput.trim() === "" ? null : Number(seedInput);

    try {
      const res = await generateTxt2img({ ...params, seed });
      setStatus("running");

      const es = new EventSource(
        jobEventsUrl(res.prompt_id, res.client_id, res.worker),
      );
      esRef.current = es;

      es.addEventListener("progress", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setProgress({ value: d.value ?? 0, max: d.max ?? 0 });
      });

      es.addEventListener("done", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        const shots: GenResult[] = (d.images as string[]).map((path, i) => ({
          id: `${res.prompt_id}-${i}`,
          url: imageUrl(path),
          prompt: params.positive,
          seed: res.seed,
          ckpt: params.ckpt_name,
        }));
        setResults((prev) => [...shots, ...prev]);
        doneRef.current = true;
        setStatus("idle");
        es.close();
      });

      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        if (data) {
          try {
            setError(JSON.parse(data).message);
          } catch {
            setError("生成出错");
          }
          setStatus("error");
          es.close();
        } else if (!doneRef.current) {
          setError("与服务器的连接中断");
          setStatus("error");
          es.close();
        }
      });
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }, [params, seedInput]);

  const busy = status === "queued" || status === "running";

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">
          To<span className="dot">IV</span>
        </span>
        <span className="tagline">AI 创作工作台 · ComfyUI 驱动</span>
        <span
          className={`status-pill${busy ? " is-busy" : ""}${
            status === "error" ? " is-error" : ""
          }`}
        >
          <span className="led" />
          {busy ? "运行中" : status === "error" ? "出错" : "就绪"}
        </span>
      </header>

      <div className="studio">
        <PromptForm
          params={params}
          models={models}
          busy={busy}
          seedInput={seedInput}
          onPatch={patch}
          onSeedInput={setSeedInput}
          onSubmit={onSubmit}
        />

        <main className="stage">
          <ProgressBar status={status} progress={progress} />
          {error && <div className="alert">⚠ {error}</div>}
          <div className="stage-head">
            <h2>作品</h2>
            <span className="count">{results.length} 张</span>
          </div>
          <ResultGallery results={results} />
        </main>
      </div>
    </div>
  );
}

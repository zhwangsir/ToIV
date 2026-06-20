"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { PromptForm } from "@/components/generate/PromptForm";
import { ProgressBar } from "@/components/generate/ProgressBar";
import { ResultGallery } from "@/components/generate/ResultGallery";
import { AdminPanel } from "@/components/admin/AdminPanel";
import { LibraryView } from "@/components/library/LibraryView";
import { ModelLibrary } from "@/components/models/ModelLibrary";
import { ThreeDStudio } from "@/components/threed/ThreeDStudio";
import { VideoStudio } from "@/components/video/VideoStudio";
import {
  fetchMe,
  generateImg2img,
  generateTxt2img,
  getToken,
  imageUrl,
  jobEventsUrl,
  listModels,
  setToken,
  uploadImage,
} from "@/lib/api";
import type { AuthResult } from "@/lib/api";
import type {
  GenMode,
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

type AuthState = "loading" | "in" | "out";

type View = "image" | "video" | "threed" | "library" | "models" | "admin";

interface Account {
  email: string;
  role: string;
  usageTotal: number;
}

export default function Home() {
  const [auth, setAuth] = useState<AuthState>("loading");
  const [account, setAccount] = useState<Account | null>(null);

  const [view, setView] = useState<View>("image");
  const [params, setParams] = useState<Txt2ImgParams>(DEFAULT_PARAMS);
  const [seedInput, setSeedInput] = useState("");
  const [mode, setMode] = useState<GenMode>("txt2img");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [denoise, setDenoise] = useState(0.6);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [status, setStatus] = useState<GenStatus>("idle");
  const [progress, setProgress] = useState<Progress>({ value: 0, max: 0 });
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<GenResult[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const doneRef = useRef(false);

  // 启动时校验已存令牌
  useEffect(() => {
    if (!getToken()) {
      setAuth("out");
      return;
    }
    fetchMe()
      .then((me) => {
        setAccount({ email: me.user.email, role: me.user.role, usageTotal: me.usage.total });
        setAuth("in");
      })
      .catch(() => {
        setToken(null);
        setAuth("out");
      });
  }, []);

  // 登录后加载模型
  useEffect(() => {
    if (auth !== "in") return;
    listModels()
      .then((m) => {
        setModels(m);
        setParams((p) => ({ ...p, ckpt_name: m.checkpoints[0] ?? p.ckpt_name }));
      })
      .catch((e: Error) => setError(e.message));
    return () => esRef.current?.close();
  }, [auth]);

  // 源图预览（对象 URL 需回收）
  useEffect(() => {
    if (!imageFile) {
      setImagePreview(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  const onAuthed = useCallback((result: AuthResult) => {
    setAccount({ email: result.user.email, role: result.user.role, usageTotal: 0 });
    setAuth("in");
    fetchMe()
      .then((me) =>
        setAccount({ email: me.user.email, role: me.user.role, usageTotal: me.usage.total }),
      )
      .catch(() => {});
  }, []);

  const onLogout = useCallback(() => {
    esRef.current?.close();
    setToken(null);
    setAccount(null);
    setResults([]);
    setModels(null);
    setAuth("out");
  }, []);

  const patch = useCallback(
    (p: Partial<Txt2ImgParams>) => setParams((prev) => ({ ...prev, ...p })),
    [],
  );

  const onSubmit = useCallback(
    async (overridePositive?: string) => {
      const positive = (overridePositive ?? params.positive).trim();
      if (!positive) return;
      if (overridePositive) patch({ positive: overridePositive });

      esRef.current?.close();
      doneRef.current = false;
      setError(null);
      setStatus("queued");
      setProgress({ value: 0, max: 0 });

      const seed = seedInput.trim() === "" ? null : Number(seedInput);

      try {
        let res;
        if (mode === "img2img") {
          if (!imageFile) {
            setError("请先上传图片");
            setStatus("error");
            return;
          }
          const up = await uploadImage(imageFile);
          res = await generateImg2img({
            positive,
            negative: params.negative,
            ckpt_name: params.ckpt_name,
            image: up.filename,
            worker: up.worker,
            denoise,
            steps: params.steps,
            cfg: params.cfg,
            sampler: params.sampler,
            scheduler: params.scheduler,
            seed,
          });
        } else {
          res = await generateTxt2img({ ...params, positive, seed });
        }
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
            prompt: positive,
            seed: res.seed,
            ckpt: params.ckpt_name,
          }));
          setResults((prev) => [...shots, ...prev]);
          setAccount((a) => (a ? { ...a, usageTotal: a.usageTotal + 1 } : a));
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
    },
    [params, seedInput, patch, mode, imageFile, denoise],
  );

  const busy = status === "queued" || status === "running";

  const navItems: { key: string; label: string; view?: View; active: boolean }[] = [
    { key: "image", label: "图像", view: "image", active: true },
    { key: "video", label: "视频", view: "video", active: true },
    { key: "models", label: "模型", view: "models", active: true },
    { key: "3d", label: "3D", view: "threed", active: true },
    { key: "library", label: "作品库", view: "library", active: true },
    ...(account?.role === "admin"
      ? [{ key: "admin", label: "管理", view: "admin" as View, active: true }]
      : []),
    { key: "audio", label: "音频", active: false },
  ];

  if (auth === "loading") {
    return (
      <div className="splash">
        <div className="hero-orb" aria-hidden="true" />
      </div>
    );
  }

  if (auth === "out") {
    return <AuthScreen onAuthed={onAuthed} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">
          To<span className="mark">IV</span>
          <span className="sub">极光 · AI 创作平台</span>
        </span>

        <nav className="modal-nav" aria-label="模块导航">
          {navItems.map((m) => (
            <button
              key={m.key}
              type="button"
              className={m.view && view === m.view ? "active" : ""}
              disabled={!m.active}
              onClick={() => m.view && setView(m.view)}
              aria-current={m.view && view === m.view ? "page" : undefined}
            >
              {m.label}
              {!m.active && <span className="soon">soon</span>}
            </button>
          ))}
        </nav>

        <div className="account">
          <span
            className={`status-pill${busy ? " is-busy" : ""}${
              status === "error" ? " is-error" : ""
            }`}
          >
            <span className="led" />
            {busy ? "运行中" : status === "error" ? "出错" : "就绪"}
          </span>
          <span className="user-chip" title={account?.email}>
            {account?.email}
            <em>{account?.usageTotal ?? 0} 次生成</em>
          </span>
          <button type="button" className="logout" onClick={onLogout}>
            退出
          </button>
        </div>
      </header>

      {view === "admin" ? (
        <div className="single-view">
          <AdminPanel />
        </div>
      ) : view === "library" ? (
        <div className="single-view">
          <LibraryView />
        </div>
      ) : view === "models" ? (
        <div className="single-view">
          <ModelLibrary />
        </div>
      ) : view === "video" ? (
        <VideoStudio />
      ) : view === "threed" ? (
        <ThreeDStudio />
      ) : (
        <div className="studio">
          <PromptForm
            params={params}
            models={models}
            busy={busy}
            seedInput={seedInput}
            mode={mode}
            denoise={denoise}
            imagePreview={imagePreview}
            onModeChange={setMode}
            onImageChange={setImageFile}
            onDenoise={setDenoise}
            onPatch={patch}
            onSeedInput={setSeedInput}
            onSubmit={onSubmit}
          />

          <main className="stage">
            <div className="stage-head">
              <h1>
                创作 <span className="grad">图像</span>
              </h1>
              <span className="count">{results.length} 张作品</span>
            </div>
            <ProgressBar status={status} progress={progress} />
            {error && <div className="alert">⚠ {error}</div>}
            <ResultGallery results={results} onExample={(t) => onSubmit(t)} />
          </main>
        </div>
      )}
    </div>
  );
}

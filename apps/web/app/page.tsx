"use client";

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { LandingPage } from "@/components/landing/LandingPage";
import { NAV_LABELS } from "@/lib/navLabels";
import { fetchMe, getToken, setToken, testLogin, TOKEN_KEY } from "@/lib/api";
import { useCrossTabSync } from "@/lib/crossTab";
import { initR18Mode, useR18Mode } from "@/lib/r18";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { LoadingBlock } from "@/components/ui/LoadingBlock";

type AuthState = "loading" | "in" | "out";

/** F12 薄壳(2026-10-15,D-U1=A):web 只保留 ①未登录落地/登录 ②F9 首页跳转壳
 *  ③R18/NSFW 薄壳面(image/video 引擎台——NSFW 引擎无 canvas 对应)与三条逃生口
 *  (?classic=1 / R18 深链 / EXTERNAL 深链)④数字人下架说明。
 *  助手/命令面板/任务中心/侧栏底栏/作品库/市场/设置/工作室台等第二套壳已随
 *  F9-F11 收编进 canvas(/studio),对应组件与视图在本批物理删除。 */
type View = "home" | "image" | "video" | "avatartalk";

/** M1 三大板块拆分遗留:旧 key 按语义归位(不 404)。 */
const LEGACY_VIEW_REDIRECTS: Record<string, View> = {
  create: "image",
  generate: "image",
  ltxstudio: "video",
  // S12 退役:fusion→home(经典回落面板);canvas→home(canvas 应用经 /studio)
  fusion: "home",
  canvas: "home",
  // F12:home 助手面下线,旧助手深链落经典回落面板
  assistant: "home",
  home: "home",
};

/** 融合 F1-F11 退役视图深链:整页跳 canvas 对应页(EXTERNAL 逃生口,自带 location.replace)。
 *  F12 追加:market/library 面物理删除后深链无条件跳 canvas(canvas 已具 R18 门控,
 *  services/toiv/r18-mode + X-NSFW 头);agent-runs 任务中心深链跳 canvas 任务页(F2)。 */
const EXTERNAL_VIEW_REDIRECTS: Record<string, string> = {
  studio: "/studio/toiv/drama",
  // F3(2026-10-11):animatic 退役——AI 解析入口=canvas 短剧列表「从图片创建」(StudioProject 域)
  animatic: "/studio/toiv/drama",
  // F4(2026-10-11):audio 退役——三工具(配音/听写/分离)迁 canvas /toiv/audio;文生音乐走应用市场
  audio: "/studio/toiv/audio",
  // F5(2026-10-11):imageEdit 退役——七工具迁 canvas /toiv/image-tools
  imageEdit: "/studio/toiv/image-tools",
  "image-edit": "/studio/toiv/image-tools",
  // F6(2026-10-12):videoEdit 退役——三轨剪辑迁 canvas /toiv/video-tools
  videoEdit: "/studio/toiv/video-tools",
  "video-edit": "/studio/toiv/video-tools",
  // F7(2026-10-12):dub 退役——五步译制链迁 canvas /toiv/dub-tools
  dub: "/studio/toiv/dub-tools",
  entities: "/studio/toiv/drama",
  resources: "/studio/settings?section=channels",
  dramaStudio: "/studio/toiv/drama",
  manju: "/studio/toiv/drama",
  drama: "/studio/toiv/drama",
  models: "/studio/settings?section=channels",
  train: "/studio/settings?section=channels",
  backlot: "/studio/settings?section=channels",
  // F8/F11:市场与作品库面已删(分页市场=canvas market-page;作品/回收站/检索=library-works)
  market: "/studio/toiv/market",
  skills: "/studio/toiv/market",
  apps: "/studio/toiv/market",
  library: "/studio/toiv/library",
  // F2/F12:任务中心面已删(运行台=canvas /toiv/tasks)
  tasks: "/studio/toiv/tasks",
};

/** 解析 ?view= 参数:旧 key 走重定向,非法 key 返回 null(落默认视图)。 */
function resolveView(raw: string | null): View | null {
  if (!raw) return null;
  const redirected = LEGACY_VIEW_REDIRECTS[raw];
  if (redirected) return redirected;
  return VALID_VIEWS.has(raw as View) ? (raw as View) : null;
}

// ── R18/NSFW 薄壳面:图片/视频引擎台(懒加载;NSFW 引擎由后端按 X-NSFW 上下文放行,
//    canvas /create 无 ToIV 引擎注册表直连,NSFW 引擎生成的唯一入口保留在此) ──
const EngineStudioView = lazy(() =>
  import("@/components/studio/EngineStudioView").then((m) => ({ default: m.EngineStudioView })),
);

/** 视图切换加载占位:统一走共享 LoadingBlock(P1-2 收编),保留 role/aria 状态语义。 */
function ViewFallback({ label }: { label: string }) {
  return (
    <div className="view-fallback" role="status" aria-label={`${label}加载中`}>
      <LoadingBlock variant="line" count={3} />
    </div>
  );
}

const VALID_VIEWS = new Set<View>(["home", "image", "video", "avatartalk"]);

const VIEW_META: Record<View, { label: string }> = {
  home: { label: NAV_LABELS.home },
  image: { label: NAV_LABELS.image },
  video: { label: NAV_LABELS.video },
  avatartalk: { label: "数字人" },
};

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="splash">
          <div className="splash-orb" aria-hidden="true" />
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [auth, setAuth] = useState<AuthState>("loading");
  const [account, setAccount] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => {
    const raw = searchParams.get("view");
    if (raw === "assistant") return "home"; // 旧助手链接落经典回落面板(助手面已迁 canvas /toiv/agent)
    return resolveView(raw) ?? "home";
  });
  // M9:订阅全局 R18 内容模式(逃生口/深链按此 computed)
  const [r18] = useR18Mode();

  // BeefTV studio 切换(2026-10-06 cutover C3 → 2026-10-15 F9 跳转壳):登录态落 home
  // 默认整页切到 /studio/(BeefTV UI),切换期间渲染跳转壳、不再渲染第二套助手对话面;
  // 失败/超时/关闭/非管理员 exchange 403 → 回落经典薄壳(fail-safe,不锁死),
  // ?classic=1 与 R18 模式显式绕过(R18 上下文的引擎台家在经典壳)
  const [studioHandoffFailed, setStudioHandoffFailed] = useState(false);
  const studioProbeRef = useRef(false);
  useEffect(() => {
    if (auth !== "in" || view !== "home") return;
    if (studioProbeRef.current) return;
    if (typeof window === "undefined") return;
    if (window.location.search.includes("classic=1")) return;
    if (r18) return;
    // F1:深链正被 EXTERNAL_VIEW_REDIRECTS 整页接走时不再探测——两个 location.replace
    // 会竞态(cutover 的异步 replace 可能盖掉深链目标,?view=studio 实测撞过)。
    const rawView = new URLSearchParams(window.location.search).get("view");
    if (rawView && EXTERNAL_VIEW_REDIRECTS[rawView]) return;
    studioProbeRef.current = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    fetch("/studio/entry.json", { cache: "no-store", signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || !j.enabled) {
          setStudioHandoffFailed(true); // studio 关闭(回滚态)→ 回落经典薄壳
          return;
        }
        // M4-4 Phase C:跳转前把 ToIV JWT 换成 /studio 会话 cookie——URL 型访问
        // (画布图片/下载/EventSource 无法带 Authorization)依赖它经 canvas-api 直验。
        // 2026-10-08 止血:交换成功(仅管理员,非管理员 403)才跳转;先等 cookie 落地,
        // 否则 /studio 页面闸看不到会话会把人弹回首页。
        const t = getToken();
        if (!t) {
          setStudioHandoffFailed(true);
          return;
        }
        return fetch("/studio/auth/exchange", { method: "POST", headers: { authorization: `Bearer ${t}` } }).then((r) => {
          if (r.ok) window.location.replace("/studio/");
          else setStudioHandoffFailed(true); // 非管理员 403 → 回落经典,零回退
        });
      })
      .catch(() => setStudioHandoffFailed(true))
      .finally(() => clearTimeout(timer));
  }, [auth, view, r18]);

  useEffect(() => {
    const raw = searchParams.get("view");
    // F1/F12:退役视图与市场/库/任务深链整体跳 canvas(整页替换,不留在薄壳里打转)
    const ext = EXTERNAL_VIEW_REDIRECTS[raw ?? ""];
    if (ext) {
      window.location.replace(ext);
      return;
    }
    const resolved = resolveView(raw);
    if (resolved && resolved !== view) {
      setView(resolved);
    }
    // 旧 key(create/generate/ltxstudio/assistant 等)重定向后把 URL 规整为新 key,
    // 刷新/分享保持一致
    if (raw && LEGACY_VIEW_REDIRECTS[raw]) {
      router.replace(`/?view=${resolved ?? "home"}`);
    }
  }, [searchParams, view, router]);

  useEffect(() => {
    // M9:fetchMe 之前恢复 R18 模式(仅同步 X-NSFW 请求头标记,不清缓存不广播)
    initR18Mode();
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const t = params.get("t");
      const testkey = params.get("testkey");
      if (t || testkey) {
        try {
          if (t) setToken(t);
          else if (testkey) setToken((await testLogin(testkey)).token);
        } catch {
          /* 通道失败落回登录 */
        }
        params.delete("t");
        params.delete("testkey");
        const qs = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
      }

      if (!getToken()) {
        setAuth("out");
        return;
      }
      // 会话探测:401/403 立即出局;5xx/超时/网络抖动属瞬时故障,短退避重试两次,
      // 避免后端重启/代理抖动把有效会话误踢到登录页(authed E2E 首跳 flaky 同源)。
      const isAuthErr = (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return msg.includes("会话已过期") || msg.includes("401");
      };
      for (let attempt = 0; ; attempt++) {
        try {
          const me = await fetchMe();
          setAccount(me.user.email);
          setAuth("in");
          return;
        } catch (err) {
          if (isAuthErr(err)) {
            fetch("/studio/auth/logout", { method: "POST", keepalive: true }).catch(() => {});
            setToken(null);
            setAuth("out");
            return;
          }
          if (attempt >= 2) {
            setAuth("out");
            return;
          }
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
    })();
  }, []);

  // P1-8 跨标签页登录态同步:他页退出登录(token 被删)→ 本页立即回落登录页;
  // 他页登录成功(token 写入)→ 本页探测会话并刷新用户态,避免「A 页退出、B 页
  // 还以为已登录」的状态孤岛。
  useCrossTabSync(TOKEN_KEY, (newValue) => {
    if (!newValue) {
      setAccount(null);
      setAuth("out");
      return;
    }
    fetchMe()
      .then((me) => {
        setAccount(me.user.email);
        setAuth("in");
      })
      .catch(() => {
        // 他页写入的 token 探测失败(过期/被顶号):按未登录处理
        setToken(null);
        setAccount(null);
        setAuth("out");
      });
  });

  const meta = VIEW_META[view];

  if (auth === "loading") {
    return (
      <div className="splash">
        <div className="splash-orb" aria-hidden="true" />
      </div>
    );
  }

  if (auth === "out") {
    return <LandingPage />;
  }

  // F9 跳转壳(2026-10-15):登录态 home = 整页切 /studio,切换期间不渲染第二套助手
  // 对话面(F12 薄壳:SideRail/⌘K/浮层/HomeView 已物理下线)。回落经典薄壳的条件:
  // ①handoff 失败(studio 关闭/非管理员 exchange 403/网络故障,fail-safe 不锁死);
  // ②?classic=1 显式逃生口;③R18 模式(R18 引擎台深链家在经典壳);
  // ④正被 EXTERNAL_VIEW_REDIRECTS 整页接走的深链(那边自带 location.replace)。
  const rawViewParam = searchParams.get("view");
  const homeHandoffPending =
    auth === "in" &&
    view === "home" &&
    !studioHandoffFailed &&
    searchParams.get("classic") !== "1" &&
    !r18 &&
    !(rawViewParam !== null && Boolean(EXTERNAL_VIEW_REDIRECTS[rawViewParam]));
  if (homeHandoffPending) {
    return (
      <div className="splash splash-handoff" role="status" aria-label="正在进入创作工作室">
        <div className="splash-orb" aria-hidden="true" />
        <p className="splash-handoff-text">正在进入创作工作室…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <main id="main" className="app-main">
        <div className="view-root view-stage">
          <ErrorBoundary key={view} viewName={meta.label}>
            <Suspense fallback={<ViewFallback label={meta.label} />}>
              {/* F12 经典回落面板:仅在 handoff 失败/?classic=1/R18 模式到达;
                  提供重试、退出与 R18/NSFW 薄壳面(引擎台)深链 */}
              {view === "home" && (
                <div className="decommission-note" role="status">
                  <h2>经典模式(薄壳)</h2>
                  <p>
                    主界面已迁入创作工作室(/studio)。当前处于经典回落
                    {studioHandoffFailed ? "(工作室暂不可用或非管理员会话)" : "(?classic=1 或 R18 模式)"}
                    {account ? `,账户 ${account}` : ""}。
                  </p>
                  <p className="thin-shell-links">
                    <a href="/?view=image">{NAV_LABELS.image}</a>
                    <a href="/?view=video">{NAV_LABELS.video}</a>
                    <a href="/studio/toiv/library">作品库(canvas)</a>
                    <a href="/studio/toiv/market">工具箱(canvas)</a>
                    <a href="/studio/toiv/tasks">任务(canvas)</a>
                    {!studioHandoffFailed && (
                      <button type="button" onClick={() => window.location.replace("/studio/")}>
                        进入创作工作室
                      </button>
                    )}
                    {studioHandoffFailed && (
                      <button type="button" onClick={() => window.location.reload()}>
                        重试进入工作室
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        fetch("/studio/auth/logout", { method: "POST", keepalive: true }).catch(() => {});
                        setToken(null);
                        setAccount(null);
                        setAuth("out");
                      }}
                    >
                      退出登录
                    </button>
                  </p>
                </div>
              )}
              {/* R18/NSFW 薄壳面:图片/视频引擎台(NSFW 引擎经 X-NSFW 上下文由后端放行) */}
              {view === "image" && <EngineStudioView kind="image" />}
              {view === "video" && <EngineStudioView kind="video" />}
              {/* U1(2026-10-14):opentalking 数字人栈下架——深链落此说明页 */}
              {view === "avatartalk" && (
                <div className="decommission-note" role="status">
                  <h2>数字人功能已下架</h2>
                  <p>
                    opentalking 数字人引擎已于 2026-10-14 下架(资源优先短剧创作与视频内容)。
                    成片类说话人视频仍可用「视频生成」或创作工作室的数字人分镜完成。
                  </p>
                </div>
              )}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

"use client";

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";

import { LandingPage } from "@/components/landing/LandingPage";
import { CornerNav, type CornerNavItem } from "@/components/nav/CornerNav";
import { AccountButton } from "@/components/nav/AccountButton";
import { TaskCenter } from "@/components/nav/TaskCenter";
import { AssistantOverlay } from "@/components/assistant/AssistantOverlay";
import { BottomNav, type BottomNavItem } from "@/components/nav/BottomNav";
import { fetchMe, getToken, setToken, testLogin, TOKEN_KEY } from "@/lib/api";
import { useCrossTabSync } from "@/lib/crossTab";
import { initR18Mode, isR18Mode, useR18Mode } from "@/lib/r18";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Empty } from "@/components/ui/Empty";
import { Icon } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { useToast } from "@/components/ui/Toast";

// assistant.css 随主包 eager 加载(2026-08-23):它同时是 .neon-edge 灯带与
// .av-overlay 浮层样式的唯一来源;若只由懒加载的 AssistantView 引入,
// 首次 Shift+Enter 时 CSS chunk 尚未到达,灯带整段隐形(修复前实测首开无光)。
import "@/app/styles/assistant.css";

type AuthState = "loading" | "in" | "out";

// 霓虹边缘动画(2026-08-18)的角度插值注册:CSS.registerProperty 让
// --neon-angle 可动画(等价 CSS @property,但可在 JS 侧 try/catch 容错)。
// 不支持的内核此调用不存在 → page.tsx 快捷键探测 "registerProperty" in CSS
// 直接跳过动画;重复注册(hmr)静默忽略。
if (typeof window !== "undefined" && "registerProperty" in CSS) {
  try {
    CSS.registerProperty({
      name: "--neon-angle",
      syntax: "<angle>",
      inherits: false,
      initialValue: "0deg",
    });
    // 阶段一核点雷达弧的扫描角(同 --neon-angle,rAF 内联驱动)
    CSS.registerProperty({
      name: "--core-sweep",
      syntax: "<angle>",
      inherits: false,
      initialValue: "0deg",
    });
  } catch {
    /* 已注册/hmr 重复,忽略 */
  }
}

// ── AI 助手启动序列·设计参数表(2026-08-24 重做:极光双色 #22d3ee→#a78bfa) ──
// 阶段一「核心点亮」  0–350ms :视口中心核点(cyan)脉冲成环 + 雷达弧扫描一圈
// 阶段二「灯带扫边」  0–1000ms:neon-edge 双色极光 conic 扫 430deg,easeInOutQuart,
//                               扫边同时中心核淡出(与阶段一同场融合)
// 阶段三「弹窗降临」 700–1100ms:灯带收尾前 300ms 起播,面板 scale .92→1 + 淡入
//                               (400ms cubic-bezier(.22,1,.36,1),assistant.css)
// 关闭 200ms ease-in(scale→.96 + 淡出,assistant.css 方向性 transition);
// 全程再按 Shift+Enter/Esc 可跳过(直开),prefers-reduced-motion 一切直开
const NEON_MS = 1000; // 阶段二:灯带扫边总时长(提速自 1400ms)
const NEON_SWEEP_DEG = 430; // 扫满一圈并过冲 70deg,让软尾滑过终点
const NEON_CORE_MS = 350; // 阶段一:核点点亮时长
const NEON_PANEL_LEAD_MS = 300; // 阶段三:弹窗相对灯带收尾的提前量(700ms 处起播)

type View =
  | "assistant"
  | "image"
  | "video"
  | "audio"
  | "fusion"
  | "imageEdit"
  | "videoEdit"
  | "animatic"
  | "avatartalk"
  | "canvas"
  | "studio"
  | "dub"
  | "train"
  | "library"
  | "entities"
  | "backlot"
  | "models"
  | "resources"
  | "skills"
  | "settings"
  | "drama"
  | "observability"
  | "admin";

/** M1 三大板块拆分:generate 退役拆为 图片/视频/音频,旧链接按 kind 重定向(不 404)。
 *  M4 studio 替代短剧/漫剧:旧 key 一律重定向到 studio。 */
const LEGACY_VIEW_REDIRECTS: Record<string, View> = {
  create: "image",
  generate: "image",
  ltxstudio: "video",
  dramaStudio: "studio",
  manju: "studio",
  "video-edit": "videoEdit",
  "image-edit": "imageEdit",
};

/** 解析 ?view= 参数:旧 key 走重定向,非法 key 返回 null(落默认视图)。 */
function resolveView(raw: string | null): View | null {
  if (!raw) return null;
  const redirected = LEGACY_VIEW_REDIRECTS[raw];
  if (redirected) return redirected;
  return VALID_VIEWS.has(raw as View) ? (raw as View) : null;
}

// ── 视图懒加载:chunk 按需拉取;灵动岛悬停/聚焦期间并行预热,消除切换白屏等待 ──
const viewImporters = {
  // assistant 已底层化为 Shift+Enter 浮层(非视图),importer 保留仅维持 View 类型索引完整性
  assistant: () => import("@/components/assistant/AssistantView"),
  // 图片/视频共用 GenerateView chunk;音频走 AudioView(内嵌 GenerateView,webpack 共享 chunk)
  image: () => import("@/components/generate/GenerateView"),
  video: () => import("@/components/generate/GenerateView"),
  audio: () => import("@/components/audio/AudioView"),
  fusion: () => import("@/components/fusion/FusionView"),
  imageEdit: () => import("@/components/image-edit/ImageEditView"),
  videoEdit: () => import("@/components/video-edit/VideoEditView"),
  animatic: () => import("@/components/animatic/AnimaticView"),
  avatartalk: () => import("@/components/avatartalk/AvatarTalkView"),
  canvas: () => import("@/components/canvas/CanvasView"),
  studio: () => import("@/components/studio/StudioView"),
  dub: () => import("@/components/dub/DubView"),
  train: () => import("@/components/train/TrainView"),
  library: () => import("@/components/library/LibraryView"),
  entities: () => import("@/components/entities/EntitiesView"),
  backlot: () => import("@/components/backlot/BacklotView"),
  models: () => import("@/components/models/ModelsView"),
  resources: () => import("@/components/resources/ResourcesView"),
  skills: () => import("@/components/skills/SkillMarketView"),
  settings: () => import("@/components/settings/SettingsView"),
  drama: () => import("@/components/drama/DramaView"),
  observability: () => import("@/components/observability/ObservabilityView"),
  admin: () => import("@/components/admin/AdminView"),
} as const;

/** 预热目标视图 chunk。webpack 模块缓存去重,重复/并发调用零额外开销。 */
function preloadView(key: View) {
  viewImporters[key]().catch(() => {
    /* 预热失败不阻塞:点击时 lazy 会重新发起加载 */
  });
}

const GenerateView = lazy(() =>
  viewImporters.image().then((m) => ({ default: m.GenerateView })),
);
const AudioView = lazy(() =>
  viewImporters.audio().then((m) => ({ default: m.AudioView })),
);
const FusionView = lazy(() =>
  viewImporters.fusion().then((m) => ({ default: m.FusionView })),
);
const ImageEditView = lazy(() =>
  viewImporters.imageEdit().then((m) => ({ default: m.ImageEditView })),
);
const VideoEditView = lazy(() =>
  viewImporters.videoEdit().then((m) => ({ default: m.VideoEditView })),
);
const AnimaticView = lazy(() =>
  viewImporters.animatic().then((m) => ({ default: m.AnimaticView })),
);
const AvatarTalkView = lazy(() =>
  viewImporters.avatartalk().then((m) => ({ default: m.AvatarTalkView })),
);
const CanvasView = lazy(() =>
  viewImporters.canvas().then((m) => ({ default: m.CanvasView })),
);
const StudioView = lazy(() =>
  viewImporters.studio().then((m) => ({ default: m.StudioView })),
);
const DubView = lazy(() =>
  viewImporters.dub().then((m) => ({ default: m.DubView })),
);
const TrainView = lazy(() =>
  viewImporters.train().then((m) => ({ default: m.TrainView })),
);
const LibraryView = lazy(() =>
  viewImporters.library().then((m) => ({ default: m.LibraryView })),
);
const EntitiesView = lazy(() =>
  viewImporters.entities().then((m) => ({ default: m.EntitiesView })),
);
const BacklotView = lazy(() =>
  viewImporters.backlot().then((m) => ({ default: m.BacklotView })),
);
const ModelsView = lazy(() =>
  viewImporters.models().then((m) => ({ default: m.ModelsView })),
);
const ResourcesView = lazy(() =>
  viewImporters.resources().then((m) => ({ default: m.ResourcesView })),
);
const SkillMarketView = lazy(() =>
  viewImporters.skills().then((m) => ({ default: m.SkillMarketView })),
);
const SettingsView = lazy(() =>
  viewImporters.settings().then((m) => ({ default: m.SettingsView })),
);
const DramaView = lazy(() =>
  viewImporters.drama().then((m) => ({ default: m.DramaView })),
);
const AdminView = lazy(() =>
  viewImporters.admin().then((m) => ({ default: m.AdminView })),
);
const ObservabilityView = lazy(() =>
  viewImporters.observability().then((m) => ({ default: m.ObservabilityView })),
);

/** 视图切换加载占位:统一走共享 LoadingBlock(P1-2 收编),保留 role/aria 状态语义。 */
function ViewFallback({ label }: { label: string }) {
  return (
    <div className="view-fallback" role="status" aria-label={`${label}加载中`}>
      <LoadingBlock variant="line" count={3} />
    </div>
  );
}

// 旧视图 key(models/train/backlot/admin)保留兼容,旧链接不 404;
// create/generate/ltxstudio/dramaStudio/manju 不在此列——经 LEGACY_VIEW_REDIRECTS 重定向;
// assistant 已底层化(2026-08-17):移出 VALID_VIEWS,URL ?view=assistant 在挂载 effect 中重定向 fusion
const VALID_VIEWS = new Set<View>([
  "image",
  "video",
  "audio",
  "fusion",
  "imageEdit",
  "videoEdit",
  "animatic",
  "avatartalk",
  "canvas",
  "studio",
  "dub",
  "train",
  "library",
  "entities",
  "backlot",
  "models",
  "resources",
  "skills",
  "settings",
  "drama",
  "observability",
  "admin",
]);

const VIEW_META: Record<View, { label: string }> = {
  assistant: { label: "对话" },
  image:     { label: "图片" },
  video:     { label: "视频" },
  audio:     { label: "音频" },
  fusion:    { label: "融合" },
  imageEdit: { label: "图片编辑" },
  videoEdit: { label: "视频剪辑" },
  animatic:  { label: "动态分镜" },
  avatartalk: { label: "数字人" },
  canvas:    { label: "画布" },
  studio:    { label: "创作" },
  dub:       { label: "译制" },
  train:     { label: "训练" },
  library:    { label: "作品库" },
  entities:   { label: "主体库" },
  backlot:    { label: "看板" },
  models:     { label: "模型" },
  resources:  { label: "资源" },
  skills:     { label: "Skill 市场" },
  settings:   { label: "设置" },
  drama:     { label: "短剧" },
  observability: { label: "观测" },
  admin:     { label: "管理" },
};

/** M3 新 IA 一级入口:三大板块 + 融合聚合页;短剧/数字人/译制移入融合,视图保留(旧链接不 404)。
 *  2026-08-17 底层化:AI 助手移出导航,由 Shift+Enter 全局浮层(AssistantOverlay)唤起。
 *  2026-08-18:Agent 团队入口改为 Skill 市场(/agent-runs 路由保留,直达 URL 仍可访问)。
 *  桌面端由左上角悬停展开导航(CornerNav)承载,窄屏由底部导航承载。 */
const ISLAND_ITEMS: CornerNavItem[] = [
  { key: "skills", label: "Skill 市场", icon: "package" },
  { key: "image", label: "图片", icon: "image" },
  { key: "video", label: "视频", icon: "video" },
  { key: "audio", label: "音频", icon: "audio" },
  { key: "fusion", label: "融合", icon: "sparkles" },
  { key: "canvas", label: "画布", icon: "workflow" },
  { key: "library", label: "作品库", icon: "library" },
  { key: "entities", label: "主体库", icon: "users" },
  { key: "resources", label: "资源", icon: "models" },
];

/** 窄屏底部导航:主入口 5 个(含 CTA)+「更多」抽屉承载其余 */
const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  { key: "image", label: "图片", icon: "image" },
  { key: "video", label: "视频", icon: "video" },
  { key: "audio", label: "音频", icon: "audio" },
  { key: "fusion", label: "融合", icon: "sparkles", isCta: true },
  { key: "library", label: "作品", icon: "library" },
];

const BOTTOM_NAV_MORE_ITEMS: BottomNavItem[] = [
  { key: "skills", label: "Skill 市场", icon: "package" },
  { key: "audio", label: "音频", icon: "audio" },
  { key: "imageEdit", label: "图片编辑", icon: "wand" },
  { key: "videoEdit", label: "视频剪辑", icon: "scissors" },
  { key: "canvas", label: "画布", icon: "workflow" },
  { key: "studio", label: "创作", icon: "clapperboard" },
  { key: "entities", label: "主体库", icon: "users" },
  { key: "avatartalk", label: "数字人", icon: "user" },
  { key: "dub", label: "译制", icon: "dub" },
  // 2026-08-30 批 D:animatic 原与 studio 同用 clapperboard,换 film(胶片条)提辨识度
  { key: "animatic", label: "动态分镜", icon: "film" },
  { key: "resources", label: "资源", icon: "models" },
  { key: "settings", label: "设置", icon: "settings" },
];

/** WS5:视图切换走 View Transitions(主舞台 cross-fade,样式见 styles/motion.css)。
 *  存在性守卫:不支持的浏览器直接执行原逻辑,不引入 polyfill。
 *  flushSync 让 React 在快照回调内同步提交 DOM,否则新快照仍是旧视图。 */
function withViewTransition(update: () => void) {
  const doc = document as Document & {
    startViewTransition?: (updateCallback: () => void) => unknown;
  };
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(() => flushSync(update));
  } else {
    update();
  }
}

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
  // 2026-08-17 底层化:AI 助手移出视图体系(默认视图 fusion 聚合页承接门户职能),
  // 旧链接 ?view=assistant 兼容:落到 fusion 并自动唤起助手浮层
  const [view, setView] = useState<View>(() => {
    const raw = searchParams.get("view");
    if (raw === "assistant") return "fusion";
    return resolveView(raw) ?? "fusion";
  });
  // AI 助手全局浮层(Shift+Enter 唤起;旧链接 ?view=assistant 首入自动开)
  const [assistantOpen, setAssistantOpen] = useState(() => searchParams.get("view") === "assistant");
  // 开闭态 ref 镜像:快捷键 handler 读当前值,避免在 setState updater 内做副作用
  const assistantOpenRef = useRef(assistantOpen);
  assistantOpenRef.current = assistantOpen;
  // 霓虹边缘动画(2026-08-18):Shift+Enter 开启前沿视口边缘扫描一圈,再平滑过渡出弹窗
  const [neonPlaying, setNeonPlaying] = useState(false);
  const neonRef = useRef<HTMLDivElement | null>(null);
  // 阶段一核点(2026-08-24):与灯带同场,同一 rAF 逐帧驱动
  const coreRef = useRef<HTMLDivElement | null>(null);
  // M9:订阅全局 R18 内容模式(短剧视图可见性/导航项按此 computed)
  const [r18] = useR18Mode();

  // 全局快捷键:Shift+Enter 唤起/收起 AI 助手浮层(底层常驻,任意视图之上)。
  // 开启序列(2026-08-24 重做,总时长 ≤1.4s):阶段一核点点亮(350ms)→ 阶段二
  // 极光灯带扫边(1000ms,双色)→ 阶段三弹窗降临(收尾前 300ms 起播,与余光交叠);
  // prefers-reduced-motion / 不支持 CSS.registerProperty 的浏览器直接开启(无动画)。
  // 守卫:焦点在 input/textarea/select/contenteditable 时不触发,避免与输入框换行冲突;
  // 仅纯 Shift+Enter(不带 Cmd/Ctrl/Alt),不与 ⌘Enter 提交类快捷键(agent-runs/PromptBar)相碰。
  useEffect(() => {
    const canNeon =
      typeof window !== "undefined" &&
      "registerProperty" in CSS &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 双定时器:openTimer 在灯带收尾前 300ms 起播弹窗,doneTimer 在扫边结束收起灯带
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let doneTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      if (doneTimer) {
        clearTimeout(doneTimer);
        doneTimer = null;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return; // 输入上下文内 Shift+Enter 保留原生换行
      }
      e.preventDefault();
      if (openTimer || doneTimer) {
        // 启动序列进行中再次按下:取消动画,直接展开(连按不等候)
        clearTimers();
        setNeonPlaying(false);
        setAssistantOpen(true);
        return;
      }
      if (assistantOpenRef.current) {
        setAssistantOpen(false); // 已开 → 直接收起(不播霓虹)
        return;
      }
      if (canNeon) {
        setNeonPlaying(true);
        // 阶段三:弹窗在灯带收尾前 300ms 起播(700ms 处),与灯带余光交叠
        openTimer = setTimeout(() => {
          setAssistantOpen(true);
          openTimer = null;
        }, NEON_MS - NEON_PANEL_LEAD_MS);
        doneTimer = setTimeout(() => {
          setNeonPlaying(false);
          doneTimer = null;
        }, NEON_MS);
      } else {
        setAssistantOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimers();
    };
  }, []);

  // 霓虹扫描驱动(2026-08-23 重写):JS rAF 逐帧写 --neon-angle/opacity 内联值。
  // 为什么不用 CSS 自定义属性动画:在本页层叠树下,keyframes 驱动 --neon-angle 的
  // 逐帧重绘会被 Chromium 整体丢弃(灯带全程隐形,dev/prod/headed 均实证,
  // 注入同名规则或层提升只能偶发缓解);内联 style 更新走常规 style recalc,
  // 每次必重绘——可靠优先,且 easing/淡入淡出可在 JS 里精确编排。
  useEffect(() => {
    if (!neonPlaying) return;
    const el = neonRef.current;
    if (!el) return;
    const core = coreRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = now - start;
      const k = Math.min(1, t / NEON_MS);
      // easeInOutQuart:起步轻盈、中段流动、收尾减速
      const eased = k < 0.5 ? 8 * k ** 4 : 1 - (-2 * k + 2) ** 4 / 2;
      el.style.setProperty("--neon-angle", `${(eased * NEON_SWEEP_DEG).toFixed(2)}deg`);
      // 首尾淡入淡出(前 12% 淡入,末 16% 淡出,不戛然而止)
      const fadeIn = Math.min(1, k / 0.12);
      const fadeOut = k < 0.84 ? 1 : Math.max(0, (1 - k) / 0.16);
      el.style.opacity = (fadeIn * fadeOut).toFixed(3);
      if (core) {
        // 阶段一「核心点亮」(0–350ms):核点 ease-out 脉冲放大成环 + 雷达弧扫满一圈
        const ck = Math.min(1, t / NEON_CORE_MS);
        const cEase = 1 - (1 - ck) ** 3; // easeOutCubic
        core.style.transform = `scale(${(0.55 + 0.45 * cEase).toFixed(3)})`;
        core.style.setProperty("--core-sweep", `${(cEase * 360).toFixed(2)}deg`);
        // 阶段二:扫边同时中心核淡出(350ms 后线性退场,随灯带收尾归于 0)
        const coreOpacity =
          ck < 1
            ? Math.min(1, t / 90) // 核点快速点亮,不黑场硬闪
            : Math.max(0, 1 - (t - NEON_CORE_MS) / (NEON_MS - NEON_CORE_MS));
        core.style.opacity = coreOpacity.toFixed(3);
      }
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [neonPlaying]);

  useEffect(() => {
    const raw = searchParams.get("view");
    // assistant 已底层化:URL 不再承载该视图,旧链接重定向 fusion
    if (raw === "assistant") {
      if (view !== "fusion") setView("fusion");
      router.replace("/?view=fusion");
      return;
    }
    const resolved = resolveView(raw);
    if (resolved && resolved !== view) {
      setView(resolved);
    }
    // 旧 key(create/generate/ltxstudio)重定向后把 URL 规整为新 key,刷新/分享保持一致
    if (raw && LEGACY_VIEW_REDIRECTS[raw]) {
      router.replace(`/?view=${resolved ?? "fusion"}`);
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

  const onLogout = useCallback(() => {
    setToken(null);
    setAccount(null);
    setAuth("out");
  }, []);

  // Shift+Enter 可发现性(2026-08-17 助手底层化):登录后首次进入提示一次,不打扰回头客;
  // 不设入口按钮(用户明确:助手不单独作为功能显示,仅快捷键唤起)
  const toast = useToast();
  useEffect(() => {
    if (auth !== "in") return;
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("toiv_hint_shiftenter") === "1") return;
    window.localStorage.setItem("toiv_hint_shiftenter", "1");
    const t = setTimeout(() => {
      toast.info("AI 助手已底层化,Shift+Enter 随时唤起对话");
    }, 1200);
    return () => clearTimeout(t);
  }, [auth, toast]);

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

  const changeView = useCallback(
    (next: View) => {
      preloadView(next); // 兜底:未预热目标在点击瞬间立即发起加载
      withViewTransition(() => {
        setView(next);
        router.replace(`/?view=${next}`);
      });
    },
    [router],
  );

  // 2026-08-18:导航位改为 Skill 市场(SPA 视图);/agent-runs 路由保留直达
  // 2026-08-30 批 D:动态分镜「前往工作室」携带的待开项目 id;
  // 导航/融合直进 studio 时复位(null = 落项目列表),避免陈旧 id 误开旧项目
  const [studioInitialProjectId, setStudioInitialProjectId] = useState<string | null>(null);
  const handleNavSelect = useCallback(
    (key: string) => {
      if (key === "studio") setStudioInitialProjectId(null);
      changeView(key as View);
    },
    [changeView],
  );

  // M9 门控:短剧视图仅 R18 模式可达,SFW 模式直输 ?view=drama 一律回落融合页。
  // 判定直接读 localStorage(isR18Mode):useR18Mode 首帧恒 false、effect 中才纠正,
  // 用 hook 态会把已开 R18 的用户误弹走;r18 仅作依赖,驱动模式关闭瞬间的复检。
  useEffect(() => {
    if (view === "drama" && !isR18Mode()) changeView("fusion");
  }, [view, r18, changeView]);

  // 观测面板仅管理员(端点 admin-only):非管理员直输 ?view=observability 弹回融合页;
  // 等会话探测完成(account 非 null)再判,避免登录中误弹。
  useEffect(() => {
    if (view === "observability" && account !== null && account !== "admin") {
      changeView("fusion");
    }
  }, [view, account, changeView]);

  // 动态分镜 AI 模式:解析成功后跳 studio 创作工作室并直开该项目
  // (2026-08-30 批 D:此前丢弃 project.id,落项目列表找不到刚建的项目)
  const handleOpenDramaProject = useCallback(
    (projectId: string) => {
      setStudioInitialProjectId(projectId);
      changeView("studio");
    },
    [changeView],
  );

  // 融合聚合页跳转:target 可带查询串(如 dramaStudio?mode=manju 进漫剧模式)
  const handleFusionNavigate = useCallback(
    (target: string) => {
      const [key, query] = target.split("?", 2);
      const next = resolveView(key) ?? "fusion";
      if (next === "studio") setStudioInitialProjectId(null);
      preloadView(next);
      withViewTransition(() => {
        setView(next);
        router.replace(`/?view=${next}${query ? `&${query}` : ""}`);
      });
    },
    [router],
  );

  // 灵动岛项悬停/聚焦:按操作意向精确预热目标视图
  const handleViewIntent = useCallback((key: string) => {
    if (VALID_VIEWS.has(key as View)) preloadView(key as View);
  }, []);

  const isAdmin = account === "admin";
  const meta = VIEW_META[view];

  // 2026-08-29:灵动岛/底部抽屉不再追加「短剧」(drama 旧管线)——融合页已有
  // 「创作工作室」(studio)旗舰卡承载同一职责,双入口造成认知分叉。
  // drama 视图本体与 R18 URL 门控保留(旧项目数据仍可达),仅收导航入口。
  let islandItems: CornerNavItem[] = ISLAND_ITEMS;
  let bottomNavMoreItems: BottomNavItem[] = BOTTOM_NAV_MORE_ITEMS;
  // 观测面板仅管理员可见(端点 admin-only,普通用户加入口只会 403)
  const observabilityItem: BottomNavItem = {
    key: "observability",
    label: "观测",
    icon: "monitor",
  };
  // 管理面板入口(2026-08-30 批 D):此前无导航入口只能直输 URL;admin 专属,与观测同槽追加
  const adminItem: BottomNavItem = {
    key: "admin",
    label: "管理",
    icon: "shield-check",
  };
  // 注意:ISLAND_ITEMS / BOTTOM_NAV_MORE_ITEMS 是模块级常量,r18 分支的 slice 拼接
  // 产生新数组,非 r18 分支是同一引用——必须再复制一层才能 push,否则每次渲染
  // 都往共享常量里追加,菜单重复(2026-08-24「观测」×7 实证)。
  if (isAdmin) {
    islandItems = [...islandItems, observabilityItem, adminItem];
    bottomNavMoreItems = [...bottomNavMoreItems, observabilityItem, adminItem];
  }

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

  return (
    <div className="app-shell">
      <CornerNav
        items={islandItems}
        current={view}
        onSelect={handleNavSelect}
        onItemIntent={handleViewIntent}
      />

      {/* 右上角账户(2026-08-17 拆分):一跳直达主题/设置/退出,与左上灵动岛对角呼应 */}
      {account && (
        <AccountButton
          account={account}
          onLogout={onLogout}
          onOpenSettings={() => handleNavSelect("settings")}
        />
      )}

      {/* 任务中心(2026-08-29 全量进度体系):右上第二枚,在跑任务数徽标 +
          弹层进度明细(排队位/step/已等待/ETA),完成 toast + 作品库刷新 */}
      {account && <TaskCenter />}

      {/* 启动序列(2026-08-24 重做):Shift+Enter 开启后——阶段一核点点亮(中心,
          350ms)+ 阶段二极光灯带扫边(1000ms,cyan→violet),随后弹窗降临
          (样式见 assistant.css;伪元素在本页层叠树下不重绘,核点用真实子节点) */}
      {neonPlaying && (
        <>
          <div className="neon-edge" ref={neonRef} aria-hidden="true" />
          <div className="neon-core" ref={coreRef} aria-hidden="true">
            <div className="neon-core-arc" />
            <div className="neon-core-dot" />
          </div>
        </>
      )}

      {/* AI 助手全局浮层(2026-08-17 底层化):Shift+Enter 唤起,任意视图之上对话;
          助手内跳视图先收浮层再切换 */}
      <AssistantOverlay
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        onNavigate={(v) => handleNavSelect(v)}
      />

      <main id="main" className={`app-main${view === "avatartalk" ? " avatartalk-main" : ""}`}>
        <div className="view-root view-stage">
          <ErrorBoundary key={view} viewName={meta.label}>
            <Suspense fallback={<ViewFallback label={meta.label} />}>
              {view === "image" && <GenerateView lockedKind="image" />}
              {view === "video" && <GenerateView lockedKind="video" />}
              {view === "audio" && <AudioView />}
              {view === "fusion" && <FusionView onNavigate={handleFusionNavigate} />}
              {/* 融合二级页(2026-08-29):统一补「返回融合」入口(onBack) */}
              {view === "imageEdit" && <ImageEditView onBack={() => handleFusionNavigate("fusion")} />}
              {view === "videoEdit" && <VideoEditView onBack={() => handleFusionNavigate("fusion")} />}
              {view === "canvas" && <CanvasView />}
              {view === "studio" && (
                <StudioView
                  onBack={() => handleFusionNavigate("fusion")}
                  initialProjectId={studioInitialProjectId}
                />
              )}
              {/* M9:短剧(drama 旧管线)仅 R18 模式渲染;SFW 直输 URL 由门控 effect 弹回 */}
              {view === "drama" && r18 && <DramaView />}
              {view === "dub" && <DubView onBack={() => handleFusionNavigate("fusion")} />}
              {view === "animatic" && (
                // 动态分镜全端统一:AnimaticView 为唯一实现(旧桌面端 FROZEN 视图已物理删除)
                <AnimaticView onOpenDramaProject={handleOpenDramaProject} />
              )}
              {view === "avatartalk" && <AvatarTalkView onNavigate={handleFusionNavigate} />}
              {view === "train" && <TrainView />}
              {view === "library" && <LibraryView onNavigate={handleFusionNavigate} />}
              {view === "entities" && <EntitiesView />}
              {view === "backlot" && (
                <BacklotView onCreateProject={() => handleNavSelect("studio")} />
              )}
              {view === "models" && <ModelsView />}
              {view === "resources" && <ResourcesView showAdmin={isAdmin} />}
              {view === "skills" && <SkillMarketView />}
              {view === "settings" && <SettingsView account={account} onLogout={onLogout} />}
              {view === "admin" &&
                // 2026-08-30 批 D:admin 门控对齐观测面板(:754 isAdmin 渲染门控);
                // 非管理员直输 ?view=admin 给无权限提示,不再裸挂 AdminView(其接口 admin-only)
                (isAdmin ? (
                  <AdminView />
                ) : (
                  <Empty
                    icon="lock"
                    title="无权限访问"
                    desc="管理面板仅管理员账号可见"
                  />
                ))}
              {view === "observability" && isAdmin && <ObservabilityView />}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      <BottomNav
        items={BOTTOM_NAV_ITEMS}
        moreItems={bottomNavMoreItems}
        current={view}
        onSelect={handleNavSelect}
        ctaAction={() => changeView("fusion")}
      />
    </div>
  );
}

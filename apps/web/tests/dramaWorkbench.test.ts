/**
 * LibTV 式短剧工作台(2026-08-16 重构)单测(node:test,无 DOM):
 * ① initialStage 三态推导 + SCRIPT/SHOTS 确认状态集合(容器导出纯函数直测)
 * ② WorkbenchShell 步进器 reachable/stepDone 门控矩阵 + aria-current 唯一性
 * ③ DramaWorkbench 双确认门:patchProject 回写 status 阶梯 + 阶段推进(spy 验证)
 * ④ data-zone 浅/暗切换:根属性 + 顶栏按钮 aria-label + onZone 对立值
 * ⑤ 底部 FilmStrip 仅短片阶段渲染,onPick/onAssemble 接线 dp
 * ⑥ FilmStrip 本体:四态缩略(img/video/镜号/失败角标)、汇总去重(顶栏保留)、合成门控、当前镜
 * ⑦ Inspector 三态:镜头摘要 / 角色摘要(外部受控 + 内部自管理)/ 项目摘要
 * ⑧ ShotTableRow:shotTone 映射、SHOT_TONE_LABEL、ShotStatusBadge、行渲染与编辑流
 *
 * 手法:
 * - renderToStaticMarkup 静态渲染断言 HTML(真实 renderer,函数组件全套展开);
 * - 元素树 props 直查:经自注 hook dispatcher(React 19 共享内部 H,语义对齐
 *   tests/helpers/renderHook.ts,另补 useMemo/useRef)展开单层函数组件,
 *   直读宿主元素 props 并调用 onClick 验证回调(spy 断言参数);
 * - dp 为普通对象 as unknown as DramaProjectApi,仅给被测组件实际消费字段。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Icon } from "../components/ui/Icon";
import { ToastProvider } from "../components/ui/Toast";
import {
  DramaWorkbench,
  initialStage,
  SCRIPT_CONFIRMED_STATUSES,
  SHOTS_CONFIRMED_STATUSES,
} from "../components/drama/workbench/DramaWorkbench";
import { WorkbenchShell } from "../components/drama/workbench/WorkbenchShell";
import { FilmStrip } from "../components/drama/workbench/FilmStrip";
import { Inspector } from "../components/drama/workbench/Inspector";
import {
  SEAM_KIND_LABEL,
  SEAM_KIND_OPTIONS,
  seamNeedsAnchor,
  SHOT_TONE_LABEL,
  ShotStatusBadge,
  ShotTableRow,
  shotTone,
  type ShotRowEditPatch,
  type ShotTableRowProps,
} from "../components/drama/workbench/ShotTableRow";
import type { DramaCharacterItem, DramaShotItem } from "../lib/api";
import type {
  DramaProjectApi,
  Stage,
  WorkbenchShellProps,
  WorkbenchZone,
} from "../components/drama/workbench/types";

const h = React.createElement;

/* ── 测试基建:元素树遍历 ── */

type El = React.ReactElement<Record<string, unknown>>;

function isEl(n: unknown): n is El {
  return React.isValidElement<Record<string, unknown>>(n);
}

/** 先序遍历元素树(不展开函数组件子元素,只看已生成的宿主树)。 */
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (isEl(node)) {
    out.push(node);
    walk(node.props.children, out);
  }
  return out;
}

/** 按 class token 精确匹配(避免 wb-film 误中 wb-film-idx)。 */
function findByClass(tree: unknown, cls: string): El[] {
  return walk(tree).filter(
    (el) =>
      typeof el.props.className === "string" &&
      (el.props.className as string).split(" ").includes(cls),
  );
}

/** 提取宿主子树文本(Fragment 下钻;函数组件子元素如 Icon 不展开,跳过)。 */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isEl(node)) {
    if (typeof node.type !== "string") {
      return node.type === React.Fragment ? textOf(node.props.children) : "";
    }
    return textOf(node.props.children);
  }
  return "";
}

function findButtonByText(tree: unknown, text: string): El | undefined {
  return walk(tree).find((el) => el.type === "button" && textOf(el).includes(text));
}

function findByAria(tree: unknown, label: string): El | undefined {
  return walk(tree).find((el) => el.props["aria-label"] === label);
}

function findByTitle(tree: unknown, title: string): El[] {
  return walk(tree).filter((el) => el.props.title === title);
}

/* ── 测试基建:自注 hook dispatcher 渲染器(展开单层函数组件) ── */

interface HookSlot {
  value?: unknown;
  set?: (next: unknown) => void;
  deps?: readonly unknown[];
  effect?: () => void | (() => void);
  cleanup?: void | (() => void);
}

const internals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

function renderTree<R>(fn: () => R) {
  const slots: HookSlot[] = [];
  let cursor = 0;
  let pending: number[] = [];
  let scheduled = false;
  let mounted = true;
  const result: { current: R | null } = { current: null };
  const prev = internals.H;

  const render = (): void => {
    if (!mounted) return;
    cursor = 0;
    pending = [];
    internals.H = dispatcher;
    try {
      result.current = fn();
    } finally {
      internals.H = prev;
    }
    // passive effect:deps 变化的槽位依次重跑(先跑上一个 cleanup)
    for (const i of pending) {
      const slot = slots[i];
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = slot.effect?.();
    }
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };
  const dispatcher = {
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const i = cursor++;
      let slot = slots[i];
      if (!slot) {
        slot = {
          value: typeof initial === "function" ? (initial as () => unknown)() : initial,
        };
        slot.set = (next: unknown) => {
          const v =
            typeof next === "function"
              ? (next as (p: unknown) => unknown)(slot.value)
              : next;
          if (Object.is(v, slot.value)) return;
          slot.value = v;
          schedule();
        };
        slots[i] = slot;
      }
      return [slot.value, slot.set as (next: unknown) => void];
    },
    useMemo(factory: () => unknown): unknown {
      cursor++;
      return factory();
    },
    useCallback(cb: unknown): unknown {
      cursor++;
      return cb;
    },
    useRef(initial: unknown): { current: unknown } {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: { current: initial } };
      return slots[i].value as { current: unknown };
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
      const i = cursor++;
      const slot = slots[i];
      const changed =
        !slot?.deps ||
        !deps ||
        deps.length !== slot.deps.length ||
        deps.some((d, k) => !Object.is(d, slot.deps?.[k]));
      if (changed) {
        slots[i] = { deps, effect };
        pending.push(i);
      }
    },
  };
  render();
  return {
    result,
    flush: (): Promise<void> => new Promise((r) => setTimeout(r, 0)),
    unmount: (): void => {
      if (!mounted) return;
      mounted = false;
      for (const slot of slots) {
        if (typeof slot.cleanup === "function") slot.cleanup();
      }
      internals.H = prev;
    },
  };
}

/* ── mock 工厂 ── */

function makeShot(id: string, over: Partial<DramaShotItem> = {}): DramaShotItem {
  return {
    id,
    project_id: "p1",
    idx: 1,
    scene: "",
    prompt: "",
    negative: "",
    characters: [],
    dialogue: "",
    speaker: "",
    duration_sec: 4,
    start_sec: 0,
    keyframe_url: "",
    video_status: "draft",
    video_url: "",
    voice_status: "draft",
    voice_url: "",
    seed: 1,
    error: "",
    updated_at: "",
    scene_layout: "",
    video_model: "h3",
    mood: "",
    beat: "",
    seam_to_next: "",
    seam_anchor: "",
    ...over,
  };
}

function makeChar(
  id: string,
  name: string,
  over: Partial<DramaCharacterItem> = {},
): DramaCharacterItem {
  return {
    id,
    project_id: "p1",
    asset_id: "",
    name,
    description: "",
    visual_prompt: "",
    ref_image: "",
    ref_audio: "",
    voice_name: "",
    reference_front: "",
    reference_side: "",
    reference_back: "",
    ...over,
  };
}

interface DpSpies {
  patch: Record<string, unknown>[];
  select: string[];
  assemble: number;
}

/** 工作台 dp 可控替身:仅给被测组件实际消费的字段。 */
function makeDp(over: Record<string, unknown> = {}): {
  dp: DramaProjectApi;
  spies: DpSpies;
} {
  const spies: DpSpies = { patch: [], select: [], assemble: 0 };
  const dp = {
    current: {
      id: "p1",
      title: "诛仙短剧",
      status: "draft",
      script: "第一场 镇魔古洞\n【动作】张小凡回头。",
      fps: 24,
      width: 832,
      height: 480,
    },
    shots: [] as DramaShotItem[],
    assets: null,
    assetsLoading: false,
    characters: [] as DramaCharacterItem[],
    doneCount: 0,
    selectedShotId: null,
    selectedShot: null,
    videoModel: "h3",
    videoGenerators: [{ name: "h3", display_name: "MiniMax H3", available: true }],
    taskLog: [],
    patchProject: async (patch: Record<string, unknown>) => {
      spies.patch.push(patch);
      return {};
    },
    setSelectedShotId: (sid: string) => {
      spies.select.push(sid);
    },
    assemble: async () => {
      spies.assemble++;
    },
    ...over,
  } as unknown as DramaProjectApi;
  return { dp, spies };
}

function shellProps(
  dp: DramaProjectApi,
  over: Partial<WorkbenchShellProps> = {},
): WorkbenchShellProps {
  return {
    project: dp,
    stage: "script",
    onStage: () => {},
    inspector: h("div", { className: "probe-inspector" }),
    children: h("div", { className: "probe-stage" }),
    confirmedScript: false,
    confirmedShots: false,
    onConfirmScript: () => {},
    onConfirmShots: () => {},
    zone: "darkroom",
    onZone: () => {},
    ...over,
  };
}

/** DramaWorkbench 返回值即 <WorkbenchShell> 元素,直读其 props。 */
function shellOf(tree: unknown): WorkbenchShellProps {
  return (tree as El).props as unknown as WorkbenchShellProps;
}

function stepButtons(tree: unknown): El[] {
  return findByClass(tree, "wb-step").filter((el) => el.type === "button");
}

interface RowSpies {
  select: number;
  open: string[];
  save: ShotRowEditPatch[];
  regen: number;
  cont: number;
  lip: number;
  board: number;
}

function makeRowSpies(): RowSpies {
  return { select: 0, open: [], save: [], regen: 0, cont: 0, lip: 0, board: 0 };
}

function rowProps(
  shot: DramaShotItem,
  spies: RowSpies,
  over: Partial<ShotTableRowProps> = {},
): ShotTableRowProps {
  return {
    shot,
    selected: false,
    characters: [],
    busyVideo: false,
    busyContinue: false,
    busyLipsync: false,
    onSelect: () => {
      spies.select++;
    },
    onOpenProduce: (sid) => {
      spies.open.push(sid);
    },
    onSave: (p) => {
      spies.save.push(p);
    },
    onRegenerate: () => {
      spies.regen++;
    },
    onContinue: () => {
      spies.cont++;
    },
    onLipsync: () => {
      spies.lip++;
    },
    onStoryboard: () => {
      spies.board++;
    },
    ...over,
  };
}

/* ══ ① initialStage 三态推导 + 确认状态集合 ══ */

test("initialStage:draft 恒进剧本(0 镜与 >0 镜)", () => {
  assert.equal(initialStage("draft", 0), "script");
  assert.equal(initialStage("draft", 3), "script");
});

test("initialStage:storyboard 按有无分镜分流;generating/ready 进短片", () => {
  assert.equal(initialStage("storyboard", 0), "assets");
  assert.equal(initialStage("storyboard", 2), "shots");
  assert.equal(initialStage("generating", 0), "produce");
  assert.equal(initialStage("generating", 5), "produce");
  assert.equal(initialStage("ready", 2), "produce");
});

test("确认状态集合:storyboard 仅剧本确认;generating/ready 双确认", () => {
  for (const s of ["storyboard", "generating", "ready"]) {
    assert.ok(SCRIPT_CONFIRMED_STATUSES.has(s));
  }
  assert.ok(!SCRIPT_CONFIRMED_STATUSES.has("draft"));
  for (const s of ["generating", "ready"]) {
    assert.ok(SHOTS_CONFIRMED_STATUSES.has(s));
  }
  assert.ok(!SHOTS_CONFIRMED_STATUSES.has("storyboard"));
  assert.ok(!SHOTS_CONFIRMED_STATUSES.has("draft"));
});

/* ══ ② Shell 步进器 reachable/stepDone 门控矩阵 ══ */

test("步进器门控(剧本/分镜均未确认):仅剧本可达,无 is-done,aria-current 唯一", () => {
  const { dp } = makeDp({ current: null });
  const calls: Stage[] = [];
  const r = renderTree(() =>
    WorkbenchShell(
      shellProps(dp, { stage: "script", onStage: (s) => void calls.push(s) }),
    ),
  );
  const steps = stepButtons(r.result.current);
  assert.equal(steps.length, 4);
  assert.deepEqual(
    steps.map((b) => b.props.disabled),
    [false, true, true, true],
    "资产/分镜/短片未确认链路全部禁用",
  );
  for (const b of steps) {
    assert.ok(!(b.props.className as string).includes("is-done"), "未确认不应有完成态");
  }
  assert.deepEqual(
    steps.map((b) => b.props["aria-current"]),
    ["step", undefined, undefined, undefined],
    "aria-current 仅当前阶段",
  );
  (steps[0].props.onClick as () => void)();
  assert.deepEqual(calls, ["script"]);
  assert.ok(textOf(r.result.current).includes("短剧项目"), "无项目时标题回落");
  r.unmount();
});

test("步进器门控(剧本已确认):剧本 is-done,资产/分镜可达,短片 disabled", () => {
  const { dp } = makeDp();
  const r = renderTree(() =>
    WorkbenchShell(shellProps(dp, { stage: "assets", confirmedScript: true })),
  );
  const steps = stepButtons(r.result.current);
  assert.deepEqual(
    steps.map((b) => b.props.disabled),
    [false, false, false, true],
  );
  assert.deepEqual(
    steps.map((b) => (b.props.className as string).includes("is-done")),
    [true, false, false, false],
  );
  assert.deepEqual(
    steps.map((b) => b.props["aria-current"]),
    [undefined, "step", undefined, undefined],
  );
  // 已完成且非当前步:图标换 check
  const icon = walk(steps[0]).find((el) => el.type === Icon);
  assert.equal(icon?.props.name, "check");
  assert.ok(textOf(r.result.current).includes("诛仙短剧"));
  r.unmount();
});

test("步进器门控(双确认):剧本/资产/分镜 is-done,短片可达且永不 is-done", () => {
  const { dp } = makeDp();
  const calls: Stage[] = [];
  const r = renderTree(() =>
    WorkbenchShell(
      shellProps(dp, {
        stage: "produce",
        confirmedScript: true,
        confirmedShots: true,
        onStage: (s) => void calls.push(s),
      }),
    ),
  );
  const steps = stepButtons(r.result.current);
  assert.deepEqual(steps.map((b) => b.props.disabled), [false, false, false, false]);
  assert.deepEqual(
    steps.map((b) => (b.props.className as string).includes("is-done")),
    [true, true, true, false],
    "短片步无完成态",
  );
  assert.deepEqual(
    steps.map((b) => b.props["aria-current"]),
    [undefined, undefined, undefined, "step"],
  );
  (steps[3].props.onClick as () => void)();
  assert.deepEqual(calls, ["produce"]);
  r.unmount();
  // 当前步即便 done 也用阶段图标(script 步:done+current → file 而非 check)
  const r2 = renderTree(() =>
    WorkbenchShell(
      shellProps(dp, { stage: "script", confirmedScript: true, confirmedShots: true }),
    ),
  );
  const cur = stepButtons(r2.result.current)[0];
  const icon = walk(cur).find((el) => el.type === Icon);
  assert.equal(icon?.props.name, "file", "当前步保持阶段图标不换 ✓");
  r2.unmount();
});

test("左栏入口:场次统计/资产计数与可达门控、点击跳阶段", () => {
  // 空镜 + 未确认:全禁用 + 占位文案
  const { dp: dp0 } = makeDp({ current: null });
  const r0 = renderTree(() => WorkbenchShell(shellProps(dp0)));
  const links0 = findByClass(r0.result.current, "wb-side-link");
  assert.equal(links0.length, 3);
  assert.equal(links0[0].props.disabled, true);
  assert.ok(textOf(links0[0]).includes("尚未拆分镜"));
  assert.equal(links0[0].props.title, "剧本确认后拆分镜,生成场次树");
  assert.equal(links0[1].props.disabled, true, "资产入口需剧本已确认");
  assert.equal(links0[2].props.disabled, true);
  assert.equal(textOf(links0[2]), "场景/道具", "资产库未加载时不带计数");
  r0.unmount();
  // 有镜 + 剧本确认:计数文案 + 跳阶段
  const shots = [
    makeShot("s1", { scene: "古洞" }),
    makeShot("s2", { scene: "古洞" }),
    makeShot("s3", { scene: "", duration_sec: 1 }),
  ];
  const { dp } = makeDp({
    shots,
    doneCount: 1,
    characters: [makeChar("c1", "碧瑶"), makeChar("c2", "雪琪")],
    assets: [
      { id: "a1", kind: "scene" },
      { id: "a2", kind: "prop" },
      { id: "a3", kind: "character" },
    ],
  });
  const calls: Stage[] = [];
  const r = renderTree(() =>
    WorkbenchShell(
      shellProps(dp, {
        stage: "shots",
        confirmedScript: true,
        onStage: (s) => void calls.push(s),
      }),
    ),
  );
  const links = findByClass(r.result.current, "wb-side-link");
  assert.equal(links[0].props.disabled, false);
  assert.ok(textOf(links[0]).includes("1 场 · 3 镜"), "场景去重且空串不计");
  assert.equal(links[0].props.title, "查看分镜表");
  assert.ok(textOf(links[1]).includes("角色 2"));
  assert.ok(textOf(links[2]).includes("场景/道具 2"), "仅计 scene/prop");
  (links[0].props.onClick as () => void)();
  (links[1].props.onClick as () => void)();
  (links[2].props.onClick as () => void)();
  assert.deepEqual(calls, ["shots", "assets", "assets"]);
  // 顶栏进度:doneCount/镜数 · 总时长
  assert.ok(textOf(r.result.current).includes("1/3 镜 · 00:09"));
  r.unmount();
});

test("检查器收叠:窄视口挂载后收起(首渲恒展开保 hydration 一致),切换按钮联动", async () => {
  const g = globalThis as { window?: { innerWidth: number } };
  const { dp } = makeDp();
  // 无 window(SSR 语义):默认展开
  const r0 = renderTree(() => WorkbenchShell(shellProps(dp)));
  assert.ok(findByAria(r0.result.current, "收叠检查器"), "SSR 默认展开检查器");
  r0.unmount();
  // <1600px:首渲恒为展开(与 SSR 一致,避免 hydration mismatch),挂载 effect 校正为收起
  g.window = { innerWidth: 800 };
  try {
    const r = renderTree(() => WorkbenchShell(shellProps(dp)));
    assert.ok(findByAria(r.result.current, "收叠检查器"), "首渲恒展开(hydration 安全)");
    await r.flush();
    const toggle = findByAria(r.result.current, "展开检查器");
    assert.ok(toggle, "<1600px 挂载后收起");
    assert.equal(toggle.props["aria-expanded"], false);
    const main = findByClass(r.result.current, "wb-main")[0];
    assert.ok((main.props.className as string).includes("wb-main--inspector-closed"));
    const aside = findByClass(r.result.current, "wb-inspector")[0];
    assert.equal(aside.props["aria-hidden"], true);
    (toggle.props.onClick as () => void)();
    await r.flush();
    const toggle2 = findByAria(r.result.current, "收叠检查器");
    assert.ok(toggle2);
    assert.equal(toggle2.props["aria-expanded"], true);
    assert.ok(
      !(findByClass(r.result.current, "wb-main")[0].props.className as string).includes(
        "inspector-closed",
      ),
    );
    r.unmount();
  } finally {
    delete g.window;
  }
  // ≥1600px:默认展开
  g.window = { innerWidth: 1920 };
  try {
    const r2 = renderTree(() => WorkbenchShell(shellProps(dp)));
    assert.ok(findByAria(r2.result.current, "收叠检查器"));
    r2.unmount();
  } finally {
    delete g.window;
  }
});

/* ══ ③ 双确认门回调(DramaWorkbench 容器) ══ */

test("双确认门:draft 确认剧本回写 storyboard 并切资产阶段", async () => {
  const { dp, spies } = makeDp();
  const r = renderTree(() => DramaWorkbench({ dp }));
  const before = shellOf(r.result.current);
  assert.equal(before.stage, "script");
  assert.equal(before.confirmedScript, false);
  before.onConfirmScript();
  await r.flush();
  assert.deepEqual(spies.patch, [{ status: "storyboard" }]);
  const after = shellOf(r.result.current);
  assert.equal(after.stage, "assets");
  assert.equal(after.confirmedScript, true);
  r.unmount();
});

test("双确认门:storyboard 态确认剧本不再回写 patchProject", async () => {
  const { dp, spies } = makeDp({
    current: { id: "p1", title: "t", status: "storyboard", script: "x" },
  });
  const r = renderTree(() => DramaWorkbench({ dp }));
  const shell = shellOf(r.result.current);
  assert.equal(shell.stage, "assets", "storyboard+0 镜初始在资产");
  assert.equal(shell.confirmedScript, true);
  shell.onConfirmScript();
  await r.flush();
  assert.deepEqual(spies.patch, [], "status 已是 storyboard,确认不重复回写");
  assert.equal(shellOf(r.result.current).stage, "assets");
  r.unmount();
});

test("双确认门:确认分镜回写 generating 并切短片阶段", async () => {
  const { dp, spies } = makeDp({
    current: { id: "p1", title: "t", status: "storyboard", script: "x" },
    shots: [makeShot("s1"), makeShot("s2")],
  });
  const r = renderTree(() => DramaWorkbench({ dp }));
  const shell = shellOf(r.result.current);
  assert.equal(shell.stage, "shots", "storyboard+2 镜初始在分镜");
  assert.equal(shell.confirmedShots, false);
  shell.onConfirmShots();
  await r.flush();
  assert.deepEqual(spies.patch, [{ status: "generating" }]);
  const after = shellOf(r.result.current);
  assert.equal(after.stage, "produce");
  assert.equal(after.confirmedShots, true);
  r.unmount();
});

test("双确认门:generating 态确认分镜不再回写 patchProject", async () => {
  const { dp, spies } = makeDp({
    current: { id: "p1", title: "t", status: "generating", script: "x" },
    shots: [makeShot("s1")],
  });
  const r = renderTree(() => DramaWorkbench({ dp }));
  const shell = shellOf(r.result.current);
  assert.equal(shell.stage, "produce");
  assert.equal(shell.confirmedShots, true);
  shell.onConfirmShots();
  await r.flush();
  assert.deepEqual(spies.patch, []);
  assert.equal(shellOf(r.result.current).stage, "produce");
  r.unmount();
});

test("容器回调:onOpenProduce 钉选镜头并切短片;zone 默认暗房可切浅色", async () => {
  const { dp, spies } = makeDp({
    current: { id: "p1", title: "t", status: "storyboard", script: "x" },
    shots: [makeShot("s9")],
  });
  const r = renderTree(() => DramaWorkbench({ dp }));
  let shell = shellOf(r.result.current);
  assert.equal(shell.zone, "darkroom");
  // inspector 元素携 onOpenProduce
  const inspector = shell.inspector as El;
  (inspector.props.onOpenProduce as (sid: string) => void)("s9");
  await r.flush();
  assert.deepEqual(spies.select, ["s9"]);
  shell = shellOf(r.result.current);
  assert.equal(shell.stage, "produce");
  shell.onZone("light");
  await r.flush();
  assert.equal(shellOf(r.result.current).zone, "light");
  r.unmount();
});

test("容器初始阶段:按 status+镜数推导六组合", () => {
  const cases: { status: string; shots: number; stage: Stage; cs: boolean; ck: boolean }[] =
    [
      { status: "draft", shots: 0, stage: "script", cs: false, ck: false },
      { status: "draft", shots: 2, stage: "script", cs: false, ck: false },
      { status: "storyboard", shots: 0, stage: "assets", cs: true, ck: false },
      { status: "storyboard", shots: 2, stage: "shots", cs: true, ck: false },
      { status: "generating", shots: 2, stage: "produce", cs: true, ck: true },
      { status: "ready", shots: 0, stage: "produce", cs: true, ck: true },
    ];
  for (const c of cases) {
    const { dp } = makeDp({
      current: { id: "p1", title: "t", status: c.status, script: "x" },
      shots: Array.from({ length: c.shots }, (_, i) => makeShot(`s${i}`)),
    });
    const r = renderTree(() => DramaWorkbench({ dp }));
    const shell = shellOf(r.result.current);
    assert.equal(shell.stage, c.stage, `${c.status}+${c.shots}镜`);
    assert.equal(shell.confirmedScript, c.cs);
    assert.equal(shell.confirmedShots, c.ck);
    r.unmount();
  }
});

/* ══ ④ data-zone 浅/暗切换 ══ */

test("data-zone:暗房根属性 + 顶栏切换按钮 aria-label/onZone 对立值", () => {
  const zones: WorkbenchZone[] = [];
  const { dp } = makeDp();
  const r = renderTree(() =>
    WorkbenchShell(
      shellProps(dp, { zone: "darkroom", onZone: (z) => void zones.push(z) }),
    ),
  );
  const root = r.result.current as El;
  assert.equal(root.props["data-zone"], "darkroom");
  const toggle = findByAria(r.result.current, "切换浅色区");
  assert.ok(toggle, "暗房态切换按钮指向浅色区");
  const icon = walk(toggle).find((el) => el.type === Icon);
  assert.equal(icon?.props.name, "sun", "暗房态展示太阳图标");
  (toggle.props.onClick as () => void)();
  assert.deepEqual(zones, ["light"]);
  r.unmount();
});

test("data-zone:浅色区切换按钮文案与回切暗房", () => {
  const zones: WorkbenchZone[] = [];
  const { dp } = makeDp();
  const r = renderTree(() =>
    WorkbenchShell(shellProps(dp, { zone: "light", onZone: (z) => void zones.push(z) })),
  );
  assert.equal((r.result.current as El).props["data-zone"], "light");
  const toggle = findByAria(r.result.current, "切换暗房");
  assert.ok(toggle, "浅色态切换按钮指向暗房");
  const icon = walk(toggle).find((el) => el.type === Icon);
  assert.equal(icon?.props.name, "moon", "浅色态展示月亮图标");
  (toggle.props.onClick as () => void)();
  assert.deepEqual(zones, ["darkroom"]);
  r.unmount();
  // HTML 层 spot check
  const html = renderToStaticMarkup(h(WorkbenchShell, shellProps(dp, { zone: "light" })));
  assert.match(html, /data-zone="light"/);
});

/* ══ ⑤ 底部 FilmStrip 条件渲染(Shell) ══ */

test("底部胶片条:仅短片阶段渲染,onPick/onAssemble 接线 dp", () => {
  const { dp, spies } = makeDp({
    shots: [makeShot("s7", { idx: 7 })],
    selectedShotId: "s7",
  });
  for (const stage of ["script", "assets", "shots"] as Stage[]) {
    const r = renderTree(() =>
      WorkbenchShell(
        shellProps(dp, { stage, confirmedScript: true, confirmedShots: true }),
      ),
    );
    assert.equal(
      findByClass(r.result.current, "wb-filmstrip").length,
      0,
      `${stage} 阶段不渲染胶片条`,
    );
    r.unmount();
  }
  const r = renderTree(() =>
    WorkbenchShell(
      shellProps(dp, { stage: "produce", confirmedScript: true, confirmedShots: true }),
    ),
  );
  const footers = findByClass(r.result.current, "wb-filmstrip");
  assert.equal(footers.length, 1);
  assert.equal(footers[0].type, "footer");
  const film = walk(r.result.current).find((el) => el.type === FilmStrip);
  assert.ok(film, "胶片条为 FilmStrip 组件");
  assert.equal(film.props.currentSid, "s7");
  (film.props.onPick as (sid: string) => void)("s7");
  assert.deepEqual(spies.select, ["s7"]);
  (film.props.onAssemble as () => void)();
  assert.equal(spies.assemble, 1);
  r.unmount();
});

/* ══ ⑥ FilmStrip 组件本体 ══ */

test("FilmStrip:done+keyframe 渲染故事板 img(优先于视频首帧)", () => {
  const shots = [
    makeShot("s1", {
      idx: 1,
      video_status: "done",
      keyframe_url: "/kf1.png",
      video_url: "/v1.mp4",
    }),
  ];
  const tree = FilmStrip({ shots, currentSid: null, onPick: () => {}, onAssemble: () => {} });
  const img = walk(tree).find((el) => el.type === "img");
  assert.ok(img, "完成镜有 keyframe 应渲染 img");
  assert.equal(img.props.src, "/kf1.png");
  assert.equal(img.props.alt, "镜头 1");
  assert.equal(
    walk(tree).filter((el) => el.type === "video").length,
    0,
    "有 keyframe 不再回落视频首帧",
  );
});

test("FilmStrip:done 无 keyframe 回落视频首帧(concat > lipsync > video_url)", () => {
  const shots = [
    makeShot("s1", {
      idx: 1,
      video_status: "done",
      continue_concat_url: "/cc.mp4",
      lipsync_video_url: "/ls.mp4",
      video_url: "/v.mp4",
    }),
    makeShot("s2", { idx: 2, video_status: "done", lipsync_video_url: "/ls2.mp4", video_url: "/v2.mp4" }),
    makeShot("s3", { idx: 3, video_status: "done", video_url: "/v3.mp4" }),
    makeShot("s4", { idx: 4, video_status: "done" }),
  ];
  const tree = FilmStrip({ shots, currentSid: null, onPick: () => {}, onAssemble: () => {} });
  const videos = walk(tree).filter((el) => el.type === "video");
  assert.deepEqual(
    videos.map((v) => v.props.src),
    ["/cc.mp4", "/ls2.mp4", "/v3.mp4"],
  );
  // s4:done 但无任何媒体 → 镜号色块
  const films = findByClass(tree, "wb-film");
  assert.equal(films.length, 4);
  const idxSpans = findByClass(tree, "wb-film-idx");
  assert.equal(idxSpans.length, 1);
  assert.equal(textOf(idxSpans[0]), "#4");
});

test("FilmStrip:生成中镜号色块 + 失败红色角标与 title 原因", () => {
  const shots = [
    makeShot("s1", { idx: 1, video_status: "generating" }),
    makeShot("s2", { idx: 2, video_status: "error", error: "显存不足" }),
    makeShot("s3", { idx: 3, video_status: "failed" }),
  ];
  const tree = FilmStrip({ shots, currentSid: null, onPick: () => {}, onAssemble: () => {} });
  const films = findByClass(tree, "wb-film");
  assert.ok((films[0].props.className as string).includes("is-running"));
  assert.ok((films[1].props.className as string).includes("is-error"));
  assert.ok((films[2].props.className as string).includes("is-error"));
  const idxSpans = findByClass(tree, "wb-film-idx");
  assert.equal(idxSpans.length, 3);
  assert.equal(textOf(idxSpans[0]), "#1");
  const errDots = findByClass(tree, "wb-film-errdot");
  assert.equal(errDots.length, 2, "失败镜渲染红色角标");
  assert.equal(films[1].props.title, "#2 · 失败 · 显存不足");
  assert.equal(films[2].props.title, "#3 · 失败", "无错误详情时 title 无后缀");
  assert.equal(films[0].props.title, "#1 · 生成中");
});

test("FilmStrip:空镜头渲染占位且合成按钮禁用", () => {
  let assembled = 0;
  const tree = FilmStrip({
    shots: [],
    currentSid: null,
    onPick: () => {},
    onAssemble: () => {
      assembled++;
    },
  });
  assert.ok(textOf(tree).includes("暂无镜头"));
  // 进度双显去重(2026-08-16 批 2):胶片条不再渲染汇总,顶栏 .wb-progress 唯一保留
  assert.ok(!textOf(tree).includes("已完成 ·"), "胶片条不得重复渲染进度汇总");
  const btn = findButtonByText(tree, "合成成片");
  assert.ok(btn);
  assert.equal(btn.props.disabled, true);
  assert.equal(btn.props.title, "需至少 1 个已完成镜头");
  void assembled;
});

test("FilmStrip:汇总文案 + 合成门控 + 当前镜高亮与钉选", () => {
  const picked: string[] = [];
  let assembled = 0;
  const shots = [
    makeShot("s1", { idx: 1, video_status: "done", keyframe_url: "/a.png" }),
    makeShot("s2", { idx: 2, video_status: "done", keyframe_url: "/b.png" }),
    makeShot("s3", { idx: 3, video_status: "generating", duration_sec: 1 }),
    makeShot("s4", { idx: 4, video_status: "error", duration_sec: 0 }),
  ];
  const tree = FilmStrip({
    shots,
    currentSid: "s2",
    onPick: (sid) => {
      picked.push(sid);
    },
    onAssemble: () => {
      assembled++;
    },
  });
  // 进度双显去重(2026-08-16 批 2):胶片条不再渲染汇总,仅顶栏保留
  assert.ok(!textOf(tree).includes("已完成 ·"), "胶片条不得重复渲染进度汇总");
  const btn = findButtonByText(tree, "合成成片");
  assert.equal(btn?.props.disabled, false);
  assert.equal(btn?.props.title, "合成全部已完成镜头为成片");
  (btn?.props.onClick as (() => void) | undefined)?.();
  assert.equal(assembled, 1);
  const films = findByClass(tree, "wb-film");
  assert.ok((films[1].props.className as string).includes("is-current"));
  assert.deepEqual(
    films.map((f) => f.props["aria-selected"]),
    [false, true, false, false],
  );
  (films[0].props.onClick as () => void)();
  assert.deepEqual(picked, ["s1"]);
});

/* ══ ⑦ Inspector 三态 ══ */

test("Inspector 镜头摘要:镜号/场次/时长/情绪/节拍/角色 chips + CTA 跳短片页", () => {
  const shot = makeShot("s7", {
    idx: 7,
    scene: "镇魔古洞",
    duration_sec: 4.5,
    mood: "压抑",
    beat: "0-3秒 推进",
    prompt: "张小凡回头",
    characters: ["碧瑶", "雪琪"],
    video_status: "done",
  });
  const opened: string[] = [];
  const { dp } = makeDp({ selectedShot: shot, shots: [shot] });
  const r = renderTree(() =>
    Inspector({
      dp,
      onOpenProduce: (sid) => {
        opened.push(sid);
      },
    }),
  );
  const tree = r.result.current;
  assert.ok(textOf(tree).includes("镜头 #7"));
  const dds = walk(tree)
    .filter((el) => el.type === "dd")
    .map(textOf);
  assert.deepEqual(dds, ["镇魔古洞", "4.5s", "压抑", "0-3秒 推进"]);
  assert.ok(textOf(tree).includes("张小凡回头"));
  const chips = findByClass(tree, "wb-chip").map(textOf);
  assert.deepEqual(chips, ["碧瑶", "雪琪"]);
  const cta = findByClass(tree, "wb-inspect-cta")[0];
  assert.ok(textOf(cta).includes("在短片页打开"));
  (cta.props.onClick as () => void)();
  assert.deepEqual(opened, ["s7"]);
  r.unmount();
});

test("Inspector 镜头摘要缺省:场次/情绪/节拍 「—」、无描述占位、无 chips", () => {
  const shot = makeShot("s1", {
    scene: "",
    mood: "",
    beat: "",
    prompt: "",
    characters: undefined as unknown as string[],
  });
  const { dp } = makeDp({ selectedShot: shot, shots: [shot] });
  const r = renderTree(() => Inspector({ dp, onOpenProduce: () => {} }));
  const tree = r.result.current;
  const dds = walk(tree)
    .filter((el) => el.type === "dd")
    .map(textOf);
  assert.deepEqual(dds, ["—", "4.0s", "—", "—"]);
  assert.ok(textOf(tree).includes("(无描述)"));
  assert.equal(findByClass(tree, "wb-inspect-chips").length, 0);
  r.unmount();
});

test("Inspector 角色摘要(外部受控):占位首字/被引用镜数/定位镜头 chips", () => {
  const c1 = makeChar("c1", "碧瑶");
  const c2 = makeChar("c2", "雪琪");
  const s1 = makeShot("s1", { idx: 1, characters: ["碧瑶"] });
  const s2 = makeShot("s2", { idx: 2, characters: ["雪琪"] });
  const s3 = makeShot("s3", { idx: 3, characters: ["碧瑶", "雪琪"] });
  const s4 = makeShot("s4", { idx: 4, characters: undefined as unknown as string[] });
  const { dp, spies } = makeDp({ characters: [c1, c2], shots: [s1, s2, s3, s4] });
  const r = renderTree(() =>
    Inspector({ dp, onOpenProduce: () => {}, selectedCharacterId: "c1" }),
  );
  const tree = r.result.current;
  const ph = findByClass(tree, "wb-avatar-ph")[0];
  assert.ok(ph, "无正面定妆照应渲染占位");
  assert.equal(textOf(ph), "碧");
  assert.ok(textOf(tree).includes("碧瑶"));
  const dds = walk(tree)
    .filter((el) => el.type === "dd")
    .map(textOf);
  assert.deepEqual(dds, ["2 镜"], "被引用数 = shots.characters 含该名的计数");
  assert.ok(textOf(tree).includes("(无描述)"), "角色描述缺省占位");
  assert.equal(findButtonByText(tree, "返回项目摘要"), undefined, "外部受控态无返回钮");
  const refChips = findByClass(tree, "wb-chip-btn");
  assert.deepEqual(refChips.map(textOf), ["#1", "#3"]);
  (refChips[1].props.onClick as () => void)();
  assert.deepEqual(spies.select, ["s3"]);
  r.unmount();
});

test("Inspector 角色摘要:有正面定妆渲染 img,无引用镜不渲染定位 chips", () => {
  const c = makeChar("c3", "小灰", { reference_front: "/front.png", description: "灰毛猴子" });
  const { dp } = makeDp({ characters: [c], shots: [makeShot("s1")] });
  const r = renderTree(() =>
    Inspector({ dp, onOpenProduce: () => {}, selectedCharacterId: "c3" }),
  );
  const tree = r.result.current;
  const img = walk(tree).find((el) => el.type === "img");
  assert.ok(img);
  assert.equal(img.props.src, "/front.png");
  assert.equal(img.props.alt, "小灰");
  assert.ok(textOf(tree).includes("灰毛猴子"));
  assert.deepEqual(
    walk(tree)
      .filter((el) => el.type === "dd")
      .map(textOf),
    ["0 镜"],
  );
  assert.equal(findByClass(tree, "wb-chip-btn").length, 0);
  r.unmount();
});

test("Inspector:外部选中角色 id 不存在时回落项目摘要", () => {
  const { dp } = makeDp({ characters: [makeChar("c1", "碧瑶")] });
  const r = renderTree(() =>
    Inspector({ dp, onOpenProduce: () => {}, selectedCharacterId: "ghost" }),
  );
  assert.ok(textOf(r.result.current).includes("项目摘要"));
  r.unmount();
});

test("Inspector 项目摘要:进度环/镜数/总时长/状态/模型 display_name/角色 chips", () => {
  const shots = [
    makeShot("s1", { video_status: "done" }),
    makeShot("s2"),
    makeShot("s3"),
    makeShot("s4"),
  ];
  const chars = [makeChar("c1", "碧瑶"), makeChar("c2", "雪琪")];
  const { dp } = makeDp({
    shots,
    characters: chars,
    doneCount: 1,
    current: { id: "p1", title: "t", status: "storyboard", script: "x" },
  });
  const html = renderToStaticMarkup(h(Inspector, { dp, onOpenProduce: () => {} }));
  assert.match(html, /aria-label="进度 25%"/);
  assert.match(html, />25%</);
  const r = renderTree(() => Inspector({ dp, onOpenProduce: () => {} }));
  const dds = walk(r.result.current)
    .filter((el) => el.type === "dd")
    .map(textOf);
  assert.deepEqual(dds, ["4", "1", "00:16", "storyboard", "MiniMax H3", "2"]);
  const chips = findByClass(r.result.current, "wb-chip-btn").map(textOf);
  assert.deepEqual(chips, ["碧瑶", "雪琪"]);
  r.unmount();
});

test("Inspector 项目摘要缺省:模型名回落/无项目状态 「—」/0 镜进度 0%/无角色无 chips", () => {
  const { dp } = makeDp({
    current: null,
    shots: [],
    characters: [],
    videoModel: "h3-turbo",
    videoGenerators: [{ name: "m1", display_name: "", available: false }],
  });
  const html = renderToStaticMarkup(h(Inspector, { dp, onOpenProduce: () => {} }));
  assert.match(html, /aria-label="进度 0%"/);
  const r = renderTree(() => Inspector({ dp, onOpenProduce: () => {} }));
  const dds = walk(r.result.current)
    .filter((el) => el.type === "dd")
    .map(textOf);
  assert.deepEqual(dds, ["0", "0", "00:00", "—", "h3-turbo", "0"], "生成模型找不到回落原名");
  assert.equal(findByClass(r.result.current, "wb-chip-btn").length, 0);
  r.unmount();
  // display_name 为空串:同样回落模型原名
  const { dp: dp2 } = makeDp({
    videoModel: "m1",
    videoGenerators: [{ name: "m1", display_name: "", available: true }],
  });
  const r2 = renderTree(() => Inspector({ dp: dp2, onOpenProduce: () => {} }));
  const dds2 = walk(r2.result.current)
    .filter((el) => el.type === "dd")
    .map(textOf);
  assert.equal(dds2[4], "m1", "display_name 空串回落模型原名");
  r2.unmount();
});

test("Inspector 角色内部自管理:项目摘要点角色芯片进角色摘要,可返回", async () => {
  const c1 = makeChar("c1", "碧瑶");
  const c2 = makeChar("c2", "雪琪");
  const s1 = makeShot("s1", { idx: 1, characters: ["碧瑶"] });
  const { dp } = makeDp({ characters: [c1, c2], shots: [s1], doneCount: 0 });
  const r = renderTree(() => Inspector({ dp, onOpenProduce: () => {} }));
  // 项目摘要 → 点「碧瑶」芯片
  const chips = findByClass(r.result.current, "wb-chip-btn");
  assert.equal(chips.length, 2);
  (chips[0].props.onClick as () => void)();
  await r.flush();
  let tree = r.result.current;
  assert.ok(textOf(tree).includes("角色"));
  assert.ok(textOf(tree).includes("1 镜"));
  const back = findButtonByText(tree, "返回项目摘要");
  assert.ok(back, "内部自管理态提供返回入口");
  (back.props.onClick as () => void)();
  await r.flush();
  tree = r.result.current;
  assert.ok(textOf(tree).includes("项目摘要"));
  assert.equal(findByClass(tree, "wb-chip-btn").length, 2, "回到项目摘要角色速览");
  r.unmount();
});

/* ══ ⑧ ShotTableRow:shotTone / SHOT_TONE_LABEL / ShotStatusBadge / 行渲染 ══ */

test("shotTone 四态映射:done/error/running 家族与未知回落 queued", () => {
  for (const s of ["done", "ready", "completed", "DONE"]) {
    assert.equal(shotTone(s), "done");
  }
  for (const s of ["error", "failed"]) {
    assert.equal(shotTone(s), "error");
  }
  for (const s of ["generating", "continuing", "pending", "running"]) {
    assert.equal(shotTone(s), "running");
  }
  for (const s of ["draft", "", "whatever"]) {
    assert.equal(shotTone(s), "queued");
  }
  assert.equal(shotTone(undefined), "queued");
});

test("SHOT_TONE_LABEL 四态中文文案", () => {
  assert.deepEqual(SHOT_TONE_LABEL, {
    done: "完成",
    running: "生成中",
    error: "失败",
    queued: "排队",
  });
});

test("ShotStatusBadge:四态徽章 + label 前缀 + error 原因 title", () => {
  const err = renderToStaticMarkup(ShotStatusBadge({ status: "error", error: "OOM" }));
  assert.match(err, /wb-badge is-error/);
  assert.match(err, /title="OOM"/);
  assert.match(err, /失败/);
  const errNoMsg = renderToStaticMarkup(ShotStatusBadge({ status: "failed" }));
  assert.match(errNoMsg, /is-error/);
  assert.ok(!errNoMsg.includes("title="), "无错误详情不带 title");
  const done = renderToStaticMarkup(ShotStatusBadge({ status: "done", label: "配音" }));
  assert.match(done, /is-done/);
  assert.match(done, /配音·完成/);
  assert.match(done, /<svg/);
  const running = renderToStaticMarkup(ShotStatusBadge({ status: "generating" }));
  assert.match(running, /is-running/);
  assert.match(running, /生成中/);
  const queued = renderToStaticMarkup(ShotStatusBadge({}));
  assert.match(queued, /is-queued/);
  assert.match(queued, /排队/);
});

test("ShotTableRow 行渲染:选中态/场景/头像/情绪节拍 chips/故事板图/时长 + 操作回调", () => {
  const shot = makeShot("s1", {
    idx: 3,
    scene: "镇魔古洞",
    prompt: "张小凡回头",
    mood: "压抑",
    beat: "0-3秒",
    characters: ["碧瑶", "雪琪"],
    keyframe_url: "/kf.png",
    video_status: "done",
    voice_status: "done",
  });
  const spies = makeRowSpies();
  const r = renderTree(() =>
    ShotTableRow(
      rowProps(shot, spies, {
        selected: true,
        characters: [
          makeChar("c1", "碧瑶", { reference_front: "/b.png" }),
          makeChar("c2", "雪琪", { reference_front: "/x.png" }),
        ],
      }),
    ),
  );
  const tree = r.result.current;
  const row = findByClass(tree, "wb-shot-row")[0];
  assert.ok((row.props.className as string).includes("is-selected"));
  assert.ok(textOf(tree).includes("镇魔古洞"));
  const avatars = findByClass(tree, "wb-avatar").filter((el) => el.type === "img");
  assert.deepEqual(
    avatars.map((a) => a.props.src),
    ["/b.png", "/x.png"],
  );
  const chips = findByClass(tree, "wb-chip").map(textOf);
  assert.deepEqual(chips, ["压抑", "0-3秒"]);
  const board = findByClass(tree, "wb-board-thumb")[0];
  assert.equal(board.props.src, "/kf.png");
  assert.ok(textOf(findByClass(tree, "wb-col-dur")[0]).includes("4.0s"));
  // 行点击选中
  (row.props.onClick as () => void)();
  assert.equal(spies.select, 1);
  // 镜号跳短片页(stopPropagation)
  let stopped = 0;
  const idxBtn = findByClass(tree, "wb-shot-idx")[0];
  (idxBtn.props.onClick as (e: { stopPropagation: () => void }) => void)({
    stopPropagation: () => {
      stopped++;
    },
  });
  assert.deepEqual(spies.open, ["s1"]);
  assert.equal(stopped, 1);
  // 操作列:重生成/续写/口型全可用
  const regen = findByTitle(tree, "重生成(换 seed)")[0];
  (regen.props.onClick as () => void)();
  assert.equal(spies.regen, 1);
  const cont = findByTitle(tree, "末帧续写 1 段并自动拼接")[0];
  assert.equal(cont.props.disabled, false);
  (cont.props.onClick as () => void)();
  assert.equal(spies.cont, 1);
  const lip = findByTitle(tree, "对口型(源视频 + 配音)")[0];
  assert.equal(lip.props.disabled, false);
  (lip.props.onClick as () => void)();
  assert.equal(spies.lip, 1);
  r.unmount();
});

test("ShotTableRow 行渲染缺省:无资产 「—」/无描述占位/生成故事板入口/未完成操作禁用", () => {
  const shot = makeShot("s2", { idx: 2, video_status: "generating", voice_status: "draft" });
  const spies = makeRowSpies();
  const r = renderTree(() => ShotTableRow(rowProps(shot, spies, { busyVideo: true })));
  const tree = r.result.current;
  const row = findByClass(tree, "wb-shot-row")[0];
  assert.ok(!(row.props.className as string).includes("is-selected"));
  assert.ok(textOf(findByClass(tree, "wb-col-assets")[0]).includes("—"));
  assert.ok(textOf(tree).includes("(无描述)"));
  assert.equal(findByClass(tree, "wb-shot-tags").length, 0, "无情绪/节拍不渲染标签行");
  let stopped = 0;
  const boardBtn = findButtonByText(tree, "生成故事板");
  assert.ok(boardBtn);
  (boardBtn.props.onClick as (e: { stopPropagation: () => void }) => void)({
    stopPropagation: () => {
      stopped++;
    },
  });
  assert.equal(spies.board, 1);
  assert.equal(stopped, 1);
  const regen = findByTitle(tree, "生成中…")[0];
  assert.equal(regen.props.disabled, true, "busyVideo 禁用重生成");
  const disabledOps = findByTitle(tree, "需先生成视频");
  assert.equal(disabledOps.length, 2, "续写/口型均需先完成视频");
  for (const b of disabledOps) assert.equal(b.props.disabled, true);
  r.unmount();
});

test("ShotTableRow 资产列:>4 角色折叠 +N,无定妆照占位首字,未匹配名过滤", () => {
  const chars = [
    makeChar("c1", "碧瑶", { reference_front: "/b.png" }),
    makeChar("c2", "雪琪"),
    makeChar("c3", "小灰"),
    makeChar("c4", "鬼王"),
    makeChar("c5", "周一仙"),
  ];
  const shot = makeShot("s3", {
    characters: ["碧瑶", "雪琪", "小灰", "鬼王", "周一仙", "幽灵"],
  });
  const spies = makeRowSpies();
  const r = renderTree(() => ShotTableRow(rowProps(shot, spies, { characters: chars })));
  const tree = r.result.current;
  const avatars = findByClass(tree, "wb-avatar");
  assert.equal(avatars.filter((el) => el.type === "img").length, 1);
  const phTexts = findByClass(tree, "wb-avatar-ph").map(textOf);
  assert.ok(phTexts.includes("雪") && phTexts.includes("小") && phTexts.includes("鬼"));
  assert.ok(phTexts.includes("+1"), "超出 4 个折叠 +N(未匹配名已过滤)");
  r.unmount();
});

test("ShotTableRow 操作列禁用矩阵:busy 文案与配音前置", () => {
  const doneShot = makeShot("s1", { video_status: "done", voice_status: "done" });
  const spies = makeRowSpies();
  // 续写 busy
  let r = renderTree(() => ShotTableRow(rowProps(doneShot, spies, { busyContinue: true })));
  const cont = findByTitle(r.result.current, "续写中…")[0];
  assert.equal(cont.props.disabled, true);
  r.unmount();
  // 口型 busy
  r = renderTree(() => ShotTableRow(rowProps(doneShot, spies, { busyLipsync: true })));
  const lip = findByTitle(r.result.current, "对口型中…")[0];
  assert.equal(lip.props.disabled, true);
  r.unmount();
  // 配音未完成 → 口型禁用;续写不受配音影响
  const noVoice = makeShot("s2", { video_status: "done", voice_status: "draft" });
  r = renderTree(() => ShotTableRow(rowProps(noVoice, spies)));
  const lip2 = findByTitle(r.result.current, "需先完成配音")[0];
  assert.equal(lip2.props.disabled, true);
  const cont2 = findByTitle(r.result.current, "末帧续写 1 段并自动拼接")[0];
  assert.equal(cont2.props.disabled, false);
  r.unmount();
});

test("ShotTableRow 编辑流:展开 → 修改 → 保存(trim 载荷)/ 取消 / Enter 与铅笔开关", async () => {
  const shot = makeShot("s1", { prompt: "旧描述", mood: "", beat: "" });
  const spies = makeRowSpies();
  const r = renderTree(() => ShotTableRow(rowProps(shot, spies)));
  // 进入编辑(描述区点击)
  const promptBox = findByClass(r.result.current, "wb-prompt")[0];
  (promptBox.props.onClick as (e: { stopPropagation: () => void }) => void)({
    stopPropagation: () => {},
  });
  await r.flush();
  assert.equal(findByClass(r.result.current, "wb-shot-edit").length, 1, "展开整行编辑区");
  const ta = findByClass(r.result.current, "wb-textarea")[0];
  assert.equal(ta.props.value, "旧描述");
  (ta.props.onChange as (e: { target: { value: string } }) => void)({
    target: { value: "  新描述  " },
  });
  await r.flush();
  const saveBtn = findButtonByText(r.result.current, "保存");
  (saveBtn?.props.onClick as (() => void) | undefined)?.();
  assert.deepEqual(
    spies.save,
    [{ prompt: "新描述", mood: "", beat: "", seam_to_next: "", seam_anchor: "" }],
    "保存载荷去首尾空白",
  );
  await r.flush();
  assert.equal(findByClass(r.result.current, "wb-shot-edit").length, 0, "保存后收起");
  // 非 Enter 不展开
  const promptBox2 = findByClass(r.result.current, "wb-prompt")[0];
  (promptBox2.props.onKeyDown as (e: { key: string; stopPropagation: () => void }) => void)({
    key: "a",
    stopPropagation: () => {},
  });
  await r.flush();
  assert.equal(findByClass(r.result.current, "wb-shot-edit").length, 0);
  // Enter 展开 → 取消收起不保存
  (promptBox2.props.onKeyDown as (e: { key: string; stopPropagation: () => void }) => void)({
    key: "Enter",
    stopPropagation: () => {},
  });
  await r.flush();
  assert.equal(findByClass(r.result.current, "wb-shot-edit").length, 1);
  const cancelBtn = findButtonByText(r.result.current, "取消");
  (cancelBtn?.props.onClick as (() => void) | undefined)?.();
  await r.flush();
  assert.equal(findByClass(r.result.current, "wb-shot-edit").length, 0, "取消收起不保存");
  assert.equal(spies.save.length, 1);
  // 铅笔按钮开关切换
  const pencil = findByTitle(r.result.current, "编辑描述/情绪/节拍")[0];
  (pencil.props.onClick as () => void)();
  await r.flush();
  assert.equal(findByClass(r.result.current, "wb-shot-edit").length, 1);
  const pencilOn = findByTitle(r.result.current, "编辑描述/情绪/节拍")[0];
  (pencilOn.props.onClick as () => void)();
  await r.flush();
  assert.equal(findByClass(r.result.current, "wb-shot-edit").length, 0);
  r.unmount();
});

/* ══ ⑨ P1 衔接策略层:接缝徽章 4 态 + 行内选择器 patch 回调 ══ */

test("SEAM_KIND_LABEL 四态中文文案 + seamNeedsAnchor 条件", () => {
  assert.deepEqual(SEAM_KIND_LABEL, {
    continue: "续写",
    overlap: "重叠",
    matchcut: "匹配",
    hardcut: "硬切",
  });
  assert.equal(seamNeedsAnchor("matchcut"), true);
  assert.equal(seamNeedsAnchor("overlap"), true);
  assert.equal(seamNeedsAnchor("continue"), false);
  assert.equal(seamNeedsAnchor("hardcut"), false);
  assert.equal(seamNeedsAnchor(""), false);
  // 选择器:未规划占位 + 4 策略
  assert.equal(SEAM_KIND_OPTIONS.length, 5);
  assert.equal(SEAM_KIND_OPTIONS[0].value, "");
});

test("ShotTableRow 接缝徽章:四态渲染短文案,未规划(空)不渲染", () => {
  for (const [kind, label] of Object.entries(SEAM_KIND_LABEL)) {
    const spies = makeRowSpies();
    const r = renderTree(() =>
      ShotTableRow(rowProps(makeShot(`s-${kind}`, { seam_to_next: kind }), spies)),
    );
    const chipTexts = findByClass(r.result.current, "wb-chip").map(textOf);
    assert.deepEqual(chipTexts, [`接缝·${label}`], `${kind} 应渲染接缝徽章`);
    r.unmount();
  }
  const spies = makeRowSpies();
  const r = renderTree(() => ShotTableRow(rowProps(makeShot("s-none"), spies)));
  assert.ok(!textOf(r.result.current).includes("接缝·"), "空 seam 不渲染徽章");
  r.unmount();
});

test("ShotTableRow 接缝徽章 title 带锚点(匹配/重叠)", () => {
  const spies = makeRowSpies();
  const shot = makeShot("s-mc", { seam_to_next: "matchcut", seam_anchor: "太刀刀刃" });
  const r = renderTree(() => ShotTableRow(rowProps(shot, spies)));
  const chip = findByTitle(r.result.current, "接缝:匹配(锚点:太刀刀刃)")[0];
  assert.ok(chip, "徽章 title 应含锚点");
  r.unmount();
});

test("ShotTableRow 接缝编辑:选择器切换显示锚点框,保存回调带 seam 载荷", async () => {
  const shot = makeShot("s-seam", { seam_to_next: "", seam_anchor: "" });
  const spies = makeRowSpies();
  const r = renderTree(() => ShotTableRow(rowProps(shot, spies)));
  // 展开编辑区
  const promptBox = findByClass(r.result.current, "wb-prompt")[0];
  (promptBox.props.onClick as (e: { stopPropagation: () => void }) => void)({
    stopPropagation: () => {},
  });
  await r.flush();
  // 接缝选择器存在,默认未规划;锚点框不显示
  const seamSelect = findByClass(r.result.current, "wb-select").filter(
    (el) => el.props["aria-label"] === "接缝策略",
  )[0];
  assert.ok(seamSelect, "编辑区应有接缝选择器");
  assert.equal(seamSelect.props.value, "");
  const anchorInputCount = () =>
    findByClass(r.result.current, "wb-input").filter(
      (el) => el.props.placeholder === "如:太刀刀刃 / 圆环 / 瞳孔 / 色块",
    ).length;
  assert.equal(anchorInputCount(), 0, "未规划/硬切不显示锚点框");
  // 切到 matchcut → 锚点框出现
  (seamSelect.props.onChange as (e: { target: { value: string } }) => void)({
    target: { value: "matchcut" },
  });
  await r.flush();
  assert.equal(anchorInputCount(), 1, "matchcut 显示锚点框");
  // 填锚点 → 保存 → 载荷带 seam 字段
  const anchorInput = findByClass(r.result.current, "wb-input").filter(
    (el) => el.props.placeholder === "如:太刀刀刃 / 圆环 / 瞳孔 / 色块",
  )[0];
  (anchorInput.props.onChange as (e: { target: { value: string } }) => void)({
    target: { value: " 太刀刀刃 " },
  });
  await r.flush();
  const saveBtn = findButtonByText(r.result.current, "保存");
  (saveBtn?.props.onClick as (() => void) | undefined)?.();
  assert.equal(spies.save.length, 1);
  assert.equal(spies.save[0].seam_to_next, "matchcut");
  assert.equal(spies.save[0].seam_anchor, "太刀刀刃", "锚点 trim 后入载荷");
  r.unmount();
});

test("ShotTableRow 接缝编辑:硬切保存清空锚点", async () => {
  const shot = makeShot("s-hard", { seam_to_next: "matchcut", seam_anchor: "圆环" });
  const spies = makeRowSpies();
  const r = renderTree(() => ShotTableRow(rowProps(shot, spies)));
  const promptBox = findByClass(r.result.current, "wb-prompt")[0];
  (promptBox.props.onClick as (e: { stopPropagation: () => void }) => void)({
    stopPropagation: () => {},
  });
  await r.flush();
  // 初值 matchcut + 锚点框带旧值;切硬切 → 锚点框消失
  const seamSelect = findByClass(r.result.current, "wb-select").filter(
    (el) => el.props["aria-label"] === "接缝策略",
  )[0];
  assert.equal(seamSelect.props.value, "matchcut");
  (seamSelect.props.onChange as (e: { target: { value: string } }) => void)({
    target: { value: "hardcut" },
  });
  await r.flush();
  const saveBtn = findButtonByText(r.result.current, "保存");
  (saveBtn?.props.onClick as (() => void) | undefined)?.();
  assert.deepEqual(spies.save[0].seam_to_next, "hardcut");
  assert.equal(spies.save[0].seam_anchor, "", "硬切锚点强制清空");
  r.unmount();
});

/* ══ 容器挂载烟幕(真实 renderer 全套展开) ══ */

test("容器挂载烟幕:generating 初始短片阶段(胶片条 + 空播放器提示)", () => {
  const { dp } = makeDp({
    current: {
      id: "p1",
      title: "诛仙",
      status: "generating",
      script: "x",
      fps: 24,
      width: 832,
      height: 480,
    },
  });
  const html = renderToStaticMarkup(h(ToastProvider, null, h(DramaWorkbench, { dp })));
  assert.match(html, /wb-root/);
  assert.match(html, /data-zone="darkroom"/);
  assert.match(html, /wb-filmstrip/, "短片阶段渲染底部胶片条");
  assert.match(html, /暂无镜头/);
  assert.match(html, /还没有分镜/);
});

test("容器挂载烟幕:draft 初始剧本阶段(确认剧本门可见,无胶片条)", () => {
  const { dp } = makeDp({
    current: {
      id: "p1",
      title: "诛仙",
      status: "draft",
      script: "第一场 镇魔古洞\n【动作】张小凡回头。",
    },
  });
  const html = renderToStaticMarkup(h(ToastProvider, null, h(DramaWorkbench, { dp })));
  assert.match(html, /wb-script/);
  assert.match(html, /确认剧本/);
  assert.doesNotMatch(html, /wb-filmstrip/, "剧本阶段不渲染胶片条");
});

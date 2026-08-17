/**
 * UI-A 设计系统基座组件单测(node:test + react-dom/server 静态渲染):
 * ① Ripple:渲染 ui-ripple 叠加层、children 原样透传(onClick 不被干扰)
 * ② ParticleButton:buildBurst 粒子数硬上限 ≤280;reduced-motion 判定为 true 时跳过
 * ③ ErrorBar:role=alert 渲染 + 关闭按钮触发 onClose
 * ④ Icon:UI-A 新增键(agent-run 迁移所需)均有 svg 映射
 * ⑤ LoadingBlock:line/block/grid 三变体渲染
 * ⑥ PageHeader:标题/副标题/操作槽渲染
 * 说明:node 无 DOM,交互行为以「元素树 props 直查 + 纯函数单测」方式验证;
 * .tsx 组件经 tests/loader.mjs 的 load 钩子 transpile 后加载。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ErrorBar } from "../components/ui/ErrorBar";
import { Icon, type IconName } from "../components/ui/Icon";
import { LoadingBlock } from "../components/ui/LoadingBlock";
import { PageHeader } from "../components/ui/PageHeader";
import {
  buildBurst,
  PARTICLE_HARD_CAP,
  ParticleButton,
  reducedMotionMatches,
} from "../components/ui/ParticleButton";
import { Ripple } from "../components/ui/Ripple";

const h = React.createElement;

/* ── ① Ripple ── */
test("Ripple 渲染叠加层且 children/onClick 原样透传", () => {
  const onClick = () => "fired";
  const el = h(Ripple, null, h("button", { className: "btn btn-primary", onClick }, "登录"));
  // 元素树:Ripple 不重包/不克隆子元素,onClick 引用不变(不干扰)
  const child = el.props.children as React.ReactElement<{ onClick: () => string }>;
  assert.equal(child.props.onClick, onClick);

  const html = renderToStaticMarkup(el);
  assert.match(html, /ui-ripple/);
  assert.match(html, /ui-ripple-layer/);
  assert.match(html, /btn btn-primary/);
  // 只有一个 button(叠加层是 span,不产生额外按钮)
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});

test("Ripple radius=full 圆角变体渲染", () => {
  const html = renderToStaticMarkup(
    h(Ripple, { radius: "full", children: h("button", null, "x") }),
  );
  assert.match(html, /ui-ripple--full/);
});

/* ── ② ParticleButton ── */
test("ParticleButton 粒子数硬上限 ≤280", () => {
  assert.equal(PARTICLE_HARD_CAP, 280);
  assert.equal(buildBurst(200, 48, 500).length, 280);
  assert.equal(buildBurst(200, 48, 120).length, 120);
  assert.equal(buildBurst(200, 48, 0).length, 0);
});

test("ParticleButton 粒子目标点落在按钮轮廓带内(速度时长为正)", () => {
  const burst = buildBurst(200, 48, 50);
  for (const p of burst) {
    // 目标点:周长采样 + ±4 抖动,必在扩 8px 的轮廓带附近
    assert.ok(p.tx >= -8 && p.tx <= 208, `tx 越界:${p.tx}`);
    assert.ok(p.ty >= -8 && p.ty <= 56, `ty 越界:${p.ty}`);
    assert.ok(p.duration >= 520 && p.duration <= 1100, `duration 越界:${p.duration}`);
    assert.ok(p.r >= 1 && p.r <= 2, `半径越界:${p.r}`);
  }
});

test("ParticleButton reduced-motion 判定为 true 时跳过(matchMedia 契约)", () => {
  assert.equal(reducedMotionMatches({ matches: true }), true);
  assert.equal(reducedMotionMatches({ matches: false }), false);
  assert.equal(reducedMotionMatches(null), false);
  assert.equal(reducedMotionMatches(undefined), false);
});

test("ParticleButton 渲染 canvas 叠加层", () => {
  const html = renderToStaticMarkup(h(ParticleButton, null, h("button", null, "登录")));
  assert.match(html, /ui-particles/);
  assert.match(html, /ui-particles-canvas/);
  assert.match(html, /<canvas/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});

/* ── ③ ErrorBar ── */
test("ErrorBar 渲染 role=alert 且可关闭(onClose 触发)", () => {
  let closed = 0;
  const el = ErrorBar({ message: "生成失败", onClose: () => closed++ });
  assert.ok(el);
  const html = renderToStaticMarkup(el);
  assert.match(html, /role="alert"/);
  assert.match(html, /ui-error-bar/);
  assert.match(html, /ui-error-bar-close/);
  assert.match(html, /生成失败/);
  // 元素树直查:关闭按钮 onClick 即 onClose
  const kids = React.Children.toArray(el.props.children) as React.ReactElement<{
    className?: string;
    onClick?: () => void;
  }>[];
  const closeBtn = kids.find(
    (k) => typeof k.props.className === "string" && k.props.className.includes("ui-error-bar-close"),
  );
  assert.ok(closeBtn, "缺少关闭按钮");
  closeBtn!.props.onClick!();
  assert.equal(closed, 1);
});

test("ErrorBar message 为空不渲染", () => {
  assert.equal(ErrorBar({ message: null, onClose: () => {} }), null);
  assert.equal(ErrorBar({ message: "", onClose: () => {} }), null);
});

/* ── ④ Icon 新键 ── */
test("Icon UI-A 新增键均有 svg 映射(agent-run 迁移所需)", () => {
  const keys: IconName[] = [
    "bot",
    "ban",
    "radio",
    "pencil",
    "hand",
    "clock",
    "x-circle",
    "list-ordered",
    "shield-check",
    "badge-check",
    "layout-grid",
  ];
  for (const name of keys) {
    const html = renderToStaticMarkup(h(Icon, { name }));
    assert.match(html, /<svg/, `Icon 键 ${name} 未渲染 svg`);
  }
});

/* ── ⑤ LoadingBlock ── */
test("LoadingBlock line/block/grid 变体渲染", () => {
  const line = renderToStaticMarkup(h(LoadingBlock, { variant: "line", count: 4 }));
  assert.match(line, /ui-loading--line/);
  assert.equal((line.match(/ui-loading-block/g) ?? []).length, 4);

  const block = renderToStaticMarkup(h(LoadingBlock, { variant: "block" }));
  assert.match(block, /ui-loading--block/);
  assert.equal((block.match(/ui-loading-block/g) ?? []).length, 1);

  const grid = renderToStaticMarkup(h(LoadingBlock, { variant: "grid", count: 3 }));
  assert.match(grid, /ui-loading--grid/);
  assert.equal((grid.match(/ui-loading-block/g) ?? []).length, 3);
});

/* ── ⑥ PageHeader ── */
test("PageHeader 标题/副标题/操作槽渲染", () => {
  const html = renderToStaticMarkup(
    h(PageHeader, {
      title: "创作工作室",
      desc: "四步完成一部短剧",
      icon: "clapperboard",
      actions: h("button", { className: "btn" }, "新建"),
    }),
  );
  assert.match(html, /page-header/);
  assert.match(html, /page-header-title/);
  assert.match(html, /page-header-desc/);
  assert.match(html, /page-header-actions/);
  assert.match(html, /ui-page-header-icon/);
  assert.match(html, /创作工作室/);
  assert.match(html, /新建/);
});

test("PageHeader kicker 铭牌:传入渲染,缺省不渲染", () => {
  const withKicker = renderToStaticMarkup(
    h(PageHeader, { title: "作品库", kicker: "MEDIA ATELIER" }),
  );
  assert.match(withKicker, /page-header-kicker/);
  assert.match(withKicker, /MEDIA ATELIER/);
  const without = renderToStaticMarkup(h(PageHeader, { title: "作品库" }));
  assert.doesNotMatch(without, /page-header-kicker/);
});

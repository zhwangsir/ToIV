#!/usr/bin/env node
/**
 * MP8.1 H5 自动化 UX 走查（Playwright + Mock API）
 * 检查点：C1-C7 主流程（MP8）+ C8-C13 引擎接入（MP10/MP11）+ C8.2/C14-C16 R18 引擎（MP12）+ C17 参考资产库（MP13）+ C18 avatar-talk 数字人（MP14）+ C19 作品库无限分页（MP15）+ C20 反推提示词（MP17）+ C21 优化提示词（MP18）+ C22 对话助手（MP19）+ C23 文档挂载（MP20）+ C24 Agent 团队监控（MP21）+ C25 确认门裁决+卡片干预（MP22）+ C26 计划编辑（MP23）+ C27 分叉/预览/草稿（MP24）+ C28 作品库批量管理（MP25）+ C29 设置页完善（MP26）+ C30 资产库批量管理（MP27）+ C31 产物一键存为资产（MP28）+ C32 作业进度 SSE 化（MP29）+ C33 对话助手附图（MP30）+ C34 微信登录原生 button 重写（MP32）
 * 前置：mock-server (9800) + h5 静态服务 (9810) 均已启动
 * 用法：node scripts/ux-walkthrough-h5.mjs
 * 产出：docs/ux-walkthrough/*.png + 控制台结构化报告（非零退出 = 有失败检查点）
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const globalRoot = execSync('npm root -g').toString().trim();
const require = createRequire(join(globalRoot, 'playwright', 'index.js'));
const { chromium } = require('playwright');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, '..', 'docs', 'ux-walkthrough');
mkdirSync(SHOTS, { recursive: true });

const H5 = 'http://localhost:9810';
const API = 'http://localhost:9800';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** 等 hash 路由变化（uni-h5 用 history api，不触发 navigation） */
async function waitHash(page, pattern, timeout = 6000) {
  await page.waitForFunction(
    (p) => new RegExp(p).test(window.location.hash),
    pattern,
    { timeout },
  );
}

/**
 * 引擎项落入底部 tab-bar 遮挡区时 Playwright click 会被 hit-test 拦截：
 * dispatchEvent 直接派发到目标元素（uni-h5 @tap 编译为 DOM click 监听，不校验 isTrusted）。
 * 遮挡本身是 H5 抽屉超高（SFW 上下文 12 引擎）的测试环境现象，非产品缺陷。
 */
async function clickEngine(page, label) {
  const item = page.locator(`.engine-item:has-text("${label}")`).first();
  await item.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await item.dispatchEvent('click');
}

/**
 * 等含指定关键词的「可见」icon:none toast 并原子取全文（MP25）：
 * uni-h5 toast 渲染为 .uni-simple-toast__text，隐藏态元素残留 DOM（vShow），
 * 仅 waitForSelector + first() 会读到历史 toast 文本（C28.2 实证串到 C27.3 的「已创建分叉会话」）。
 * 可见性用 getBoundingClientRect（fixed 定位下 offsetParent 恒 null 不可用）。
 */
async function waitToastText(page, keyword, timeout = 6000) {
  try {
    const handle = await page.waitForFunction(
      (kw) => {
        const els = Array.from(document.querySelectorAll('.uni-simple-toast__text'));
        for (const el of els) {
          const t = (el.textContent ?? '').trim();
          const r = el.getBoundingClientRect();
          if (t.includes(kw) && r.width > 0 && r.height > 0) return t;
        }
        return false;
      },
      keyword,
      { timeout },
    );
    return await handle.jsonValue();
  } catch {
    return '';
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // iPhone 14 逻辑分辨率
  permissions: ['clipboard-read', 'clipboard-write'], // C29.3 剪贴板断言
});

// app 脚本执行前注入 settings：API 指到 mock
await context.addInitScript((api) => {
  window.localStorage.setItem(
    'toiv.settings',
    JSON.stringify({
      paletteId: 'atelier',
      mode: 'light',
      apiBaseOverride: api,
      nsfwIntent: false,
    }),
  );
}, API);

const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

// 归零 mock 计数器（轮询演示状态跨运行会污染）
await fetch(`${API}/__reset`);

try {
  // ---------- C1 登录（uni-h5：class 落在 uni-input 外壳，原生 input 在内层） ----------
  // MP32 原生 button 重写：提交钮为 .login__submit（H5 无微信 CTA，条件编译剔除）
  await page.goto(`${H5}/#/pages/login/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.field__input input', { timeout: 4000 });
  await page.locator('.field__input input').first().fill('ux-walkthrough@toiv.dev');
  await page.locator('.field__input--password input').fill('mock-pass-123');
  await shot(page, '01-login-filled');
  await page.locator('.login__form .login__submit').first().click();
  // uni-h5 首页路由规范化为 #/（不是 #/pages/index/index），以内容判定到达
  await page.waitForSelector('textarea', { timeout: 8000 });
  check('C1 登录提交 → 跳转创作页', true);

  // ---------- C2 创作页 ----------
  await page.waitForSelector('text=SDXL 文生图', { timeout: 6000 });
  check('C2.1 引擎列表加载（mock /models/engines）', true);
  const promptBox = page.locator('textarea').first();
  await promptBox.fill('胶片暗房里的一只猫，柔光，35mm');
  await shot(page, '02-create-filled');

  // ---------- C8 引擎栅格：全引擎在册（MP14 起 avatar-talk 已接入，不再存在未接入禁用态） ----------
  await page.locator('.create__engine-btn').click();
  await page.waitForSelector('.engine-item', { timeout: 6000 });
  const avatarItem = page.locator('.engine-item:has-text("LongCat-Avatar")').first();
  const avatarClass =
    (await avatarItem.count()) > 0 ? ((await avatarItem.getAttribute('class')) ?? '') : '';
  const soonCount = await page.locator('.engine-item__reason:has-text("即将支持")').count();
  check(
    'C8.1 全引擎已接入（avatar-talk 可点选，无「即将支持」禁用态）',
    avatarClass.length > 0 && !avatarClass.includes('engine-item--disabled') && soonCount === 0,
    `class=${avatarClass} soon=${soonCount}`,
  );
  await shot(page, '08-engine-sheet-all-supported');

  // ---------- MP12：SFW 上下文后端已过滤 R18 引擎 → 抽屉内不应出现 R18 徽标 ----------
  const sfwBadges = await page.locator('.engine-item__badge').count();
  check('C8.2 SFW 上下文无 R18 引擎（X-NSFW 过滤生效）', sfwBadges === 0, `${sfwBadges} 枚徽标`);

  // ---------- C9 ltx25-t2v：无参考媒体字段 → 提交成功（MP10） ----------
  await clickEngine(page, 'LTX 2.5 文生视频');
  await page.waitForTimeout(600);
  const refFieldCount = await page.locator('.ref-image, .ref-video').count();
  check('C9.1 ltx25-t2v 参数区渲染（无参考图/视频字段）', refFieldCount === 0);
  await page.locator('.ui-btn:has-text("生成")').first().click();
  let videoNavOk = true;
  try {
    await waitHash(page, 'pages/jobs/jobs', 8000);
  } catch {
    videoNavOk = false;
  }
  check('C9.2 ltx25-t2v 提交成功 → 跳作业页', videoNavOk, page.url());
  await shot(page, '09-ltx25-t2v-submitted');

  // ---------- C10 wan-vace：多参考图字段渲染（MP10） ----------
  await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea', { timeout: 8000 });
  await page.locator('.create__engine-btn').click();
  await page.waitForSelector('.engine-item', { timeout: 6000 });
  await clickEngine(page, 'VACE 多参考视频');
  await page.waitForTimeout(600);
  const multiLabel = (await page.locator('text=参考图（1-4 张）').count()) > 0;
  const multiCount = (await page.locator('.ref-image__count').count()) > 0;
  check('C10.1 wan-vace 多参考图字段渲染（计数 0/4）', multiLabel && multiCount);
  await shot(page, '10-wan-vace-multi-image');

  // ---------- C11 h3-t2v：LoRA 多选 + 强度滑杆 → 提交成功（MP11） ----------
  await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea', { timeout: 8000 });
  await page.locator('textarea').first().fill('海港黄昏，胶片质感，音画同发');
  await page.locator('.create__engine-btn').click();
  await page.waitForSelector('.engine-item', { timeout: 6000 });
  await clickEngine(page, 'MiniMax H3 文生视频');
  await page.waitForTimeout(600);
  await page.locator('.create__params-btn').click();
  await page.waitForSelector('.loras-field__row', { timeout: 6000 });
  const loraRows = await page.locator('.loras-field__row').count();
  check('C11.1 h3-t2v 参数抽屉 LoRA 选项渲染', loraRows === 4, `${loraRows} 行`);
  await shot(page, '11a-h3-loras-options');
  // 选中第 1 个 LoRA → 强度滑杆出现 + 计数 1/3
  await page.locator('.loras-field__row').first().click();
  await page.waitForTimeout(400);
  const sliderCount = await page.locator('.loras-field__slider').count();
  const loraCountText =
    (await page.locator('.loras-field__count').count()) > 0
      ? ((await page.locator('.loras-field__count').first().textContent()) ?? '')
      : '';
  check(
    'C11.2 选中 LoRA → 强度滑杆 + 计数 1/3',
    sliderCount === 1 && loraCountText.includes('1/3'),
    `slider=${sliderCount} count=${loraCountText.trim()}`,
  );
  await shot(page, '11b-h3-lora-selected');
  // 关抽屉（mask 中心被 panel 覆盖，走 header 的 X 按钮）→ 提交
  await page.locator('.ui-sheet__close').first().click();
  await page.waitForTimeout(400);
  await page.locator('.ui-btn:has-text("生成")').first().click();
  let h3NavOk = true;
  try {
    await waitHash(page, 'pages/jobs/jobs', 8000);
  } catch {
    h3NavOk = false;
  }
  check('C11.3 h3-t2v 提交成功 → 跳作业页', h3NavOk, page.url());
  await shot(page, '11c-h3-t2v-submitted');

  // ---------- C12 longcat-continue：源视频必填校验 → 填 URL 后提交成功（MP11） ----------
  await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea', { timeout: 8000 });
  await page.locator('textarea').first().fill('镜头继续向前推进，穿过云层');
  await page.locator('.create__engine-btn').click();
  await page.waitForSelector('.engine-item', { timeout: 6000 });
  await clickEngine(page, 'LongCat 视频续写');
  await page.waitForTimeout(600);
  // 空源视频直接提交 → 表单错误拦截
  await page.locator('.ui-btn:has-text("生成")').first().click();
  await page.waitForTimeout(500);
  const continueErr =
    (await page.locator('.create__error-banner').count()) > 0
      ? ((await page.locator('.create__error-banner').first().textContent()) ?? '')
      : '';
  check('C12.1 longcat-continue 空源视频拦截提示', continueErr.includes('源视频'), continueErr.trim());
  await shot(page, '12a-longcat-continue-blocked');
  // 参数抽屉第一个文本参数即源视频（注册表 text 类型）→ 填产物 URL → 提交
  await page.locator('.create__params-btn').click();
  await page.waitForSelector('.param__input input', { timeout: 6000 });
  await page.locator('.param__input input').first().fill('/api/images?path=outputs/a.mp4');
  await shot(page, '12b-longcat-continue-video-filled');
  await page.locator('.ui-sheet__close').first().click();
  await page.waitForTimeout(400);
  await page.locator('.ui-btn:has-text("生成")').first().click();
  let lcNavOk = true;
  try {
    await waitHash(page, 'pages/jobs/jobs', 8000);
  } catch {
    lcNavOk = false;
  }
  check('C12.2 longcat-continue 填源视频后提交成功 → 跳作业页', lcNavOk, page.url());
  await shot(page, '12c-longcat-continue-submitted');

  // ---------- C13 ace-music：音频引擎（kind=audio）无参考媒体 → 提交成功（MP11） ----------
  await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea', { timeout: 8000 });
  await page.locator('textarea').first().fill('lo-fi hip hop, rainy night, 90bpm');
  await page.locator('.create__engine-btn').click();
  await page.waitForSelector('.engine-item', { timeout: 6000 });
  await clickEngine(page, 'ACE 文生音乐');
  await page.waitForTimeout(600);
  const aceRefFields = await page.locator('.ref-image, .ref-video').count();
  check('C13.1 ace-music 参数区渲染（无参考媒体字段）', aceRefFields === 0);
  await page.locator('.ui-btn:has-text("生成")').first().click();
  let aceNavOk = true;
  try {
    await waitHash(page, 'pages/jobs/jobs', 8000);
  } catch {
    aceNavOk = false;
  }
  check('C13.2 ace-music 提交成功 → 跳作业页', aceNavOk, page.url());
  await shot(page, '13-ace-music-submitted');

  // ---------- C18 avatar-talk：人像首帧 + 驱动音频双字段 → 互钉上传 → 提交成功（MP14） ----------
  await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea', { timeout: 8000 });
  await page.locator('textarea').first().fill('一位女士面对镜头自然说话，柔光胶片质感');
  await page.locator('.create__engine-btn').click();
  await page.waitForSelector('.engine-item', { timeout: 6000 });
  await clickEngine(page, 'LongCat-Avatar 数字人');
  await page.waitForTimeout(600);
  // C18.1 双字段渲染：单图字段标签取注册表 images label「人像首帧」，text 占位 audio 键渲染为上传字段
  const avatarImgLabel =
    (await page.locator('.ref-image__label').count()) > 0
      ? ((await page.locator('.ref-image__label').first().textContent()) ?? '')
      : '';
  const avatarAudioFields = await page.locator('.ref-audio').count();
  check(
    'C18.1 avatar-talk 人像首帧 + 驱动音频字段渲染',
    avatarImgLabel.includes('人像首帧') && avatarAudioFields === 1,
    `imgLabel=${avatarImgLabel.trim()} audio=${avatarAudioFields}`,
  );
  await shot(page, '18a-avatar-fields');
  // C18.2 参数抽屉剔除 text 占位 audio 键（由音频上传字段承担，不误渲为文本框）
  await page.locator('.create__params-btn').click();
  await page.waitForSelector('.param', { timeout: 6000 });
  const paramCount = await page.locator('.param').count();
  const audioTextParams = await page.locator('.param__label:has-text("驱动音频")').count();
  check(
    'C18.2 参数抽屉剔除 text 占位 audio 键（其余参数在册）',
    paramCount > 0 && audioTextParams === 0,
    `params=${paramCount} audioText=${audioTextParams}`,
  );
  await page.locator('.ui-sheet__close').first().click();
  await page.waitForTimeout(400);
  // C18.3 缺媒体时生成钮禁用（canSubmit：缺人像 + 缺音频）
  const avatarBlocked = await page.locator('.ui-btn--disabled:has-text("生成")').count();
  check('C18.3 缺人像/音频时生成钮禁用', avatarBlocked > 0);
  await shot(page, '18b-avatar-blocked');
  // C18.4 上传人像首帧（filechooser 拦截 uni.chooseImage，mock 上传回显文件名）
  const PNG_1PX_AVATAR = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const [avatarImgChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.ref-image__picker').click(),
  ]);
  await avatarImgChooser.setFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: PNG_1PX_AVATAR });
  await page.waitForSelector('.ref-image__preview', { timeout: 8000 });
  // 仅人像就绪仍缺音频 → 生成钮保持禁用
  const avatarHalfReady = await page.locator('.ui-btn--disabled:has-text("生成")').count();
  check('C18.4 人像首帧上传就绪（缺音频仍禁用）', avatarHalfReady > 0);
  await shot(page, '18c-avatar-image-uploaded');
  // C18.5 上传驱动音频（filechooser 拦截 uni.chooseFile，钉人像 worker）
  const [avatarAudChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.ref-audio__picker').click(),
  ]);
  await avatarAudChooser.setFiles({ name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFFmock') });
  await page.waitForSelector('.ref-audio__card', { timeout: 8000 });
  const avatarReady = await page.locator('.ui-btn--disabled:has-text("生成")').count();
  check('C18.5 驱动音频上传就绪 → 生成钮放行', avatarReady === 0);
  await shot(page, '18d-avatar-audio-uploaded');
  // C18.6 提交（POST /api/avatar/talk）→ 跳作业页
  await page.locator('.ui-btn:has-text("生成")').first().click();
  let avatarNavOk = true;
  try {
    await waitHash(page, 'pages/jobs/jobs', 8000);
  } catch {
    avatarNavOk = false;
  }
  check('C18.6 avatar-talk 提交成功 → 跳作业页', avatarNavOk, page.url());
  await shot(page, '18e-avatar-submitted');

  // ---------- C3 作业页 ----------
  await page.goto(`${H5}/#/pages/jobs/jobs`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.job-card', { timeout: 6000 });
  const cardCount = await page.locator('.job-card').count();
  check('C3.1 作业列表渲染', cardCount >= 2, `${cardCount} 张卡片`);
  await shot(page, '03-jobs-list');

  // ---------- C4 作业卡片点击 → 详情页（job-card click 契约修复验证） ----------
  // 列表序 = [running, done]，必须点“已完成”卡（running 卡点击是 toast 提示，属正确行为）
  await page.locator('.job-card:has-text("已完成")').first().click();
  let navOk = true;
  try {
    await waitHash(page, 'pages-sub/artifact/artifact', 5000);
  } catch {
    navOk = false;
  }
  check('C4.1 点击作业卡片 → 跳转详情页', navOk, page.url());
  await shot(page, '04-artifact-from-jobs');

  if (navOk) {
    // ---------- C5 详情页操作 ----------
    // eventChannel 传递 job → 不应停在“加载中”；uni-h5 的 image 渲染为 uni-image，按 class 判定
    await page.waitForTimeout(1000);
    const stuckLoading = (await page.locator('text=加载中').count()) > 0;
    check('C5.1 详情页 eventChannel 数据到达', !stuckLoading);
    const mediaCount = await page.locator('.artifact__media').count();
    check('C5.2 详情页预览区渲染', mediaCount > 0, `${mediaCount} 个媒体位`);
    const actionCount = await page.locator('.artifact__icon-btn').count();
    check('C5.3 详情页操作钮（复用/重新生成/下载/删除）', actionCount >= 3, `${actionCount} 个`);
  }

  // ---------- C6 作品库过滤 ----------
  await page.goto(`${H5}/#/pages/library/library`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const chips = await page.locator('.chip, [class*="filter"]').count();
  check('C6.1 作品库过滤芯片渲染', chips > 0, `${chips} 个芯片`);
  await shot(page, '05-library');

  // ---------- C19 作品库无限分页（MP15，mock 52 件 done 作品 = 24+24+4 三页） ----------
  // uni-h5 已知缺陷取证（MP15 探针复现）：hash 跳转累计 ≥3 次后，uni-h5 页栈滚动监听
  // 派发的 onReachBottom 静默丢失（监听器在、滚动在、事件不入页钩）；与访问哪个页面无关，
  // 纯导航次数触发。微信小程序/真机走原生 onReachBottom 无此问题，仅 H5 走查环境规避：
  // 整页刷新重进作品库（token 在 localStorage 持久，作品库成为入口页 = 零导航态）。
  await page.goto(`${H5}/#/pages/library/library`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });

  const scrollLibToBottom = async () => {
    await page.evaluate(() => {
      const se = document.scrollingElement ?? document.documentElement;
      window.scrollTo(0, se.scrollHeight);
    });
    await page.waitForTimeout(500);
  };
  const libCardIds = () =>
    page.$$eval('.library__card', (els) => els.map((el) => el.getAttribute('data-job-id') ?? '?'));

  // C19.1 首屏第一页 24 卡（页大小 24 = 2/3/4 列公倍数，满页整行填满）
  let firstPageOk = true;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.library__card').length === 24,
      { timeout: 8000 },
    );
  } catch {
    firstPageOk = false;
  }
  check('C19.1 首屏渲染第一页（24 卡）', firstPageOk, `${await page.locator('.library__card').count()} 卡`);

  // C19.2 触底追加第二页（48 卡，id 无重复）
  await scrollLibToBottom();
  let page2Ok = true;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.library__card').length === 48,
      { timeout: 8000 },
    );
  } catch {
    page2Ok = false;
  }
  const ids48 = await libCardIds();
  check(
    'C19.2 触底追加第二页（48 卡且 id 无重复）',
    page2Ok && ids48.length === 48 && new Set(ids48).size === 48,
    `${ids48.length} 卡 去重后 ${new Set(ids48).size}`,
  );
  await shot(page, '19a-library-page2');

  // C19.3 再触底 → 尾页 4 卡收齐（共 52 无重复）+ 结尾态「没有更多了」
  await scrollLibToBottom();
  let page3Ok = true;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.library__card').length === 52,
      { timeout: 8000 },
    );
  } catch {
    page3Ok = false;
  }
  await scrollLibToBottom(); // 尾页后再触底确认不再增长
  const ids52 = await libCardIds();
  const endText = ((await page.locator('.library__more').first().textContent()) ?? '').trim();
  check(
    'C19.3 尾页收齐（共 52 卡无重复）+ 结尾态「没有更多了」',
    page3Ok && ids52.length === 52 && new Set(ids52).size === 52 && endText.includes('没有更多了'),
    `${ids52.length} 卡 footer=${endText}`,
  );
  await shot(page, '19b-library-end');

  // C19.4 【MP16 服务端过滤】全量已加载 52 卡时点「音频」→ 重置分页按 kind 重查 → 整库 5 卡
  // （语义变更：MP15 客户端过滤只作用于已加载流；MP16 切换过滤桶整库生效，不满页即「没有更多了」）
  await page.locator('.library__chip:has-text("音频")').first().click();
  let audioOk = true;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.library__card').length === 5,
      { timeout: 8000 },
    );
  } catch {
    audioOk = false;
  }
  const audioIds = await libCardIds();
  const audioEnd = ((await page.locator('.library__more').first().textContent()) ?? '').trim();
  check(
    'C19.4 过滤「音频」服务端整库生效（5 卡无重复，不满页即结尾态）',
    audioOk && new Set(audioIds).size === 5 && audioEnd.includes('没有更多了'),
    `${audioIds.length} 卡 footer=${audioEnd}`,
  );
  await shot(page, '19c-library-filter-audio');

  // C19.5 【MP16 核心场景】稀疏类型跨页命中：首屏仅第一页 24 卡（音频仅 2 件）时点「音频」，
  // 服务端过滤直接返回整库 5 件——MP15 客户端方案在此场景只能拿到已加载流中的 2 件（结果不完整根因）
  await page.locator('.library__chip:has-text("全部")').first().click();
  await page.waitForTimeout(300);
  await page.goto(`${H5}/#/pages/jobs/jobs`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.job-card', { timeout: 8000 });
  await page.goto(`${H5}/#/pages/library/library`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelectorAll('.library__card').length === 24,
    { timeout: 8000 },
  );
  await page.locator('.library__chip:has-text("音频")').first().click();
  let sparseOk = true;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.library__card').length === 5,
      { timeout: 8000 },
    );
  } catch {
    sparseOk = false;
  }
  const sparseIds = await libCardIds();
  check(
    'C19.5 稀疏类型跨页命中：第一页仅 2 件音频时点「音频」→ 整库 5 卡（MP16 修复场景）',
    sparseOk && new Set(sparseIds).size === 5,
    `${sparseIds.length} 卡`,
  );
  await shot(page, '19d-library-filter-sparse');

  // C19.6 切回「全部」：分页随 kind 重置 → 重新拉取第一页 24 卡（非 MP15 的已加载流原样保留）
  await page.locator('.library__chip:has-text("全部")').first().click();
  let backAllOk = true;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.library__card').length === 24,
      { timeout: 8000 },
    );
  } catch {
    backAllOk = false;
  }
  check(
    'C19.6 切回「全部」分页随 kind 重置 → 第一页 24 卡',
    backAllOk,
    `${await page.locator('.library__card').count()} 卡`,
  );

  // C19.7 下拉刷新重置 offset=0 → 回第一页 24 卡（新完成作业回顶部语义）
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const pdrFired = await page.evaluate(() => {
    const u = window.uni;
    if (u && typeof u.startPullDownRefresh === 'function') {
      u.startPullDownRefresh();
      return true;
    }
    return false;
  });
  let backToFirst = false;
  if (pdrFired) {
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('.library__card').length === 24,
        { timeout: 8000 },
      );
      backToFirst = true;
    } catch {
      backToFirst = false;
    }
  }
  if (!backToFirst) {
    // H5 无原生下拉手势时退化为 onShow 重进（同一 refresh() 重置路径）
    await page.goto(`${H5}/#/pages/jobs/jobs`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.job-card', { timeout: 8000 });
    await page.goto(`${H5}/#/pages/library/library`, { waitUntil: 'networkidle' });
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('.library__card').length === 24,
        { timeout: 8000 },
      );
      backToFirst = true;
    } catch {
      backToFirst = false;
    }
  }
  check(
    'C19.7 下拉刷新重置 → 回第一页 24 卡',
    backToFirst,
    pdrFired ? 'uni.startPullDownRefresh' : 'onShow 重进（同 refresh 路径）',
  );
  await shot(page, '19e-library-refreshed');

  // ---------- C7 我的 / 主题切换 ----------
  await page.goto(`${H5}/#/pages/profile/profile`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '06-profile');
  // 主题变量挂在页面根容器（:style="themeVars"），body 背景恒透明，测 --color-bg
  const bgBefore = await page.evaluate(() => {
    const el = document.querySelector('.profile');
    return el ? getComputedStyle(el).getPropertyValue('--color-bg').trim() : '';
  });
  await page.locator('.profile__mode:has-text("深色")').first().click();
  await page.waitForTimeout(500);
  const bgAfter = await page.evaluate(() => {
    const el = document.querySelector('.profile');
    return el ? getComputedStyle(el).getPropertyValue('--color-bg').trim() : '';
  });
  check(
    'C7.1 深浅模式切换生效',
    bgBefore.length > 0 && bgBefore !== bgAfter,
    `${bgBefore} → ${bgAfter}`,
  );
  await shot(page, '07-profile-dark');

  // ---------- C17 参考资产库（MP13）：管理 CRUD + 创作页引用 ----------
  // 恢复浅色模式（C7 切了深色，保持后续截图一致性）
  await page.locator('.profile__mode:has-text("浅色")').first().click();
  await page.waitForTimeout(400);

  // C17.1 我的页入口 → 资产库页（空态 + 新建引导）
  await page.locator('.profile__row:has-text("参考资产库")').first().click();
  let assetsNavOk = true;
  try {
    await waitHash(page, 'pages/assets/index', 5000);
  } catch {
    assetsNavOk = false;
  }
  check('C17.1 我的页入口 → 资产库页', assetsNavOk, page.url());
  // 列表拉取为异步（onShow → load），先等空态出现再断言，避免 loading 窗口误判
  let assetsEmpty = true;
  try {
    await page.waitForSelector('text=还没有参考资产', { timeout: 6000 });
  } catch {
    assetsEmpty = false;
  }
  check('C17.2 空态文案 + 新建引导渲染', assetsEmpty);
  await shot(page, '17a-assets-empty');

  // C17.3 新建角色资产：弹层填名称 → filechooser 拦截 uni.chooseImage（mock 上传）→ 创建
  await page.locator('.ui-btn:has-text("新建资产")').first().click();
  await page.waitForSelector('.asset-form__name-input input', { timeout: 6000 });
  await page.locator('.asset-form__name-input input').fill('胶片主角卡');
  const PNG_1PX_WALK = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const [assetChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.asset-form__picker').click(),
  ]);
  await assetChooser.setFiles({ name: 'ref.png', mimeType: 'image/png', buffer: PNG_1PX_WALK });
  // 上传完成回显预览缩略图（H5 blob: URL 走 validateRefImage 放行 + uni uploadFile urlToFile）
  await page.waitForSelector('.asset-form__preview', { timeout: 8000 });
  await shot(page, '17b-asset-editor-filled');
  await page.locator('.ui-btn:has-text("创建")').first().click();
  await page.waitForSelector('.assets__card', { timeout: 8000 });
  const cardName = (await page.locator('.assets__name').first().textContent()) ?? '';
  const cardMeta = (await page.locator('.assets__meta').first().textContent()) ?? '';
  check(
    'C17.3 创建角色资产（mock 上传）→ 卡片渲染（名称 + 角色徽标 + 1 张）',
    cardName.includes('胶片主角卡') && cardMeta.includes('角色') && cardMeta.includes('1 张'),
    `${cardName.trim()} | ${cardMeta.trim()}`,
  );
  await shot(page, '17c-assets-card');

  // C17.4-C17.6 创作页引用：wan-vace 多图字段 → 资产选择器 → 点选回填（句柄复用不重新上传）
  await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea', { timeout: 8000 });
  await page.locator('.create__engine-btn').click();
  await page.waitForSelector('.engine-item', { timeout: 6000 });
  await clickEngine(page, 'VACE 多参考视频');
  await page.waitForTimeout(600);
  await page.locator('.ui-btn:has-text("从资产库选择")').first().click();
  await page.waitForSelector('.asset-picker__row', { timeout: 8000 });
  await shot(page, '17d-asset-picker');
  const pickerRowText = (await page.locator('.asset-picker__row').first().textContent()) ?? '';
  check(
    'C17.4 创作页打开资产选择器（列表含新建资产）',
    pickerRowText.includes('胶片主角卡'),
    pickerRowText.trim(),
  );
  await page.locator('.asset-picker__row').first().click(); // 展开图片网格
  await page.waitForSelector('.asset-picker__img', { timeout: 6000 });
  await page.locator('.asset-picker__img').first().click(); // 点选第 1 张（多图追加，选择器保持打开）
  await page.waitForTimeout(600);
  const refCountText = (await page.locator('.ref-image__count').first().textContent()) ?? '';
  check('C17.5 点选资产图回填 → 多图计数 1/4', refCountText.includes('1/4'), refCountText.trim());
  await page.locator('.ui-sheet__close').first().click();
  await page.waitForTimeout(400);
  const refPreviewCount = await page.locator('.ref-image__preview').count();
  // 预览 img src 命中资产图代理 = 句柄直接复用（上传路径的 previewUri 会是 blob:）
  const assetProxyUsed = await page.evaluate(() =>
    Array.from(document.images).some((im) => im.src.includes('/api/assets/')),
  );
  check(
    'C17.6 回填预览走资产图代理（句柄复用，未重新上传）',
    refPreviewCount === 1 && assetProxyUsed,
    `preview=${refPreviewCount} proxy=${assetProxyUsed}`,
  );
  await shot(page, '17e-create-ref-filled');

  // C17.7-C17.8 编辑改名（回显 + PATCH 差量）→ 列表名称更新
  await page.goto(`${H5}/#/pages/assets/index`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.assets__card', { timeout: 8000 });
  await page.locator('.assets__card').first().click();
  await page.waitForSelector('.asset-form__name-input input', { timeout: 6000 });
  const echoName = await page.locator('.asset-form__name-input input').inputValue();
  const echoImages = await page.locator('.asset-form__preview').count();
  check(
    'C17.7 编辑弹层回显（名称 + 图片句柄原样保留）',
    echoName === '胶片主角卡' && echoImages === 1,
    `name=${echoName} images=${echoImages}`,
  );
  await page.locator('.asset-form__name-input input').fill('主角三视图');
  await page.locator('.ui-btn:has-text("保存")').first().click();
  await page.waitForTimeout(800);
  const renamedText = (await page.locator('.assets__name').first().textContent()) ?? '';
  check('C17.8 改名保存（PATCH 差量）→ 列表名称更新', renamedText.includes('主角三视图'), renamedText.trim());
  await shot(page, '17f-asset-renamed');

  // C17.9 删除：卡片删除钮 → 二次确认（uni-modal）→ 列表回空态
  await page.locator('.assets__delete').first().click();
  await page.waitForSelector('.uni-modal__btn_primary', { timeout: 6000 });
  await shot(page, '17g-asset-delete-confirm');
  await page.locator('.uni-modal__btn_primary').click();
  await page.waitForTimeout(800);
  const afterDeleteEmpty = (await page.locator('text=还没有参考资产').count()) > 0;
  const afterDeleteCards = await page.locator('.assets__card').count();
  check('C17.9 二次确认删除 → 列表回空态', afterDeleteEmpty && afterDeleteCards === 0);
  await shot(page, '17h-assets-deleted');

  // ---------- C20 反推提示词（MP17）：showActionSheet + chooseImage/chooseVideo ----------
  // （uni.chooseMedia 未入 uni-h5 导出清单，MP17.2 修复为全端三件套；mock /api/reverse 按扩展名定 kind）
  await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea', { timeout: 8000 });

  // C20.1 反推按钮渲染（prompt 卡右下角 ghost 钮）
  const reverseBtn = page.locator('.create__reverse').first();
  const reverseBtnText = (await reverseBtn.textContent()) ?? '';
  check(
    'C20.1 创作页反推按钮渲染',
    (await reverseBtn.count()) > 0 && reverseBtnText.includes('反推'),
    reverseBtnText.trim(),
  );

  // C20.2 点反推 → action sheet 渲染（图片/视频/取消 三项 = chooseMedia 替代路径生效）
  await reverseBtn.click();
  let sheetItemCount = 0;
  try {
    await page.waitForSelector('.uni-actionsheet__cell', { timeout: 5000 });
    sheetItemCount = await page.locator('.uni-actionsheet__cell').count();
  } catch {
    sheetItemCount = 0;
  }
  check('C20.2 点反推 → action sheet 渲染（图片/视频/取消）', sheetItemCount >= 3, `${sheetItemCount} 项`);
  await shot(page, '20a-reverse-actionsheet');

  // C20.3 选「视频」→ filechooser 拦截 chooseVideo → prompt 回填视频文案；视频无 negative → 负向框不展开
  const [videoChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.uni-actionsheet__cell:has-text("视频")').first().click(),
  ]);
  await videoChooser.setFiles({
    name: 'walkthrough.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('mock-mp4-walkthrough-bytes'),
  });
  let videoPromptOk = false;
  try {
    await page.waitForFunction(
      () => (document.querySelector('textarea')?.value ?? '').startsWith('camera slowly pushes in'),
      { timeout: 8000 },
    );
    videoPromptOk = true;
  } catch {
    videoPromptOk = false;
  }
  const negativeToggleAfterVideo = await page.locator('.create__negative-toggle').count();
  check(
    'C20.3 视频反推 → prompt 回填；无 negative 不展开负向框',
    videoPromptOk && negativeToggleAfterVideo === 1,
    `prompt=${videoPromptOk} toggle=${negativeToggleAfterVideo}`,
  );
  await shot(page, '20b-reverse-video-filled');

  // C20.4 选「图片」→ filechooser 拦截 chooseImage → prompt 覆盖；negative 有值 → 负向框展开填入
  await reverseBtn.click();
  await page.waitForSelector('.uni-actionsheet__cell', { timeout: 5000 });
  const [imageChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.uni-actionsheet__cell:has-text("图片")').first().click(),
  ]);
  await imageChooser.setFiles({ name: 'walkthrough.png', mimeType: 'image/png', buffer: PNG_1PX_WALK });
  let imagePromptOk = false;
  try {
    await page.waitForFunction(
      () =>
        (document.querySelector('textarea')?.value ?? '').startsWith(
          'a cat sitting on a wooden table',
        ),
      { timeout: 8000 },
    );
    imagePromptOk = true;
  } catch {
    imagePromptOk = false;
  }
  await page.waitForTimeout(400);
  // uni-h5 的 class 落在 uni-textarea 外壳，原生 textarea 在内层（同 .field__input input 结构）
  const negativeInputValue = await page
    .locator('.create__negative-input textarea')
    .first()
    .inputValue()
    .catch(() => '');
  check(
    'C20.4 图片反推 → prompt 覆盖 + 负向框展开填入 mock negative',
    imagePromptOk && negativeInputValue.includes('blurry'),
    `prompt=${imagePromptOk} negative=${negativeInputValue.slice(0, 40)}`,
  );
  await shot(page, '20c-reverse-image-filled');

  // ---------- C21 优化提示词（MP18）：口语输入 → /api/optimize → 扩写回填 ----------
  await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea', { timeout: 8000 });
  // 引擎选择随 pinia 持久化，先切回图像引擎保证 kind=image 确定性（mock 图像类返回 masterpiece 前缀）
  await page.locator('.create__engine-btn').click();
  await page.waitForSelector('.engine-item', { timeout: 6000 });
  await clickEngine(page, 'SDXL 文生图');
  await page.waitForTimeout(600);
  await page.locator('textarea').first().fill('一只猫坐在沙发上');

  // C21.1 优化按钮渲染（prompt 卡右下角 ghost 钮，与反推并排）
  const optimizeBtn = page.locator('.create__optimize').first();
  const optimizeBtnText = (await optimizeBtn.textContent()) ?? '';
  check(
    'C21.1 创作页优化按钮渲染',
    (await optimizeBtn.count()) > 0 && optimizeBtnText.includes('优化'),
    optimizeBtnText.trim(),
  );

  // C21.2 点击优化 → prompt 覆盖为英文；negative 有值 → 负向框展开填入
  await optimizeBtn.click();
  let optimizePromptOk = false;
  try {
    await page.waitForFunction(
      () => (document.querySelector('textarea')?.value ?? '').startsWith('masterpiece, best quality'),
      { timeout: 8000 },
    );
    optimizePromptOk = true;
  } catch {
    optimizePromptOk = false;
  }
  const negativeAfterOptimize = await page
    .locator('.create__negative-input textarea')
    .first()
    .inputValue()
    .catch(() => '');
  check(
    'C21.2 优化 → prompt 扩写 + 负向框展开填入',
    optimizePromptOk && negativeAfterOptimize.includes('blurry'),
    `prompt=${optimizePromptOk} negative=${negativeAfterOptimize.slice(0, 40)}`,
  );
  await shot(page, '21-optimize-filled');

  // ---------- C22 对话助手（MP19）：入口 → SSE 流式对话 → 停止 → 历史回放/删除 ----------
  // C22.1 创作页 NavBar 助手入口 → 助手页空态渲染
  await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.create__assistant-btn', { timeout: 8000 });
  await page.locator('.create__assistant-btn').click();
  await waitHash(page, 'pages/assistant/assistant');
  await page.waitForSelector('text=和 ToIV 聊聊', { timeout: 6000 });
  check('C22.1 创作页助手入口 → 助手页空态渲染', true);
  await shot(page, '22a-assistant-empty');

  // C22.2 发送首轮 → 用户气泡 + 流式回复 + 生成图内联渲染 + 输入清空
  await page.locator('.assistant__textarea textarea').fill('画一只胶片风的猫');
  await page.locator('.assistant__send').click();
  await page.waitForSelector('.assistant__bubble--user', { timeout: 6000 });
  let replyOk = false;
  try {
    await page.waitForSelector('text=已按你的想法生成了一张图', { timeout: 8000 });
    replyOk = true;
  } catch {
    replyOk = false;
  }
  let imageOk = false;
  try {
    await page.waitForSelector('.assistant__media-image', { timeout: 8000 });
    imageOk = true;
  } catch {
    imageOk = false;
  }
  const draftAfterSend = await page.locator('.assistant__textarea textarea').inputValue();
  check(
    'C22.2 发送 → 流式回复 + 生成图内联渲染 + 输入清空',
    replyOk && imageOk && draftAfterSend === '',
    `reply=${replyOk} image=${imageOk} draft="${draftAfterSend}"`,
  );
  await shot(page, '22b-assistant-replied');

  // C22.3 流式中停止键 → 点击停止 → 发送键恢复（mock 5 帧×150ms，停止窗口内点击）
  await page.locator('.assistant__textarea textarea').fill('再画一张暖色调');
  await page.locator('.assistant__send').click();
  let stopOk = false;
  try {
    await page.waitForSelector('.assistant__send--stop', { timeout: 3000 });
    await page.locator('.assistant__send--stop').click();
    await page.waitForFunction(() => !document.querySelector('.assistant__send--stop'), {
      timeout: 6000,
    });
    stopOk = true;
  } catch {
    stopOk = false;
  }
  check('C22.3 流式中停止 → 中断后发送键恢复', stopOk);

  // C22.4 历史抽屉：会话条目渲染（标题 = 首条消息前缀回填）
  await page.locator('.assistant__nav-btn').nth(1).click();
  await page.waitForSelector('.assistant__session', { timeout: 6000 });
  const sessionTitle =
    (await page.locator('.assistant__session-title').first().textContent()) ?? '';
  check(
    'C22.4 历史抽屉列出会话（标题回填）',
    sessionTitle.includes('画一只胶片风的猫'),
    sessionTitle.trim(),
  );
  await shot(page, '22c-assistant-sessions');

  // C22.5 点会话 → 抽屉关闭 + 消息与媒体回放
  await page.locator('.assistant__session').first().click();
  let replayOk = false;
  try {
    await page.waitForSelector('.assistant__bubble--user', { timeout: 6000 });
    replayOk = (await page.locator('.assistant__media-image').count()) >= 1;
  } catch {
    replayOk = false;
  }
  check('C22.5 打开历史会话 → 消息+媒体回放', replayOk);
  await shot(page, '22d-assistant-replay');

  // C22.6 删除会话：二次确认 → 抽屉空 + 主区回空态（删的是当前会话 → newChat）
  await page.locator('.assistant__nav-btn').nth(1).click();
  await page.waitForSelector('.assistant__session-delete', { timeout: 6000 });
  await page.locator('.assistant__session-delete').first().click();
  await page.waitForSelector('.uni-modal__btn_primary', { timeout: 6000 });
  await page.locator('.uni-modal__btn_primary').click();
  let deleteOk = false;
  try {
    await page.waitForSelector('text=还没有历史会话', { timeout: 6000 });
    deleteOk = (await page.locator('text=和 ToIV 聊聊').count()) > 0;
  } catch {
    deleteOk = false;
  }
  check('C22.6 删除会话 → 抽屉空 + 主区回空态', deleteOk);
  await shot(page, '22e-assistant-deleted');

  // ---------- C23 文档挂载（MP20）：面板 → 上传 → chips 挂载/卸载 → document_ids 上行 → 删除 ----------
  // C23.0 前置：C22.6 删除会话后历史抽屉仍开（空态文案在抽屉内），先关抽屉回主区再开文档面板
  await page.locator('.ui-sheet__close').click();
  await page.waitForFunction(() => !document.querySelector('.ui-sheet'), { timeout: 6000 });

  // C23.1 文档钮 → 面板打开（空态：还没有文档，先上传一份吧）
  await page.locator('.assistant__docbtn:not(.assistant__imgbtn)').click();
  await page.waitForSelector('.assistant__docs-empty', { timeout: 6000 });
  const docsEmptyText = (await page.locator('.assistant__docs-empty-text').textContent()) ?? '';
  check('C23.1 文档面板打开 → 空态渲染', docsEmptyText.includes('还没有文档'), docsEmptyText.trim());
  await shot(page, '23a-docs-empty');

  // C23.2 上传两份文档（filechooser 拦截 uni.chooseFile）→ 列表渲染 + 双双自动挂载（check 标记）
  const [docChooser1] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.assistant__doc-upload').click(),
  ]);
  await docChooser1.setFiles({
    name: '需求笔记.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('MP20 走查文档一：暗房风格需求要点'),
  });
  await page.waitForSelector('.assistant__doc', { timeout: 8000 });
  const [docChooser2] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.assistant__doc-upload').click(),
  ]);
  await docChooser2.setFiles({
    name: '接口约定.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# MP20 走查文档二'),
  });
  await page.waitForFunction(() => document.querySelectorAll('.assistant__doc').length === 2, {
    timeout: 8000,
  });
  const docRowCount = await page.locator('.assistant__doc').count();
  const docCheckCount = await page.locator('.assistant__doc-check').count();
  const docRowNames = await page.locator('.assistant__doc-name').allTextContents();
  check(
    'C23.2 上传两份文档 → 列表渲染 + 双双自动挂载',
    docRowCount === 2 &&
      docCheckCount === 2 &&
      docRowNames.some((n) => n.includes('需求笔记.txt')) &&
      docRowNames.some((n) => n.includes('接口约定.md')),
    `rows=${docRowCount} checks=${docCheckCount} names=${docRowNames.join('|')}`,
  );
  await shot(page, '23b-docs-uploaded');

  // C23.3 关面板 → chips×2；chip X 卸载首枚（需求笔记）→ 剩接口约定
  await page.locator('.ui-sheet__close').click();
  await page.waitForSelector('.assistant__chip', { timeout: 6000 });
  const chipsBefore = await page.locator('.assistant__chip').count();
  await page.locator('.assistant__chip-x').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.assistant__chip').length === 1, {
    timeout: 6000,
  });
  const chipRemainName = (await page.locator('.assistant__chip-name').first().textContent()) ?? '';
  check(
    'C23.3 chips 行 ×2 → chip X 卸载首枚剩「接口约定.md」',
    chipsBefore === 2 && chipRemainName.includes('接口约定.md'),
    `before=${chipsBefore} remain=${chipRemainName.trim()}`,
  );
  await shot(page, '23c-docs-chip');

  // C23.4 发送 → document_ids 上行（mock 回显已挂载 1 份）+ chips 清空 + user 气泡文档留痕
  await page.locator('.assistant__textarea textarea').fill('按这份文档总结要点');
  await page.locator('.assistant__send').click();
  let docEchoOk = false;
  try {
    await page.waitForSelector('text=已挂载 1 份文档：接口约定.md', { timeout: 8000 });
    docEchoOk = true;
  } catch {
    docEchoOk = false;
  }
  const chipsAfterSend = await page.locator('.assistant__chip').count();
  const userDocRef = (await page.locator('.assistant__doc-ref-name').first().textContent()) ?? '';
  check(
    'C23.4 发送 → document_ids 上行回显 + chips 清空 + user 气泡留痕',
    docEchoOk && chipsAfterSend === 0 && userDocRef.includes('接口约定.md'),
    `echo=${docEchoOk} chips=${chipsAfterSend} ref=${userDocRef.trim()}`,
  );
  await shot(page, '23d-docs-sent');

  // C23.5 重开面板 → 删除文档（二次确认）→ 列表减一
  await page.locator('.assistant__docbtn:not(.assistant__imgbtn)').click();
  await page.waitForSelector('.assistant__doc', { timeout: 6000 });
  const docsBeforeDelete = await page.locator('.assistant__doc').count();
  await page.locator('.assistant__doc-delete').first().click();
  await page.waitForSelector('.uni-modal__btn_primary', { timeout: 6000 });
  await page.locator('.uni-modal__btn_primary').click();
  let docDeleteOk = false;
  try {
    await page.waitForFunction(
      (n) => document.querySelectorAll('.assistant__doc').length === n - 1,
      docsBeforeDelete,
      { timeout: 6000 },
    );
    docDeleteOk = true;
  } catch {
    docDeleteOk = false;
  }
  check(
    'C23.5 面板删除文档（二次确认）→ 列表减一',
    docDeleteOk && docsBeforeDelete === 2,
    `${docsBeforeDelete}→${docsBeforeDelete - 1}`,
  );
  await shot(page, '23e-docs-deleted');
  await page.locator('.ui-sheet__close').click();

  // ---------- C24 Agent 团队监控（MP21）：列表过滤 / 详情 SSE 接力 / 取消 / 确认门 ----------
  // 种子：3 条 run —— run-A 执行中（SSE 接力到 done）/ run-B 确认门（回放 confirm_required）/ run-C 规划中
  const seedRes = await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentRuns: [
        { goal: '雨夜侦探短片', status: 'running', scenario: 'success' },
        {
          goal: '咖啡店开业宣传片',
          status: 'awaiting_confirm',
          scenario: 'gate',
          history: [
            { event: 'ack', data: { message: '已拆成 3 步', level: 'L2' } },
            { event: 'confirm_required', data: { gate: 'plan', message: '请确认计划' } },
          ],
        },
        { goal: '产品功能介绍动画', status: 'planning', scenario: 'pending' },
      ],
    }),
  }).then((r) => r.json());
  const [successRun, gateRun] = seedRes.runs;

  // C24.1 作业页 nav 区 Agent 入口 → 运行列表页
  await page.goto(`${H5}/#/pages/jobs/jobs`);
  await page.waitForSelector('[data-action="open-agent-runs"]', { timeout: 8000 });
  await shot(page, '24a-jobs-agent-entry');
  await page.locator('[data-action="open-agent-runs"]').click();
  let c24Nav = true;
  try {
    await waitHash(page, 'pages/agent-runs/agent-runs', 6000);
  } catch {
    c24Nav = false;
  }
  check('C24.1 作业页 Agent 入口 → 运行列表页', c24Nav, page.url());

  // C24.2 列表渲染：3 卡 + 状态徽章文案（执行中/待确认计划/规划中）
  await page.waitForSelector('.runs__card', { timeout: 8000 });
  const runCardCount = await page.locator('.runs__card').count();
  const runListText = (await page.locator('.runs__list').textContent()) ?? '';
  check(
    'C24.2 列表渲染 3 卡（执行中/待确认计划/规划中徽章）',
    runCardCount === 3 &&
      runListText.includes('执行中') &&
      runListText.includes('待确认计划') &&
      runListText.includes('规划中'),
    `cards=${runCardCount}`,
  );
  await shot(page, '24b-agent-runs-list');

  // C24.3 过滤 chips：「待确认」桶仅确认门 run
  await page.locator('[data-filter="gate"]').click();
  await page.waitForTimeout(500);
  const gateCardCount = await page.locator('.runs__card').count();
  const gateListText = (await page.locator('.runs__list').textContent()) ?? '';
  check(
    'C24.3 过滤「待确认」桶 → 仅确认门 run',
    gateCardCount === 1 && gateListText.includes('咖啡店开业宣传片'),
    `cards=${gateCardCount}`,
  );
  await shot(page, '24c-agent-runs-filtered');
  await page.locator('[data-filter="all"]').click();
  await page.waitForTimeout(400);

  // C24.4-C24.7 成功剧本详情：SSE 接力（task_status ×7 + done）→ 徽章跃迁 + 动态流 + 产物
  await page.locator(`[data-run-id="${successRun.id}"]`).click();
  let c24Detail = true;
  try {
    await waitHash(page, 'pages/agent-runs/detail', 6000);
  } catch {
    c24Detail = false;
  }
  await page.waitForSelector('.detail__task', { timeout: 8000 });
  const taskCardCount = await page.locator('.detail__task').count();
  const goalText = (await page.locator('.detail__goal').textContent()) ?? '';
  check(
    'C24.4 列表点卡 → 详情页（goal + 3 任务卡）',
    c24Detail && taskCardCount === 3 && goalText.includes('雨夜侦探'),
    `nav=${c24Detail} tasks=${taskCardCount}`,
  );
  let c24Done = false;
  try {
    await page.waitForFunction(
      () => document.querySelector('[data-run-status]')?.getAttribute('data-run-status') === 'done',
      { timeout: 10000 },
    );
    c24Done = true;
  } catch {
    c24Done = false;
  }
  const feedCount = Number((await page.locator('.detail__feed').getAttribute('data-feed-count')) ?? 0);
  const taskVideoCount = await page.locator('.detail__task-video').count();
  const taskImageCount = await page.locator('.detail__task-image').count();
  check(
    'C24.5 SSE 接力 → run 徽章跃迁 done + 动态流上屏 + 图/视频产物渲染',
    c24Done && feedCount >= 7 && taskVideoCount === 1 && taskImageCount === 1,
    `done=${c24Done} feed=${feedCount} video=${taskVideoCount} image=${taskImageCount}`,
  );
  await shot(page, '24d-agent-run-done');
  const cancelAfterDone = await page.locator('[data-action="cancel-run"]').count();
  check('C24.6 终态后取消按钮隐藏', cancelAfterDone === 0, `cancel=${cancelAfterDone}`);

  // C24.7 确认门 run：徽章「待确认计划」+ 动态流回放含确认门事件
  await page.goto(`${H5}/#/pages/agent-runs/agent-runs`);
  await page.waitForSelector('.runs__card', { timeout: 8000 });
  await page.locator(`[data-run-id="${gateRun.id}"]`).click();
  let c24Gate = false;
  try {
    await page.waitForSelector('[data-run-status="awaiting_confirm"]', { timeout: 8000 });
    c24Gate = true;
  } catch {
    c24Gate = false;
  }
  // 回放帧 120ms 间隔逐条到达：等 feed 计数到 2（ack + confirm_required）再读文案
  await page.waitForSelector('.detail__feed', { timeout: 8000 });
  try {
    await page.waitForFunction(
      () => Number(document.querySelector('.detail__feed')?.getAttribute('data-feed-count') ?? 0) >= 2,
      { timeout: 8000 },
    );
  } catch {
    /* 超时按当前帧数判定 */
  }
  const gateFeedText = (await page.locator('.detail__feed').textContent()) ?? '';
  check(
    'C24.7 确认门 run：徽章「待确认计划」+ 动态流含确认门事件',
    c24Gate && gateFeedText.includes('确认门'),
    gateFeedText.trim().slice(0, 60),
  );
  await shot(page, '24e-agent-run-gate');

  // C24.8 取消：modal 二次确认 → 徽章「已取消」+ 按钮消失
  await page.locator('[data-action="cancel-run"]').click();
  await page.waitForSelector('.uni-modal__btn_primary', { timeout: 6000 });
  await shot(page, '24f-agent-run-cancel-modal');
  await page.locator('.uni-modal__btn_primary').click();
  let c24Canceled = false;
  try {
    await page.waitForSelector('[data-run-status="canceled"]', { timeout: 6000 });
    c24Canceled = true;
  } catch {
    c24Canceled = false;
  }
  const cancelAfterAbort = await page.locator('[data-action="cancel-run"]').count();
  check(
    'C24.8 取消（二次确认）→ 徽章「已取消」+ 按钮消失',
    c24Canceled && cancelAfterAbort === 0,
    `canceled=${c24Canceled} cancel=${cancelAfterAbort}`,
  );
  await shot(page, '24g-agent-run-canceled');

  // C24.9 列表回看：刚取消的 run 落入「已终止」桶
  await page.goto(`${H5}/#/pages/agent-runs/agent-runs`);
  await page.waitForSelector('.runs__card', { timeout: 8000 });
  await page.locator('[data-filter="terminated"]').click();
  await page.waitForTimeout(500);
  const termCardCount = await page.locator('.runs__card').count();
  const termListText = (await page.locator('.runs__list').textContent()) ?? '';
  check(
    'C24.9 列表「已终止」桶含刚取消的 run',
    termCardCount === 1 && termListText.includes('咖啡店开业宣传片'),
    `cards=${termCardCount}`,
  );
  await shot(page, '24h-agent-runs-terminated');

  // ---------- C25 Agent 团队二期交互（MP22）：确认门裁决 + 卡片干预 ----------
  // 种子：run-D 计划门（awaiting_confirm，3 pending 卡）/ run-E 合成门（awaiting_assembly，done×2 + assemble，duration 4+3=7s）
  const seed2Res = await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentRuns: [
        { goal: '悬疑短片三部曲', status: 'awaiting_confirm' },
        {
          goal: '发布会开场视频',
          status: 'awaiting_assembly',
          plan: [
            { id: 't1', kind: 'script', title: '旁白脚本', depends_on: [], status: 'done', attempt: 1, input: { prompt: '科技感开场旁白', duration_sec: 4 }, output: { text: '成稿' }, verdict: {}, gpu_hint: '' },
            { id: 't2', kind: 'video', title: '主镜头渲染', depends_on: ['t1'], status: 'done', attempt: 1, input: { prompt: '霓虹城市推轨', duration_sec: 3 }, output: { video_url: '/outputs/lib-4.mp4' }, verdict: {}, gpu_hint: '' },
            { id: 't3', kind: 'assemble', title: '合成成片', depends_on: ['t2'], status: 'pending', attempt: 0, input: {}, output: {}, verdict: {}, gpu_hint: '' },
          ],
        },
      ],
    }),
  }).then((r) => r.json());
  const [planGateRun, assemblyRun] = seed2Res.runs;

  // C25.1 计划门横幅（data-gate=plan）→ 去裁决 → 抽屉计划清单 3 项
  await page.goto(`${H5}/#/pages/agent-runs/agent-runs`);
  await page.waitForSelector('.runs__card', { timeout: 8000 });
  // C24.9 把过滤停在「已终止」桶，先重置回「全部」再点卡
  await page.locator('[data-filter="all"]').click();
  await page.waitForTimeout(400);
  await page.locator(`[data-run-id="${planGateRun.id}"]`).click();
  let c25GatePlan = false;
  try {
    await page.waitForSelector('.detail__gate[data-gate="plan"]', { timeout: 8000 });
    c25GatePlan = true;
  } catch {
    c25GatePlan = false;
  }
  await page.locator('[data-action="open-gate"]').click();
  let c25Sheet = true;
  try {
    await page.waitForSelector('[data-sheet="gate"]', { timeout: 6000 });
  } catch {
    c25Sheet = false;
  }
  const gateItemCount = await page.locator('.gate__item').count();
  check(
    'C25.1 计划门横幅 → 去裁决 → 抽屉计划清单 3 项',
    c25GatePlan && c25Sheet && gateItemCount === 3,
    `banner=${c25GatePlan} sheet=${c25Sheet} items=${gateItemCount}`,
  );
  await shot(page, '25a-gate-plan-sheet');

  // C25.2 计划门 approve → 徽章跃迁执行中 + 横幅/抽屉关闭
  // （MP23 起计划门确认按钮钩子更名 plan-confirm；无改动时行为不变：不调 /plan 直 resume approve）
  await page.locator('[data-action="plan-confirm"]').click();
  let c25Approved = false;
  try {
    await page.waitForSelector('[data-run-status="running"]', { timeout: 6000 });
    c25Approved = true;
  } catch {
    c25Approved = false;
  }
  const gateBannerLeft = await page.locator('.detail__gate').count();
  const gateSheetLeft = await page.locator('[data-sheet="gate"]').count();
  check(
    'C25.2 计划门 approve → 徽章执行中 + 横幅/抽屉关闭',
    c25Approved && gateBannerLeft === 0 && gateSheetLeft === 0,
    `running=${c25Approved} banner=${gateBannerLeft} sheet=${gateSheetLeft}`,
  );
  await shot(page, '25b-gate-plan-approved');

  // C25.3 合成门抽屉：时间线时长列 ×3 + 合计 ≈ 7s
  await page.goto(`${H5}/#/pages/agent-runs/agent-runs`);
  await page.waitForSelector('.runs__card', { timeout: 8000 });
  await page.locator('[data-filter="all"]').click();
  await page.waitForTimeout(400);
  await page.locator(`[data-run-id="${assemblyRun.id}"]`).click();
  let c25GateAsm = false;
  try {
    await page.waitForSelector('.detail__gate[data-gate="assembly"]', { timeout: 8000 });
    c25GateAsm = true;
  } catch {
    c25GateAsm = false;
  }
  await page.locator('[data-action="open-gate"]').click();
  await page.waitForSelector('[data-sheet="gate"]', { timeout: 6000 });
  const durCount = await page.locator('.gate__dur').count();
  const totalText = (await page.locator('.gate__total').textContent()) ?? '';
  check(
    'C25.3 合成门抽屉：时间线时长列 + 合计 ≈ 7s',
    c25GateAsm && durCount === 3 && totalText.includes('7s'),
    `banner=${c25GateAsm} durs=${durCount} total=${totalText.trim()}`,
  );
  await shot(page, '25c-gate-assembly-sheet');

  // C25.4 合成门 reject（带批注）→ 回执行中 + 横幅消失
  await page.locator('[data-action="gate-reject-toggle"]').click();
  await page.waitForSelector('[data-field="gate-feedback"]', { timeout: 4000 });
  await page.locator('[data-field="gate-feedback"] textarea').fill('第 2 镜节奏太慢');
  await shot(page, '25d-gate-assembly-reject');
  await page.locator('[data-action="gate-reject-confirm"]').click();
  let c25Rejected = false;
  try {
    await page.waitForSelector('[data-run-status="running"]', { timeout: 6000 });
    c25Rejected = true;
  } catch {
    c25Rejected = false;
  }
  const asmBannerLeft = await page.locator('.detail__gate').count();
  check(
    'C25.4 合成门 reject（带批注）→ 回执行中 + 横幅消失',
    c25Rejected && asmBannerLeft === 0,
    `running=${c25Rejected} banner=${asmBannerLeft}`,
  );

  // C25.8 卡片反推提示词（MP33）：done 视频卡点反推 → prompt 写回 input → 自动开改文案抽屉预填
  await page.locator('[data-action="task-reprompt:t2"]').click();
  let c25RepromptPrefill = '';
  let c25RepromptDone = false;
  try {
    await page.waitForSelector('[data-sheet="task-edit"]', { timeout: 6000 });
    c25RepromptPrefill = await page.locator('[data-field="edit-draft"] textarea').inputValue();
    c25RepromptDone = await page.evaluate(() => {
      const card = document.querySelector('[data-task-id="t2"]');
      // 任务卡 done 徽章文案为「完成」（taskStatusMeta），非 run 级「已完成」
      return !!card && !!card.textContent && card.textContent.includes('完成');
    });
  } catch {
    c25RepromptPrefill = '';
  }
  check(
    'C25.8 卡片反推提示词：写回 input → 改文案抽屉预填反推 prompt（卡片保持完成）',
    c25RepromptPrefill.startsWith('反推:霓虹城市推轨') && c25RepromptDone,
    `prefill=${c25RepromptPrefill} done=${c25RepromptDone}`,
  );
  await shot(page, '25f-task-reprompted');
  await page.locator('[data-action="edit-cancel"]').click(); // 不保存：保持 t2 done 供后续用例

  // C25.9 卡片替换上传（MP33）：选视频直传 multipart → 产物替换 source=upload + 卡片保持已完成
  const fcPromise = page.waitForEvent('filechooser', { timeout: 6000 });
  await page.locator('[data-action="task-upload:t2"]').click();
  const fc = await fcPromise;
  await fc.setFiles({
    name: 'walkthrough-replace.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('0000walkthrough-replace'),
  });
  let c25Upload = false;
  try {
    await page.waitForFunction(
      () => {
        const card = document.querySelector('[data-task-id="t2"]');
        if (!card) return false;
        // uni-h5 <video> 编译为 uni-video 内嵌原生 video；src 读 attribute
        // （currentSrc 在源 404 时残留旧值/空串，不可靠——mock 无文件服务路由）
        const media = card.querySelector('video');
        const src = media ? (media.getAttribute('src') || media.src || '') : '';
        return src.includes('/api/studio/files/mock-upload');
      },
      { timeout: 6000 },
    );
    c25Upload = true;
  } catch {
    c25Upload = false;
  }
  check('C25.9 卡片替换上传：multipart 直传 → 产物替换（source=upload）+ 预览更新', c25Upload);
  await shot(page, '25g-task-uploaded');

  // C25.5 卡片改文案：预填主文案 → 保存 → 卡回排队中 + 抽屉关闭（局部替换不重拉）
  await page.locator('[data-action="task-edit:t1"]').click();
  await page.waitForSelector('[data-sheet="task-edit"]', { timeout: 6000 });
  const editPrefill = await page.locator('[data-field="edit-draft"] textarea').inputValue();
  await page.locator('[data-field="edit-draft"] textarea').fill('雨夜，女主回头，霓虹映在湿柏油路上');
  await page.locator('[data-action="edit-save"]').click();
  let c25Edit = false;
  try {
    await page.waitForFunction(
      () => {
        const card = document.querySelector('[data-task-id="t1"]');
        return !!card && !!card.textContent && card.textContent.includes('排队中');
      },
      { timeout: 6000 },
    );
    c25Edit = true;
  } catch {
    c25Edit = false;
  }
  const editSheetLeft = await page.locator('[data-sheet="task-edit"]').count();
  check(
    'C25.5 卡片改文案：预填主文案 → 保存 → 卡回排队中 + 抽屉关闭',
    editPrefill === '科技感开场旁白' && c25Edit && editSheetLeft === 0,
    `prefill=${editPrefill} pending=${c25Edit} sheet=${editSheetLeft}`,
  );
  await shot(page, '25e-task-edited');

  // C25.6 卡片重生成：引导词透传 → 卡回排队中 + 第 2 次尝试
  await page.locator('[data-action="task-regen:t2"]').click();
  await page.waitForSelector('[data-sheet="task-regen"]', { timeout: 6000 });
  await page.locator('[data-field="regen-guidance"] textarea').fill('雨更大一些');
  await page.locator('[data-action="regen-submit"]').click();
  let c25Regen = false;
  try {
    await page.waitForFunction(
      () => {
        const card = document.querySelector('[data-task-id="t2"]');
        return (
          !!card &&
          !!card.textContent &&
          card.textContent.includes('排队中') &&
          card.textContent.includes('第 2 次尝试')
        );
      },
      { timeout: 6000 },
    );
    c25Regen = true;
  } catch {
    c25Regen = false;
  }
  check('C25.6 卡片重生成：引导词透传 → 卡回排队中 + 第 2 次尝试', c25Regen);

  // C25.7 卡片通过：直接提交 → 状态徽章「已通过」
  await page.locator('[data-action="task-approve:t1"]').click();
  let c25Approve = false;
  try {
    await page.waitForFunction(
      () => {
        const card = document.querySelector('[data-task-id="t1"]');
        return !!card && !!card.textContent && card.textContent.includes('已通过');
      },
      { timeout: 6000 },
    );
    c25Approve = true;
  } catch {
    c25Approve = false;
  }
  check('C25.7 卡片通过 → 状态徽章「已通过」', c25Approve);
  await shot(page, '25f-task-approved');

  // ---------- C26 Agent 团队三期（MP23）：计划门可编辑（POST /plan）+ done 成片卡（GET /result） ----------
  // 契约背景（后端 agent_team.py 源码确认）：edit_plan 仅 awaiting_confirm 可改（409）；
  // resume plan 门 modify「仅记录裁决，run 保持挂起态」→ 编辑确认是两段式：
  // 改动确认 = POST /plan + resume(modify)（计划落库上屏，徽章仍待确认），再次确认（无改动）= resume(approve) 图启动徽章执行中
  const seed3Res = await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentRuns: [
        { goal: 'MP23 计划编辑：改标题文案', status: 'awaiting_confirm' },
        { goal: 'MP23 计划编辑：删加任务', status: 'awaiting_confirm' },
        { goal: 'MP23 计划门：无改动直批', status: 'awaiting_confirm' },
        {
          goal: 'MP23 成片结果卡',
          status: 'done',
          plan: [
            { id: 'v1', kind: 'video', title: '主镜头渲染', depends_on: [], status: 'done', attempt: 1, input: { prompt: '霓虹城市推轨', duration_sec: 7 }, output: { video_url: '/outputs/lib-4.mp4' }, verdict: {}, gpu_hint: '' },
            { id: 'a1', kind: 'assemble', title: '合成成片', depends_on: ['v1'], status: 'done', attempt: 1, input: {}, output: { url: '/outputs/lib-4.mp4' }, verdict: {}, gpu_hint: '' },
          ],
        },
      ],
    }),
  }).then((r) => r.json());
  const [editRun, removeAddRun, approveRun, doneRun] = seed3Res.runs;

  // C26.1 计划门编辑：改 t1 标题 + 改 t2 文案 → 确认执行 → 拦截 POST /plan（update×2）+ resume(modify)
  // → 计划落库上屏（徽章仍待确认）；再确认（无改动）→ resume(approve) → 徽章执行中
  await page.goto(`${H5}/#/pages/agent-runs/agent-runs`);
  await page.waitForSelector('.runs__card', { timeout: 8000 });
  await page.locator('[data-filter="all"]').click();
  await page.waitForTimeout(400);
  await page.locator(`[data-run-id="${editRun.id}"]`).click();
  await page.waitForSelector('.detail__gate[data-gate="plan"]', { timeout: 8000 });
  await page.locator('[data-action="open-gate"]').click();
  await page.waitForSelector('[data-sheet="gate"]', { timeout: 6000 });
  await page.locator('[data-field="plan-title:t1"] input').fill('改写标题');
  await page.locator('[data-field="plan-input:t2"] textarea').fill('改写后的分镜文案');
  const dirtyAfterEdit = await page
    .locator('[data-action="plan-confirm"]')
    .getAttribute('data-plan-dirty');
  const planReqP = page.waitForRequest(
    (r) => r.url().includes(`/api/agent-runs/${editRun.id}/plan`) && r.method() === 'POST',
    { timeout: 6000 },
  );
  const resumeReqP = page.waitForRequest(
    (r) => r.url().includes(`/api/agent-runs/${editRun.id}/resume`) && r.method() === 'POST',
    { timeout: 6000 },
  );
  await page.locator('[data-action="plan-confirm"]').click();
  let c26PlanOps = [];
  let c26ResumeAction = '';
  try {
    const planReq = await planReqP;
    c26PlanOps = planReq.postDataJSON()?.tasks ?? [];
    c26ResumeAction = (await resumeReqP).postDataJSON()?.action ?? '';
  } catch {
    /* 拦截超时 → 断言失败 */
  }
  // modify 后徽章仍「待确认计划」（后端 modify 不变态），计划已落库（t1 标题上屏）
  let c26Merged = false;
  try {
    await page.waitForFunction(
      () => {
        const card = document.querySelector('[data-task-id="t1"]');
        return !!card && !!card.textContent && card.textContent.includes('改写标题');
      },
      { timeout: 6000 },
    );
    c26Merged = true;
  } catch {
    c26Merged = false;
  }
  const c26Updates = c26PlanOps.filter((o) => o.action === 'update');
  const c26T1 = c26Updates.find((o) => o.id === 't1');
  const c26T2 = c26Updates.find((o) => o.id === 't2');
  check(
    'C26.1 计划门编辑：改标题+改文案 → 确认执行 → POST /plan（update×2）+ resume(modify) → 计划落库上屏',
    dirtyAfterEdit === '1' &&
      c26Updates.length === 2 &&
      c26T1?.title === '改写标题' &&
      c26T2?.input?.prompt === '改写后的分镜文案' &&
      c26ResumeAction === 'modify' &&
      c26Merged,
    `dirty=${dirtyAfterEdit} updates=${c26Updates.length} t1=${c26T1?.title} t2in=${c26T2?.input?.prompt} resume=${c26ResumeAction} merged=${c26Merged}`,
  );
  await shot(page, '26a-plan-edited-modify');
  // 两段式第二段：重开抽屉无改动 → plan-confirm → resume(approve) → 徽章执行中
  await page.locator('[data-action="open-gate"]').click();
  await page.waitForSelector('[data-sheet="gate"]', { timeout: 6000 });
  const approveReqP = page.waitForRequest(
    (r) => r.url().includes(`/api/agent-runs/${editRun.id}/resume`) && r.method() === 'POST',
    { timeout: 6000 },
  );
  await page.locator('[data-action="plan-confirm"]').click();
  let c26SecondAction = '';
  try {
    c26SecondAction = (await approveReqP).postDataJSON()?.action ?? '';
  } catch {
    /* 超时 → 断言失败 */
  }
  let c26Running = false;
  try {
    await page.waitForSelector('[data-run-status="running"]', { timeout: 6000 });
    c26Running = true;
  } catch {
    c26Running = false;
  }
  check(
    'C26.1b 计划门二次确认（无改动）→ resume(approve) → 徽章执行中',
    c26SecondAction === 'approve' && c26Running,
    `action=${c26SecondAction} running=${c26Running}`,
  );
  await shot(page, '26b-plan-approved-running');

  // C26.2 删 t3 + 加任务 → 确认 → /plan ops 含 remove+add → resume(modify)
  await page.goto(`${H5}/#/pages/agent-runs/agent-runs`);
  await page.waitForSelector('.runs__card', { timeout: 8000 });
  await page.locator('[data-filter="all"]').click();
  await page.waitForTimeout(400);
  await page.locator(`[data-run-id="${removeAddRun.id}"]`).click();
  await page.waitForSelector('.detail__gate[data-gate="plan"]', { timeout: 8000 });
  await page.locator('[data-action="open-gate"]').click();
  await page.waitForSelector('[data-sheet="gate"]', { timeout: 6000 });
  await page.locator('[data-action="plan-remove:t3"]').click();
  await page.locator('[data-action="plan-add"]').click();
  await page.waitForSelector('[data-field="plan-title:new-1"]', { timeout: 4000 });
  await page.locator('[data-field="plan-title:new-1"] input').fill('追加镜头');
  await page.locator('[data-field="plan-input:new-1"] textarea').fill('雨夜天台对峙');
  const planReq2P = page.waitForRequest(
    (r) => r.url().includes(`/api/agent-runs/${removeAddRun.id}/plan`) && r.method() === 'POST',
    { timeout: 6000 },
  );
  const resumeReq2P = page.waitForRequest(
    (r) => r.url().includes(`/api/agent-runs/${removeAddRun.id}/resume`) && r.method() === 'POST',
    { timeout: 6000 },
  );
  await page.locator('[data-action="plan-confirm"]').click();
  let c26Ops2 = [];
  let c26Resume2 = '';
  try {
    c26Ops2 = (await planReq2P).postDataJSON()?.tasks ?? [];
    c26Resume2 = (await resumeReq2P).postDataJSON()?.action ?? '';
  } catch {
    /* 超时 → 断言失败 */
  }
  const c26Remove = c26Ops2.find((o) => o.action === 'remove');
  const c26Add = c26Ops2.find((o) => o.action === 'add');
  check(
    'C26.2 删任务+加任务 → 确认 → /plan ops 含 remove+add → resume(modify)',
    c26Remove?.id === 't3' &&
      c26Add?.id === 'new-1' &&
      c26Add?.title === '追加镜头' &&
      c26Add?.input?.prompt === '雨夜天台对峙' &&
      c26Resume2 === 'modify',
    `remove=${c26Remove?.id} add=${c26Add?.id}/${c26Add?.title} resume=${c26Resume2}`,
  );
  await shot(page, '26c-plan-remove-add');

  // C26.3 无改动确认 → 不调 /plan，直接 resume(approve) → 徽章执行中
  await page.goto(`${H5}/#/pages/agent-runs/agent-runs`);
  await page.waitForSelector('.runs__card', { timeout: 8000 });
  await page.locator('[data-filter="all"]').click();
  await page.waitForTimeout(400);
  await page.locator(`[data-run-id="${approveRun.id}"]`).click();
  await page.waitForSelector('.detail__gate[data-gate="plan"]', { timeout: 8000 });
  await page.locator('[data-action="open-gate"]').click();
  await page.waitForSelector('[data-sheet="gate"]', { timeout: 6000 });
  const dirtyNoEdit = await page
    .locator('[data-action="plan-confirm"]')
    .getAttribute('data-plan-dirty');
  let c26PlanCalled = false;
  const onPlanReq = (r) => {
    if (r.url().includes(`/api/agent-runs/${approveRun.id}/plan`) && r.method() === 'POST') {
      c26PlanCalled = true;
    }
  };
  page.on('request', onPlanReq);
  const resumeReq3P = page.waitForRequest(
    (r) => r.url().includes(`/api/agent-runs/${approveRun.id}/resume`) && r.method() === 'POST',
    { timeout: 6000 },
  );
  await page.locator('[data-action="plan-confirm"]').click();
  let c26Resume3 = '';
  try {
    c26Resume3 = (await resumeReq3P).postDataJSON()?.action ?? '';
  } catch {
    /* 超时 → 断言失败 */
  }
  let c26Running3 = false;
  try {
    await page.waitForSelector('[data-run-status="running"]', { timeout: 6000 });
    c26Running3 = true;
  } catch {
    c26Running3 = false;
  }
  page.off('request', onPlanReq);
  check(
    'C26.3 无改动确认 → 不调 /plan 直 resume(approve) → 徽章执行中',
    dirtyNoEdit === '0' && !c26PlanCalled && c26Resume3 === 'approve' && c26Running3,
    `dirty=${dirtyNoEdit} planCalled=${c26PlanCalled} action=${c26Resume3} running=${c26Running3}`,
  );

  // C26.4 done run → 详情页成片卡：video[data-result=final] + 合计时长 ≈7s + 产物计数
  await page.goto(`${H5}/#/pages/agent-runs/agent-runs`);
  await page.waitForSelector('.runs__card', { timeout: 8000 });
  await page.locator('[data-filter="all"]').click();
  await page.waitForTimeout(400);
  await page.locator(`[data-run-id="${doneRun.id}"]`).click();
  let c26Final = false;
  try {
    await page.waitForSelector('video[data-result="final"]', { timeout: 8000 });
    c26Final = true;
  } catch {
    c26Final = false;
  }
  const c26ResultText = (await page.locator('.detail__result-text').textContent()) ?? '';
  check(
    'C26.4 done run 成片卡渲染（video[data-result=final] + 合计时长 ≈7s + 产物 2 项）',
    c26Final && c26ResultText.includes('7s') && c26ResultText.includes('2 项'),
    `video=${c26Final} text=${c26ResultText.trim()}`,
  );
  await shot(page, '26d-run-result');

  // ---------- C27 对话助手三期（MP24）：媒体预览 / 分叉会话（截断+全量）/ 输入草稿持久化 ----------
  // 种子：6 消息会话（user/assistant/tool 交替，对齐后端回放形状；tool 行 id=3 图 / id=6 视频，
  // 回放时 tool 媒体并入前一条 assistant 气泡、backendId 取 tool 行 id）
  const seed4Res = await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentSessions: [
        {
          title: '雨夜短片',
          messages: [
            { role: 'user', content: '生成雨夜街景图' },
            { role: 'assistant', content: '好的，按胶片风生成。' },
            { role: 'tool', media: [{ type: 'image', urls: ['/outputs/mock-agent-1.png'] }] },
            { role: 'user', content: '再来段视频' },
            { role: 'assistant', content: '视频也完成了。' },
            { role: 'tool', media: [{ type: 'video', urls: ['/outputs/lib-4.mp4'] }] },
          ],
        },
      ],
    }),
  }).then((r) => r.json());
  const seed4Sid = seed4Res.sessions?.[0]?.id ?? '';
  console.log(`[seed] C27 会话 ${seed4Sid}`);

  // 前置：助手页 → 历史抽屉 → 打开种子会话（6 条 → 4 气泡：user/assistant+图/user/assistant+视频卡）
  await page.goto(`${H5}/#/pages/assistant/assistant`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.assistant__nav-btn', { timeout: 8000 });
  await page.locator('.assistant__nav-btn').nth(1).click();
  await page.waitForSelector('.assistant__session:has-text("6 条")', { timeout: 6000 });
  await page.locator('.assistant__session:has-text("6 条")').first().click();
  await page.waitForSelector('.assistant__media-video-card', { timeout: 8000 });

  // C27.1 图片点击 → uni.previewImage 预览层（uni-swiper，z-999 固定层）→ 点击关闭
  await page.locator('.assistant__media-image').first().click();
  let previewOpen = false;
  try {
    await page.waitForSelector('uni-swiper', { timeout: 5000 });
    previewOpen = true;
  } catch {
    previewOpen = false;
  }
  await shot(page, '27a-image-preview');
  await page.mouse.click(195, 100); // 预览层根节点 onClick 关闭（mousedown/up 同点位）
  let previewClosed = false;
  try {
    await page.waitForFunction(() => !document.querySelector('uni-swiper'), { timeout: 5000 });
    previewClosed = true;
  } catch {
    previewClosed = false;
  }
  check(
    'C27.1 图片点击 → previewImage 预览层开关',
    previewOpen && previewClosed,
    `open=${previewOpen} closed=${previewClosed}`,
  );

  // C27.2 视频封面卡点击 → 全屏覆盖层（内嵌 video src 命中产物）→ X 关闭
  await page.locator('.assistant__media-video-card').first().click();
  let videoOpen = false;
  let videoSrcOk = false;
  try {
    await page.waitForSelector('.assistant__video-preview video', { timeout: 5000 });
    videoOpen = true;
    const vsrc = (await page.locator('.assistant__video-preview video').first().getAttribute('src')) ?? '';
    videoSrcOk = vsrc.includes('lib-4.mp4');
  } catch {
    videoOpen = false;
  }
  await shot(page, '27b-video-preview');
  await page.locator('.assistant__video-preview-close').click();
  let videoClosed = false;
  try {
    await page.waitForFunction(() => !document.querySelector('.assistant__video-preview'), {
      timeout: 5000,
    });
    videoClosed = true;
  } catch {
    videoClosed = false;
  }
  check(
    'C27.2 视频封面卡 → 全屏覆盖层播放（src 命中）→ X 关闭',
    videoOpen && videoSrcOk && videoClosed,
    `open=${videoOpen} src=${videoSrcOk} closed=${videoClosed}`,
  );

  // C27.3a 长按第 2 气泡（assistant 含图，backendId=3）→ action sheet「从此分叉」→ 截断叉 2 气泡无视频卡
  // uni-h5 longpress：window touchstart 监听 → 350ms 定时 → 向 target 派发 longpress CustomEvent
  const forkBubble = page.locator('.assistant__bubble').nth(1);
  await forkBubble.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + 12;
    const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
    el.dispatchEvent(
      new TouchEvent('touchstart', { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }),
    );
  });
  await page.waitForTimeout(500); // > LONGPRESS_TIMEOUT 350ms，等定时器派发
  await forkBubble.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + 12;
    const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
    el.dispatchEvent(
      new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }),
    );
  });
  let forkSheet = false;
  try {
    await page.waitForSelector('.uni-actionsheet__cell:has-text("从此分叉")', { timeout: 4000 });
    forkSheet = true;
  } catch {
    forkSheet = false;
  }
  if (forkSheet) {
    await page.locator('.uni-actionsheet__cell:has-text("从此分叉")').first().click();
  }
  let forkTrunc = false;
  try {
    await page.waitForFunction(() => document.querySelectorAll('.assistant__bubble').length === 2, {
      timeout: 8000,
    });
    forkTrunc =
      (await page.locator('.assistant__media-video-card').count()) === 0 &&
      (await page.locator('.assistant__media-image').count()) === 1;
  } catch {
    forkTrunc = false;
  }

  // C27.3b 抽屉 copy 钮全量分叉 6 条源会话 → 跳新会话回 4 气泡（视频卡复现）
  await page.locator('.assistant__nav-btn').nth(1).click();
  await page.waitForSelector('.assistant__session-fork', { timeout: 6000 });
  await shot(page, '27c-sessions-fork-btn');
  await page
    .locator('.assistant__session:has-text("6 条") .assistant__session-fork')
    .first()
    .click();
  let forkFull = false;
  try {
    await page.waitForFunction(() => document.querySelectorAll('.assistant__bubble').length === 4, {
      timeout: 8000,
    });
    forkFull = (await page.locator('.assistant__media-video-card').count()) === 1;
  } catch {
    forkFull = false;
  }
  check(
    'C27.3 气泡长按截断分叉（2 气泡）+ 列表 copy 全量分叉（4 气泡）',
    forkSheet && forkTrunc && forkFull,
    `sheet=${forkSheet} trunc=${forkTrunc} full=${forkFull}`,
  );

  // C27.4 草稿持久化：当前会话（全量叉）输入 → 切 3 条会话（空）→ 切回 6 条（回填）
  await page.locator('.assistant__textarea textarea').fill('草稿：霓虹调色');
  await page.waitForTimeout(450); // > 防抖 300ms 落盘窗口
  await page.locator('.assistant__nav-btn').nth(1).click();
  await page.waitForSelector('.assistant__session:has-text("3 条")', { timeout: 6000 });
  await page.locator('.assistant__session:has-text("3 条")').first().click();
  // 等 openSession 落地（气泡数收敛到 2）再读输入框：restoreDraft 在 await 链末尾，立即读会拿到旧草稿
  let draftAway = '';
  try {
    await page.waitForFunction(() => document.querySelectorAll('.assistant__bubble').length === 2, {
      timeout: 8000,
    });
    await page.waitForFunction(
      () => (document.querySelector('.assistant__textarea textarea')?.value ?? ' ') === '',
      { timeout: 6000 },
    );
    draftAway = '';
  } catch {
    draftAway = await page.locator('.assistant__textarea textarea').inputValue();
  }
  await page.locator('.assistant__nav-btn').nth(1).click();
  await page.waitForSelector('.assistant__session:has-text("6 条")', { timeout: 6000 });
  await page.locator('.assistant__session:has-text("6 条")').first().click();
  let draftBack = '';
  try {
    await page.waitForFunction(
      () =>
        (document.querySelector('.assistant__textarea textarea')?.value ?? '') === '草稿：霓虹调色',
      { timeout: 6000 },
    );
    draftBack = '草稿：霓虹调色';
  } catch {
    draftBack = await page.locator('.assistant__textarea textarea').inputValue();
  }
  check(
    'C27.4 草稿按会话持久化：输入 → 切会话清空 → 切回回填',
    draftAway === '' && draftBack === '草稿：霓虹调色',
    `away="${draftAway}" back="${draftBack}"`,
  );
  await shot(page, '27d-draft-restored');

  // ---------- C28 作品库批量管理（MP25）：多选模式 + 批量删除（部分失败保留勾选）+ 批量保存相册 ----------
  // mock 支撑：/__seed jobs 置顶种子（unshift，首屏可见）；id 含 'fail' DELETE 注入 500；
  // DELETE 真删内存（列表减项可断言）；/__reset 恢复默认 52 件（每次运行起始已调用）
  await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobs: [
        { id: 'c28-del-1', kind: 'txt2img' },
        { id: 'c28-del-2', kind: 'txt2img' },
        { id: 'c28-fail-1', kind: 'txt2img' },
        { id: 'c28-ok-1', kind: 'txt2img' },
        { id: 'c28-save-img', kind: 'txt2img' },
        { id: 'c28-save-vid', kind: 'wan_t2v' },
        { id: 'c28-save-audio', kind: 'ace_audio' },
        { id: 'c28-save-3d', kind: 'hunyuan3d' },
      ],
    }),
  });
  await page.goto(`${H5}/#/pages/library/library`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelectorAll('.library__card').length === 24,
    { timeout: 8000 },
  );

  // C28.1 「选择」钮进入多选 → 点 2 卡（计数「已选 2 项」+ 2 枚选中圈）→ 全选当前已加载 24 → 取消退出
  await page.locator('[data-action="enter-select"]').click();
  await page.waitForSelector('.library__batch-bar', { timeout: 4000 });
  await page.locator('[data-job-id="c28-del-1"]').click();
  await page.locator('[data-job-id="c28-del-2"]').click();
  const c281Count = ((await page.locator('.library__batch-count').textContent()) ?? '').trim();
  const c281Sel = await page.locator('.library__card-selector[data-selected="1"]').count();
  await page.locator('[data-action="select-all"]').click();
  const c281All = ((await page.locator('.library__batch-count').textContent()) ?? '').trim();
  await shot(page, '28a-select-mode-all');
  await page.locator('[data-action="exit-select"]').click();
  await page.waitForTimeout(300);
  const c281BarGone = (await page.locator('.library__batch-bar').count()) === 0;
  check(
    'C28.1 选择钮进入多选：选 2 项计数/选中圈 → 全选已加载 24 → 取消退出',
    c281Count === '已选 2 项' && c281Sel === 2 && c281All === '已选 24 项' && c281BarGone,
    `count="${c281Count}" sel=${c281Sel} all="${c281All}" barGone=${c281BarGone}`,
  );

  // C28.2 批量删除全成功：二次确认弹窗 → 列表减 2 项 + toast「已删除 2 项」+ 退出选择模式
  await page.locator('[data-action="enter-select"]').click();
  await page.waitForSelector('.library__batch-bar', { timeout: 4000 });
  await page.locator('[data-job-id="c28-del-1"]').click();
  await page.locator('[data-job-id="c28-del-2"]').click();
  await page.locator('[data-action="batch-delete"]').click();
  await page.waitForSelector('.uni-modal__btn_primary', { timeout: 4000 });
  await shot(page, '28b-batch-delete-modal');
  await page.locator('.uni-modal__btn_primary').click();
  const c282Toast = await waitToastText(page, '已删除');
  await page.waitForTimeout(800); // toast 后 refresh 重拉第一页
  const c282Gone =
    (await page.locator('[data-job-id="c28-del-1"]').count()) === 0 &&
    (await page.locator('[data-job-id="c28-del-2"]').count()) === 0;
  const c282BarGone = (await page.locator('.library__batch-bar').count()) === 0;
  check(
    'C28.2 批量删除全成功：确认弹窗 → 列表减项 + 汇总 toast + 退出选择',
    c282Toast.includes('已删除 2 项') && c282Gone && c282BarGone,
    `toast="${c282Toast}" gone=${c282Gone} barGone=${c282BarGone}`,
  );

  // C28.3 批量删除部分失败（fail magic id 注入 500）：成功项移除、失败项保留勾选 + 汇总文案
  await page.locator('[data-action="enter-select"]').click();
  await page.waitForSelector('.library__batch-bar', { timeout: 4000 });
  await page.locator('[data-job-id="c28-fail-1"]').click();
  await page.locator('[data-job-id="c28-ok-1"]').click();
  await page.locator('[data-action="batch-delete"]').click();
  await page.waitForSelector('.uni-modal__btn_primary', { timeout: 4000 });
  await page.locator('.uni-modal__btn_primary').click();
  const c283Toast = await waitToastText(page, '成功 1 失败 1');
  await page.waitForTimeout(800);
  const c283OkGone = (await page.locator('[data-job-id="c28-ok-1"]').count()) === 0;
  const c283FailCard = page.locator('[data-job-id="c28-fail-1"]');
  const c283FailKept =
    (await c283FailCard.count()) === 1 &&
    (await c283FailCard.locator('.library__card-selector').getAttribute('data-selected')) === '1';
  const c283Count =
    (await page.locator('.library__batch-bar').count()) === 1
      ? ((await page.locator('.library__batch-count').textContent()) ?? '').trim()
      : '';
  check(
    'C28.3 批量删除部分失败：失败项保留勾选（已选 1 项）+ 成功项移除 + 汇总文案',
    c283Toast.includes('成功 1 失败 1') && c283OkGone && c283FailKept && c283Count === '已选 1 项',
    `toast="${c283Toast}" okGone=${c283OkGone} failKept=${c283FailKept} count="${c283Count}"`,
  );
  await shot(page, '28c-partial-fail-retained');
  await page.locator('[data-action="exit-select"]').click();
  await page.waitForTimeout(300);

  // C28.4 批量保存相册（H5 降级路径）：uni-h5 的 save*ToPhotosAlbum 为 unsupported 实现（fail 回调），
  // 且 vite 自动导入把 uni.xxx 改写为模块绑定——window.uni 打桩无效（已实证 stats 全 0）。
  // 断言点 = 调用次数（网络层计数 downloadFile XHR：仅 image/video 2 次，audio/3D 跳过）+ 全败降级汇总人话 + 退出选择；
  // 成功路径汇总文案由 tests/library-batch.test.ts 纯函数用例覆盖（6 条）
  const c284Downloads = [];
  const c284OnReq = (req) => {
    try {
      const p = new URL(req.url()).pathname;
      if (p.startsWith('/outputs/') && (req.resourceType() === 'xhr' || req.resourceType() === 'fetch')) {
        c284Downloads.push(p);
      }
    } catch {
      /* 忽略非常规 URL */
    }
  };
  page.on('request', c284OnReq);
  await page.locator('[data-action="enter-select"]').click();
  await page.waitForSelector('.library__batch-bar', { timeout: 4000 });
  await page.locator('[data-job-id="c28-save-img"]').click();
  await page.locator('[data-job-id="c28-save-vid"]').click();
  await page.locator('[data-job-id="c28-save-audio"]').click();
  await page.locator('[data-job-id="c28-save-3d"]').click();
  await page.locator('[data-action="batch-save"]').click();
  const c284Toast = await waitToastText(page, '保存失败');
  await page.waitForTimeout(500); // 收尾在途请求登记
  page.off('request', c284OnReq);
  const c284BarGone = (await page.locator('.library__batch-bar').count()) === 0;
  check(
    'C28.4 批量保存：仅 image/video 触发下载（audio/3D 跳过）+ H5 降级汇总文案 + 退出选择',
    c284Downloads.length === 2 &&
      c284Downloads.some((p) => p.endsWith('.png')) &&
      c284Downloads.some((p) => p.endsWith('.mp4')) &&
      c284Toast.includes('保存失败') &&
      c284BarGone,
    `downloads=${JSON.stringify(c284Downloads)} toast="${c284Toast}" barGone=${c284BarGone}`,
  );
  await shot(page, '28d-batch-save');

  // C28.5 选择集跨分页保持：零导航态重进（uni-h5 页栈滚动监听缺陷规避，同 C19）→
  // 第 1 页选 1 → 触底加载第 2 页再选 → 计数累计「已选 2 项」；切过滤桶 → 退出选择模式清空
  await page.goto(`${H5}/#/pages/library/library`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelectorAll('.library__card').length === 24,
    { timeout: 8000 },
  );
  await page.locator('[data-action="enter-select"]').click();
  await page.waitForSelector('.library__batch-bar', { timeout: 4000 });
  const c285First = (await libCardIds())[0] ?? '';
  await page.locator(`[data-job-id="${c285First}"]`).click();
  await scrollLibToBottom();
  await page.waitForFunction(
    () => document.querySelectorAll('.library__card').length === 48,
    { timeout: 8000 },
  );
  const c285Page2 = (await libCardIds())[24] ?? '';
  // 第 2 页卡可能落入固定操作条遮挡区：dispatchEvent 直派（同 clickEngine 规避模式）
  await page.locator(`[data-job-id="${c285Page2}"]`).dispatchEvent('click');
  const c285Count = ((await page.locator('.library__batch-count').textContent()) ?? '').trim();
  await shot(page, '28e-cross-page-select');
  await page.locator('.library__chip:has-text("音频")').first().click();
  await page.waitForTimeout(800);
  const c285BarGone = (await page.locator('.library__batch-bar').count()) === 0;
  const c285SelGone = (await page.locator('.library__card-selector[data-selected="1"]').count()) === 0;
  check(
    'C28.5 选择集跨分页保持：两页各选 1 → 已选 2 项；切过滤桶退出选择并清空',
    c285First !== '' && c285Page2 !== '' && c285Count === '已选 2 项' && c285BarGone && c285SelGone,
    `first=${c285First} page2=${c285Page2} count="${c285Count}" barGone=${c285BarGone} selGone=${c285SelGone}`,
  );

  // ---------- C29 设置页完善（MP26）：关于 + 清理缓存 + 导出诊断 ----------
  // 存储断言走 localStorage（uni-h5 storage 1:1 映射，getStorageInfoSync 枚举同源键）；
  // 剪贴板断言双通道：navigator.clipboard（context 已授权）→ uni-h5 兜底 #clipboard textarea 残值
  await page.goto(`${H5}/#/pages/profile/profile`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-action="about-toggle"]', { timeout: 8000 });

  // C29.1 关于区：检查更新行版本号 → 关于行展开（定位/版权）→ H5 检查更新降级提示
  const c291UpdateSub = (
    (await page.locator('[data-action="check-update"] .profile__row-sub').textContent()) ?? ''
  ).trim();
  const c291Ver = /v(\d+\.\d+\.\d+)/.exec(c291UpdateSub)?.[1] ?? '';
  await page.locator('[data-action="about-toggle"]').click();
  await page.waitForSelector('.profile__about', { timeout: 4000 });
  const c291About = ((await page.locator('.profile__about').textContent()) ?? '').trim();
  await shot(page, '29a-about-expanded');
  await page.locator('[data-action="check-update"]').click();
  const c291Toast = await waitToastText(page, 'H5 端自动保持最新');
  check(
    'C29.1 关于区渲染：版本号副标题 + 关于行展开（定位/版权）+ H5 检查更新降级',
    c291Ver !== '' &&
      c291About.includes(`ToIV · v${c291Ver}`) &&
      c291About.includes('AI 创作平台') &&
      c291About.includes('© 2026 ToIV') &&
      c291Toast.includes('H5 端自动保持最新'),
    `ver=${c291Ver} update="${c291UpdateSub}" toast="${c291Toast}"`,
  );

  // C29.2 清理缓存：种垃圾键 + 草稿键 → 二次确认弹窗 → 汇总 toast → 白名单保留/垃圾键删除
  await page.evaluate(() => {
    localStorage.setItem('ux_c29_junk', 'x'.repeat(2048));
    localStorage.setItem('ux_c29_junk2', 'y'.repeat(512));
    localStorage.setItem('assistant_draft:__new__', '走查草稿种子');
  });
  await page.locator('[data-action="clear-cache"]').click();
  await page.waitForSelector('.uni-modal__btn_primary', { timeout: 4000 });
  await shot(page, '29b-clear-cache-modal');
  await page.locator('.uni-modal__btn_primary').click();
  const c292Toast = await waitToastText(page, '已清理');
  await page.waitForTimeout(300);
  const c292After = await page.evaluate(() => ({
    junk: localStorage.getItem('ux_c29_junk'),
    junk2: localStorage.getItem('ux_c29_junk2'),
    token: localStorage.getItem('toiv_token'),
    settings: localStorage.getItem('toiv.settings'),
    draft: localStorage.getItem('assistant_draft:__new__'),
  }));
  check(
    'C29.2 清理缓存：确认弹窗 → 汇总 toast → 白名单（token/设置/草稿）保留、垃圾键删除',
    c292Toast.startsWith('已清理') &&
      c292After.junk === null &&
      c292After.junk2 === null &&
      typeof c292After.token === 'string' &&
      c292After.token.length > 0 &&
      typeof c292After.settings === 'string' &&
      c292After.draft === '走查草稿种子',
    `toast="${c292Toast}" token=${!!c292After.token} settings=${!!c292After.settings} draft=${c292After.draft}`,
  );

  // C29.3 导出诊断：点击 → toast → 剪贴板 JSON 含版本/平台/键清单 + 不含 token 值
  await page.locator('[data-action="export-diagnostics"]').click();
  const c293Toast = await waitToastText(page, '诊断信息已复制');
  const c293 = await page.evaluate(async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      const el = document.getElementById('#clipboard');
      text = el ? el.value : '';
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 即形状不符，下方断言兜底 */
    }
    return { text, parsed, token: localStorage.getItem('toiv_token') ?? '' };
  });
  const c293Shape =
    !!c293.parsed &&
    c293.parsed.app?.version === c291Ver &&
    c293.parsed.env?.platform === 'h5' &&
    typeof c293.parsed.apiBase === 'string' &&
    c293.parsed.apiBase.includes('9800') &&
    c293.parsed.session?.loggedIn === true &&
    Array.isArray(c293.parsed.storage?.keys) &&
    c293.parsed.storage.keys.some((k) => k && k.key === 'toiv_token') &&
    typeof c293.parsed.storage.totalSize === 'number' &&
    typeof c293.parsed.generatedAt === 'string';
  const c293NoToken =
    c293.text !== '' && (c293.token === '' || !c293.text.includes(c293.token));
  check(
    'C29.3 导出诊断：剪贴板 JSON 形状（版本/平台/键清单）+ 脱敏（不含 token 值）',
    c293Toast.includes('诊断信息已复制') && c293Shape && c293NoToken,
    `toast="${c293Toast}" keys=${c293.parsed?.storage?.keys?.length ?? '-'} total=${c293.parsed?.storage?.totalSize ?? '-'}`,
  );

  // ---------- C30 资产库批量管理（MP27）：多选模式 + 批量删除 ----------
  // mock 支撑：/__seed assets 种子 3 件（MP27 扩展，首屏即可见）；
  // DELETE /api/assets/:id 真删内存（MP13 已有，列表减项可断言）；/__reset 恢复空库（每次运行起始已调用）
  await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assets: [
        { id: 'c30-del-1', kind: 'character', name: '走查资产甲' },
        { id: 'c30-del-2', kind: 'scene', name: '走查资产乙' },
        { id: 'c30-keep-1', kind: 'prop', name: '走查资产丙' },
      ],
    }),
  });
  await page.goto(`${H5}/#/pages/assets/index`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelectorAll('.assets__card').length === 3,
    { timeout: 8000 },
  );

  // C30.1 「选择」钮进入多选 → 3 枚未选选择圈渲染 + 编辑/删除小钮隐藏 + 操作条接管底栏（新建入口让位）
  await page.locator('[data-action="enter-select"]').click();
  await page.waitForSelector('.assets__batch-bar', { timeout: 4000 });
  const c301Circles = await page.locator('.assets__card-selector').count();
  const c301Checked = await page.locator('.assets__card-selector[data-selected="1"]').count();
  const c301ActionsHidden = (await page.locator('.assets__actions').count()) === 0;
  const c301FooterGone = (await page.locator('.assets__footer').count()) === 0;
  await shot(page, '30a-select-mode');
  check(
    'C30.1 选择钮进入多选：卡片选择圈渲染 + 编辑/删除小钮隐藏 + 操作条接管底栏',
    c301Circles === 3 && c301Checked === 0 && c301ActionsHidden && c301FooterGone,
    `circles=${c301Circles} checked=${c301Checked} actionsHidden=${c301ActionsHidden} footerGone=${c301FooterGone}`,
  );

  // C30.2 勾选 2 件 → 操作条计数「已选 2 项」→ 删除 → 二次确认弹窗（文案含数量 + 不可恢复 + 图片文件保留）
  await page.locator('[data-asset-id="c30-del-1"]').click();
  await page.locator('[data-asset-id="c30-del-2"]').click();
  const c302Count = ((await page.locator('.assets__batch-count').textContent()) ?? '').trim();
  const c302Checked = await page.locator('.assets__card-selector[data-selected="1"]').count();
  await page.locator('[data-action="batch-delete"]').click();
  await page.waitForSelector('.uni-modal__btn_primary', { timeout: 4000 });
  const c302Modal = (((await page.locator('.uni-modal').textContent()) ?? '') + '').replace(
    /\s+/g,
    '',
  );
  await shot(page, '30b-batch-delete-modal');
  check(
    'C30.2 勾选 2 件 → 计数「已选 2 项」→ 删除确认弹窗（数量/不可恢复/文件保留）',
    c302Count === '已选 2 项' &&
      c302Checked === 2 &&
      c302Modal.includes('删除2件资产') &&
      c302Modal.includes('不可恢复') &&
      c302Modal.includes('图片文件保留'),
    `count="${c302Count}" checked=${c302Checked} modal="${c302Modal}"`,
  );

  // C30.3 确认 → 汇总 toast「已删除 2 项」+ 列表减为 1（保留件仍在）+ 退出选择态
  await page.locator('.uni-modal__btn_primary').click();
  const c303Toast = await waitToastText(page, '已删除');
  await page.waitForTimeout(500);
  const c303Gone =
    (await page.locator('[data-asset-id="c30-del-1"]').count()) === 0 &&
    (await page.locator('[data-asset-id="c30-del-2"]').count()) === 0;
  const c303Keep = (await page.locator('[data-asset-id="c30-keep-1"]').count()) === 1;
  const c303BarGone = (await page.locator('.assets__batch-bar').count()) === 0;
  const c303Cards = await page.locator('.assets__card').count();
  await shot(page, '30c-batch-delete-done');
  check(
    'C30.3 批量删除全成功：汇总 toast + 列表减项 + 退出选择态',
    c303Toast.includes('已删除 2 项') && c303Gone && c303Keep && c303BarGone && c303Cards === 1,
    `toast="${c303Toast}" gone=${c303Gone} keep=${c303Keep} barGone=${c303BarGone} cards=${c303Cards}`,
  );

  // ---------- C31 作品→资产联动（MP28）：详情页「存为资产」→ prefill 自动开新建弹层 → 保存 ----------
  // mock 支撑：/__seed jobs 置顶种子（id c31-src，prompt 已知 → 建议名确定性断言）；
  // /outputs/* 静态图（downloadFile 拉字节，uni-h5 返回 blob: 临时路径）；
  // /api/upload 回显 filename/worker（MP10 已有，blob: 经 uploadFile urlToFile 转 FormData）；
  // /api/assets POST 真建内存（MP13 已有，列表增项可断言）。无需 mock 改动。
  await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobs: [
        {
          id: 'c31-src',
          kind: 'txt2img',
          prompt: '走查存资产：雨夜霓虹街区胶片感',
          results: ['outputs/a.png'],
        },
      ],
    }),
  });
  await page.goto(`${H5}/#/pages/jobs/jobs`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.job-card:has-text("走查存资产")', { timeout: 8000 });
  await page.locator('.job-card:has-text("走查存资产")').first().click();
  await waitHash(page, 'pages-sub/artifact/artifact', 5000);
  await page.waitForTimeout(1000);

  // C31.1 image 作业详情：「存为资产」入口可见（video/audio/3D 不渲染由 tests/asset-prefill.test.ts 谓词用例覆盖）
  const c311Entries = await page.locator('[data-action="save-asset"]').count();
  await shot(page, '31a-save-asset-entry');
  check('C31.1 image 作业详情「存为资产」入口可见', c311Entries === 1, `entries=${c311Entries}`);

  // C31.2 点击 → 下载+上传 → 跳资产页且新建弹层自动打开（预览已填产物 mediaUrl、名称已填建议名）
  await page.locator('[data-action="save-asset"]').click();
  let c312Nav = true;
  try {
    await waitHash(page, 'pages/assets/index', 8000);
  } catch {
    c312Nav = false;
  }
  let c312Name = '';
  let c312Previews = 0;
  let c312PreviewOk = false;
  if (c312Nav) {
    await page.waitForSelector('.asset-form__name-input input', { timeout: 8000 });
    await page.waitForTimeout(600);
    c312Name = await page.locator('.asset-form__name-input input').inputValue();
    c312Previews = await page.locator('.asset-form__preview').count();
    c312PreviewOk = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.asset-form__preview-img img')).some((im) =>
        (im.getAttribute('src') ?? '').includes('/outputs/a.png'),
      ),
    );
  }
  await shot(page, '31b-prefill-sheet');
  check(
    'C31.2 存为资产 → 跳资产页 + 新建弹层自动打开（预览/建议名已预填）',
    c312Nav && c312Name === '走查存资产：雨夜霓虹街区' && c312Previews === 1 && c312PreviewOk,
    `nav=${c312Nav} name="${c312Name}" previews=${c312Previews} previewOk=${c312PreviewOk}`,
  );

  // C31.3 直接保存 → toast「已创建」→ 列表资产数 +1 且缩略图可见（走既有 createAsset 流程）
  const c313Before = await page.locator('.assets__card').count();
  await page.locator('.ui-btn:has-text("创建")').first().click();
  const c313Toast = await waitToastText(page, '已创建');
  await page.waitForTimeout(800);
  const c313After = await page.locator('.assets__card').count();
  const c313Names = await page.$$eval('.assets__name', (els) =>
    els.map((el) => el.textContent ?? ''),
  );
  const c313ThumbOk = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.assets__thumb img')).some(
      (im) => (im.getAttribute('src') ?? '').length > 0,
    ),
  );
  await shot(page, '31c-asset-created');
  check(
    'C31.3 保存 → toast 已创建 + 列表资产数 +1 + 缩略图可见',
    c313Toast.includes('已创建') &&
      c313After === c313Before + 1 &&
      c313Names.some((n) => n.includes('走查存资产：雨夜霓虹街区')) &&
      c313ThumbOk,
    `toast="${c313Toast}" before=${c313Before} after=${c313After} thumb=${c313ThumbOk}`,
  );

  // ---------- C32 作业进度 SSE 化（MP29）：会话内提交作业走 SSE 实时进度，无凭据作业仍轮询 ----------
  // mock 支撑：/__seed jobs 置顶 running 种子（prompt_id 对齐 txt2img 固定回包 p-new-1）
  // + sseJobs 剧本（success=progress×5→done；warning=中段插 quality_warning 再 done；error=中段 error）；
  // /api/jobs/:id/events 帧间隔 300ms，终态帧写出前翻转列表内存态（紧随的列表刷新即见终态/产物）。
  // 凭据链路：创作页提交 txt2img 回包 {prompt_id:'p-new-1',client_id,worker} 经 registerJobSseCredentials
  // 登记（uni-h5 reLaunch 为 SPA router.replace，模块态 Map 存活）；作业页 syncSseTrackers 仅对
  // 「活跃 + 有会话凭据」作业起流，终态/回退收口后清凭据（重启/离开后作业自动回既有轮询）。
  async function submitTxt2ImgForSse(promptText) {
    await page.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=SDXL 文生图', { timeout: 8000 });
    await page.locator('textarea').first().fill(promptText);
    await page.locator('.ui-btn:has-text("生成")').first().click();
    await waitHash(page, 'pages/jobs/jobs', 8000);
  }
  /** 在作业卡片（按提示词定位）上原子读状态：进度条存在性/徽章文案/产物图 */
  function cardState(pageRef, promptKey) {
    return pageRef.evaluate((key) => {
      const cards = Array.from(document.querySelectorAll('.job-card'));
      const card = cards.find((c) => (c.textContent ?? '').includes(key));
      if (!card) return null;
      const img = card.querySelector('.job-card__thumb img');
      return {
        hasProgress: card.querySelector('.job-card__progress') !== null,
        hasWarn: card.querySelector('.job-card__warn') !== null,
        done: (card.textContent ?? '').includes('已完成'),
        failed: (card.textContent ?? '').includes('失败'),
        thumbOk: img !== null && (img.getAttribute('src') ?? '').includes('/outputs/'),
      };
    }, promptKey);
  }

  // ==== C32.1 success：进度条出现且 pct 单调增长 → done 收口（进度条消失 + 徽章「已完成」+ 产物图）====
  await fetch(`${API}/__reset`);
  await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobs: [
        { id: 'c32-ok', prompt_id: 'p-new-1', status: 'running', prompt: '走查 SSE 成功', results: [] },
      ],
      sseJobs: [{ prompt_id: 'p-new-1', scenario: 'success' }],
    }),
  });
  await submitTxt2ImgForSse('走查 SSE：雪夜灯箱，胶片颗粒');
  let c321Bar = true;
  try {
    await page.waitForSelector('.job-card__progress', { timeout: 8000 });
  } catch {
    c321Bar = false;
  }
  let c321Grew = false;
  let c321PctA = 0;
  let c321PctB = 0;
  if (c321Bar) {
    c321PctA = parseInt(
      (await page.locator('.job-card__progress-text').first().textContent()) ?? '0',
      10,
    );
    c321Grew = await page
      .waitForFunction(
        (p0) => {
          const el = document.querySelector('.job-card__progress-text');
          if (!el) return false;
          const v = parseInt(el.textContent ?? '0', 10);
          return Number.isFinite(v) && v > p0 ? v : false;
        },
        c321PctA,
        { timeout: 5000 },
      )
      .then(async (h) => {
        c321PctB = await h.jsonValue();
        return true;
      })
      .catch(() => false);
  }
  const c321Done = await page
    .waitForFunction(
      (key) => {
        const cards = Array.from(document.querySelectorAll('.job-card'));
        const card = cards.find((c) => (c.textContent ?? '').includes(key));
        if (!card) return false;
        if (card.querySelector('.job-card__progress') !== null) return false;
        if (!(card.textContent ?? '').includes('已完成')) return false;
        const img = card.querySelector('.job-card__thumb img');
        return img !== null && (img.getAttribute('src') ?? '').includes('/outputs/');
      },
      '走查 SSE 成功',
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  await shot(page, '32a-sse-success-done');
  check(
    'C32.1 会话内作业 SSE：进度条出现 + pct 单调增长 → done 收口（进度条消失/徽章已完成/产物图）',
    c321Bar && c321Grew && c321Done,
    `bar=${c321Bar} pct=${c321PctA}→${c321PctB} done=${c321Done}`,
  );

  // ==== C32.2 warning：中段 quality_warning → 卡片预警图标 + toast → done 收口 ====
  await fetch(`${API}/__reset`);
  await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobs: [
        { id: 'c32-warn', prompt_id: 'p-new-1', status: 'running', prompt: '走查 SSE 预警', results: [] },
      ],
      sseJobs: [{ prompt_id: 'p-new-1', scenario: 'warning' }],
    }),
  });
  await submitTxt2ImgForSse('走查 SSE：雾港黄昏，长曝光');
  let c322Warn = false;
  try {
    await page.waitForSelector('.job-card__warn', { timeout: 8000 });
    c322Warn = true;
  } catch {
    c322Warn = false;
  }
  const c322Toast = await waitToastText(page, '质量预警', 4000);
  const c322Done = await page
    .waitForFunction(
      (key) => {
        const cards = Array.from(document.querySelectorAll('.job-card'));
        const card = cards.find((c) => (c.textContent ?? '').includes(key));
        if (!card) return false;
        return (
          card.querySelector('.job-card__progress') === null &&
          (card.textContent ?? '').includes('已完成')
        );
      },
      '走查 SSE 预警',
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  await shot(page, '32b-sse-warning-done');
  check(
    'C32.2 quality_warning：卡片预警图标 + toast「质量预警」→ done 收口（只提示不阻塞）',
    c322Warn && c322Toast.includes('质量预警') && c322Done,
    `warn=${c322Warn} toast="${c322Toast}" done=${c322Done}`,
  );

  // ==== C32.3 error + 轮询兜底：error 帧 → 徽章「失败」；无凭据作业（未会话内提交）全程无进度条 ====
  await fetch(`${API}/__reset`);
  await fetch(`${API}/__seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobs: [
        { id: 'c32-err', prompt_id: 'p-new-1', status: 'running', prompt: '走查 SSE 失败', results: [] },
        { id: 'c32-poll', prompt_id: 'p-nocreds', status: 'running', prompt: '走查无凭据轮询兜底', results: [] },
      ],
      sseJobs: [{ prompt_id: 'p-new-1', scenario: 'error' }],
    }),
  });
  await submitTxt2ImgForSse('走查 SSE：雨夜霓虹，赛博街巷');
  // SSE 卡进度条出现期间，无凭据卡（c32-poll 未登记凭据）不应有进度条（早期采样）
  let c323SseBar = true;
  try {
    await page.waitForSelector('.job-card__progress', { timeout: 8000 });
  } catch {
    c323SseBar = false;
  }
  const c323EarlyNoCreds = (await cardState(page, '走查无凭据轮询兜底')) ?? {};
  // error 帧 → onError 收口：徽章「失败」+ 进度条消失
  const c323Failed = await page
    .waitForFunction(
      (key) => {
        const cards = Array.from(document.querySelectorAll('.job-card'));
        const card = cards.find((c) => (c.textContent ?? '').includes(key));
        if (!card) return false;
        return (
          card.querySelector('.job-card__progress') === null &&
          (card.textContent ?? '').includes('失败')
        );
      },
      '走查 SSE 失败',
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  const c323LateNoCreds = (await cardState(page, '走查无凭据轮询兜底')) ?? {};
  const c323NoCredsClean =
    c323EarlyNoCreds.hasProgress === false &&
    !c323EarlyNoCreds.done &&
    c323LateNoCreds.hasProgress === false;
  await shot(page, '32c-sse-error-fallback');
  check(
    'C32.3 error 帧 → 徽章「失败」收口 + 无凭据作业全程无进度条（轮询兜底不回退）',
    c323SseBar && c323Failed && c323NoCredsClean,
    `sseBar=${c323SseBar} failed=${c323Failed} noCreds early=${c323EarlyNoCreds.hasProgress} late=${c323LateNoCreds.hasProgress}`,
  );

  // ---------- C33 对话助手附图（MP30）：图片钮 → 选图即传 → chip → image 上行 → 气泡留痕 ----------
  // mock 支撑：/api/upload 回显 filename/worker（MP10 已有，blob: 经 uni.uploadFile 转 FormData）；
  // /__lastChatBody 调试端点（MP30 新增）返回最近一次 chat 请求体，供断言 image 字段有/无。
  // 选图链路：showActionSheet（拍照/相册，uni.chooseMedia 不入 uni-h5 导出清单的替代三件套）→
  // chooseImage → filechooser 拦截（同 C20.4）；H5 端 tempFilePath 为 blob:，chip/气泡以 blob: 渲染。
  await page.goto(`${H5}/#/pages/assistant/assistant`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.assistant__textarea textarea', { timeout: 8000 });
  // 新会话隔离：C22-C27 残留会话的本地消息不干扰气泡/chip 计数（C32 的 __reset 已清 mock 会话）
  await page.locator('.assistant__nav-btn').first().click();
  await page.waitForSelector('text=和 ToIV 聊聊', { timeout: 6000 });

  // C33.1 图片钮 → action sheet（拍照/相册）→ 相册选图 → chip 出现（缩略图可见 + 上传毕转 ready）
  await page.locator('.assistant__imgbtn').click();
  await page.waitForSelector('.uni-actionsheet__cell', { timeout: 5000 });
  const [c33Chooser1] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.uni-actionsheet__cell:has-text("相册")').first().click(),
  ]);
  await c33Chooser1.setFiles({ name: 'walkthrough-c33.png', mimeType: 'image/png', buffer: PNG_1PX_WALK });
  let c331Chip = false;
  try {
    await page.waitForSelector('.assistant__imgchip', { timeout: 8000 });
    c331Chip = true;
  } catch {
    c331Chip = false;
  }
  // 上传完成信号：loading 遮罩消失（ready 态才可发送，上传中发送键禁用由 store/canSend 同律保证）
  let c331Ready = false;
  try {
    await page.waitForFunction(() => !document.querySelector('.assistant__imgchip-loading'), {
      timeout: 8000,
    });
    c331Ready = (await page.locator('.assistant__imgchip').count()) === 1;
  } catch {
    c331Ready = false;
  }
  const c331Thumb = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.assistant__imgchip-thumb img')).some(
      (im) => (im.getAttribute('src') ?? '').length > 0,
    ),
  );
  await shot(page, '33a-image-chip');
  check(
    'C33.1 图片钮 → 选图即传 → chip 出现（缩略图可见 + ready 可发）',
    c331Chip && c331Ready && c331Thumb,
    `chip=${c331Chip} ready=${c331Ready} thumb=${c331Thumb}`,
  );

  // C33.2 发送 → 请求体含 image={filename,worker}（/__lastChatBody 断言）→ 回复流正常 →
  // user 气泡显示图（本地 previewUri 留痕）+ chip 清空
  await page.locator('.assistant__textarea textarea').fill('照这张图上胶片色调');
  await page.locator('.assistant__send').click();
  let c332Reply = false;
  try {
    await page.waitForSelector('text=已按你的想法生成了一张图', { timeout: 10000 });
    c332Reply = true;
  } catch {
    c332Reply = false;
  }
  const c332Body = await fetch(`${API}/__lastChatBody`)
    .then((r) => r.json())
    .catch(() => null);
  const c332Image = c332Body?.image;
  const c332ImageOk =
    typeof c332Image?.filename === 'string' &&
    c332Image.filename.length > 0 &&
    c332Image.worker === 'w1';
  const c332BubbleImg = await page.locator('.assistant__msg-image').count();
  const c332Chips = await page.locator('.assistant__chip').count();
  await shot(page, '33b-image-sent');
  check(
    'C33.2 发送 → image 上行 + 回复流正常 + user 气泡留痕 + chip 清空',
    c332Reply && c332ImageOk && c332BubbleImg === 1 && c332Chips === 0,
    `reply=${c332Reply} image=${JSON.stringify(c332Image ?? null)} bubbleImg=${c332BubbleImg} chips=${c332Chips}`,
  );

  // C33.3 再选图 → chip X 移除 → 发送 → 请求体无 image 字段（流式正常收口）
  await page.locator('.assistant__imgbtn').click();
  await page.waitForSelector('.uni-actionsheet__cell', { timeout: 5000 });
  const [c33Chooser2] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.uni-actionsheet__cell:has-text("相册")').first().click(),
  ]);
  await c33Chooser2.setFiles({ name: 'walkthrough-c33b.png', mimeType: 'image/png', buffer: PNG_1PX_WALK });
  await page.waitForSelector('.assistant__imgchip', { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector('.assistant__imgchip-loading'), {
    timeout: 8000,
  });
  await page.locator('.assistant__imgchip .assistant__chip-x').click();
  await page.waitForFunction(() => !document.querySelector('.assistant__imgchip'), { timeout: 6000 });
  const c333ChipGone = (await page.locator('.assistant__imgchip').count()) === 0;
  await page.locator('.assistant__textarea textarea').fill('这次不带图纯文字再来一张');
  await page.locator('.assistant__send').click();
  // 流式起止：停止键出现（发送生效）→ 停止键消失（收口），防早判读到上一轮的静止态
  let c333Started = false;
  try {
    await page.waitForSelector('.assistant__send--stop', { timeout: 3000 });
    c333Started = true;
  } catch {
    c333Started = false;
  }
  let c333Done = false;
  try {
    await page.waitForFunction(() => !document.querySelector('.assistant__send--stop'), {
      timeout: 10000,
    });
    c333Done = true;
  } catch {
    c333Done = false;
  }
  const c333Body = await fetch(`${API}/__lastChatBody`)
    .then((r) => r.json())
    .catch(() => null);
  const c333NoImage = c333Body !== null && !('image' in c333Body);
  await shot(page, '33c-image-detached-sent');
  check(
    'C33.3 chip X 移除后发送 → 请求体无 image 字段 + 流式正常收口',
    c333ChipGone && c333Started && c333Done && c333NoImage,
    `chipGone=${c333ChipGone} started=${c333Started} done=${c333Done} hasImage=${c333Body ? 'image' in c333Body : 'n/a'}`,
  );

  // ---------- C14-C16 R18 引擎（MP12）：nsfwIntent=true 第二上下文（X-NSFW: 1 自动注入） ----------
  const r18Context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await r18Context.addInitScript((api) => {
    window.localStorage.setItem(
      'toiv.settings',
      JSON.stringify({
        paletteId: 'atelier',
        mode: 'light',
        apiBaseOverride: api,
        nsfwIntent: true,
      }),
    );
  }, API);
  const r18 = await r18Context.newPage();
  r18.on('pageerror', (e) => console.log('[r18 pageerror]', e.message));

  // R18 上下文 storage 独立，需重新登录拿 token（MP32 原生 button：.login__submit）
  await r18.goto(`${H5}/#/pages/login/login`, { waitUntil: 'networkidle' });
  await r18.waitForSelector('.field__input input', { timeout: 4000 });
  await r18.locator('.field__input input').first().fill('ux-walkthrough@toiv.dev');
  await r18.locator('.field__input--password input').fill('mock-pass-123');
  await r18.locator('.login__form .login__submit').first().click();
  await r18.waitForSelector('textarea', { timeout: 8000 });

  // C14.1 引擎抽屉：5 枚 R18 徽标（mock 按 X-NSFW 放行 5 个 R18 引擎）
  await r18.locator('.create__engine-btn').click();
  await r18.waitForSelector('.engine-item', { timeout: 6000 });
  const badgeCount = await r18.locator('.engine-item__badge').count();
  check('C14.1 R18 上下文引擎列表含 5 枚 R18 徽标', badgeCount === 5, `${badgeCount} 枚`);
  await shot(r18, '14a-r18-engine-badges');

  // C14.2 ltx-nsfw-t2v：无参考媒体字段 → 提交成功跳作业页
  await clickEngine(r18, 'LTX 2.3 文生视频(R18)');
  await r18.waitForTimeout(600);
  const r18t2vMedia = await r18.locator('.ref-image, .ref-video, .ref-audio').count();
  check('C14.2 ltx-nsfw-t2v 参数区渲染（无参考媒体字段）', r18t2vMedia === 0);
  await r18.locator('textarea').first().fill('R18 走查：暗房人像，柔光');
  await r18.locator('.ui-btn:has-text("生成")').first().click();
  let r18t2vNav = true;
  try {
    await waitHash(r18, 'pages/jobs/jobs', 8000);
  } catch {
    r18t2vNav = false;
  }
  check('C14.3 ltx-nsfw-t2v 提交成功 → 跳作业页', r18t2vNav, r18.url());
  await shot(r18, '14b-ltx-nsfw-t2v-submitted');

  // C15 ltx-nsfw-lipsync：图+音双字段渲染；缺媒体时生成钮禁用（canSubmit 拦截）
  await r18.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await r18.waitForSelector('textarea', { timeout: 8000 });
  await r18.locator('.create__engine-btn').click();
  await r18.waitForSelector('.engine-item', { timeout: 6000 });
  await clickEngine(r18, 'LTX 2.3 对口型(R18)');
  await r18.waitForTimeout(600);
  const lipImage = await r18.locator('.ref-image').count();
  const lipAudio = await r18.locator('.ref-audio').count();
  check(
    'C15.1 ltx-nsfw-lipsync 参考图 + 驱动音频字段渲染',
    lipImage === 1 && lipAudio === 1,
    `image=${lipImage} audio=${lipAudio}`,
  );
  await shot(r18, '15a-ltx-lipsync-fields');
  await r18.locator('textarea').first().fill('对口型走查');
  await r18.waitForTimeout(300);
  const submitDisabled = await r18.locator('.ui-btn--disabled:has-text("生成")').count();
  check('C15.2 缺参考图/音频时生成钮禁用', submitDisabled > 0);
  await shot(r18, '15b-ltx-lipsync-blocked');

  // C16 h3-nsfw-t2v：与 SFW H3 同一 POST /api/h3/t2v 链路 → 提交成功跳作业页
  await r18.goto(`${H5}/#/`, { waitUntil: 'networkidle' });
  await r18.waitForSelector('textarea', { timeout: 8000 });
  await r18.locator('textarea').first().fill('R18 H3 走查：雨夜霓虹，胶片颗粒');
  await r18.locator('.create__engine-btn').click();
  await r18.waitForSelector('.engine-item', { timeout: 6000 });
  await clickEngine(r18, 'MiniMax H3 文生视频(R18)');
  await r18.waitForTimeout(600);
  await r18.locator('.ui-btn:has-text("生成")').first().click();
  let r18h3Nav = true;
  try {
    await waitHash(r18, 'pages/jobs/jobs', 8000);
  } catch {
    r18h3Nav = false;
  }
  check('C16.1 h3-nsfw-t2v 提交成功（复用 /api/h3/t2v）→ 跳作业页', r18h3Nav, r18.url());
  await shot(r18, '16-h3-nsfw-t2v-submitted');
  await r18Context.close();
} catch (err) {
  check('走查异常中断', false, err.message);
  await shot(page, '99-error');
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== 走查汇总：${results.length - failed.length}/${results.length} 通过 ====`);
process.exit(failed.length > 0 ? 1 : 0);

import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * P0.3 H3 提示词风格 A/B 真机对比(chromium-authed project,生产 core)
 *
 * 目的:同一 H3 t2v 引擎(6 秒档,后端策略层吸附 141 帧),对 3 个同题场景各跑
 *   风格 A=全正向(约束就地转化为正向描述)
 *   风格 B=同一正向核心+【严格限制】负向块
 * 共 6 条生成,全程真实浏览器驱动 GenerateView(禁止直接调接口提交生成)。
 *
 * 链路:R18 关闭 → /?view=video → 引擎下拉选「MiniMax H3 文生视频」(h3-t2v)
 *   → 时长(秒)设 6(注册表秒数化;17k+5 网格 @24fps 由后端统一策略层换算)
 *   → 宽高保持默认 1344×768(32 对齐)
 *   → 逐条串行:等上一条 done/error/超时(12min)再提交下一条
 *   → done 后从 .stage-media-wrap <video> 抽 起/中/尾 三帧截图
 *
 * 产物:apps/web/test-results/h3-ab/(screenshot×N + report.json)
 * 运行:
 *   npx playwright test e2e/authed-h3-prompt-ab.spec.ts \
 *     --config=playwright.prod.config.ts --project=chromium-authed --workers=1
 */

const OUT_DIR = path.join("test-results", "h3-ab");
const REPORT_PATH = path.join(OUT_DIR, "report.json");
const PER_JOB_TIMEOUT_MS = 12 * 60 * 1000; // 单条最长等 12 分钟
const H3_ENGINE_ID = "h3-t2v";
const H3_DURATION_SEC = "6"; // 6s 档(注册表已秒数化;17k+5 网格 @24fps 由后端策略层吸附 141 帧)

// ─── 6 条钉死提示词(逐字,禁止改写)───
const A1 = `生成一段6秒、16:9、2K、原生立体声视频:雪夜天台,两名刀客相隔五步对峙。黑衣刀客直身长刀垂于身侧,白衣刀客刀尖指地。0—0.5秒,雪粒横飞,黑衣刀客拇指顶开刀镡。0.5—1.5秒,白衣刀客踏步直刺,刀锋破开雪幕;黑衣刀客侧身让过刀线,长刀自下而上斜撩。1.5—2.8秒,两刀在画面中央相击,火星溅起照亮雪粒,白衣刀客受力后撤半步,黑衣刀客顺势转腕横斩。2.8—4.2秒,白衣刀客竖刀格挡,被横斩力道推得单膝触地,积雪从檐边震落。4.2—5.2秒,黑衣刀客收刀入鞘背身站立,白衣刀客跪姿刀尖插入积雪。5.2—6秒,雪落渐稳,黑衣刀客剪影定格。剪辑与动作:每次攻击写清起手方向、接触点与受力反应,上招未收完下招已启动,切点落在接触与遮挡处。视觉风格:冷蓝夜色,檐灯一点暖黄,硬边光影,雪花高亮颗粒。声音设计:风声底噪、衣料摩擦、一声刀击脆响、收刀金属摩擦,无配乐。`;
const B1 = `${A1}\n【严格限制】不要多余角色与围观人群;不要血液与伤口特写;不要剑气、能量光效、魔法阵;不要慢动作;不要镜头眩光与景深虚化;不要白天与室内场景;不要双刀、巨剑、枪械;不要刀身弯曲与尺寸漂移;不要面部崩坏与多余手指;不要字幕、水印、Logo;不要配乐盖过刀击声。`;

const A2 = `生成一段6秒、16:9、2K、原生立体声视频:傍晚火车站台,暖色灯光。母亲五十岁出头穿深灰大衣,女儿二十多岁穿米色风衣手提旧皮箱。0—1秒,中景两人相对而立,女儿把围巾给母亲系上。1—2.2秒,近景,母亲低头看围巾,手指按住围巾一角,抬眼;女儿微笑,眼眶发红。2.2—3.6秒,女儿说:"妈,我走了。"声音轻,中文,口型同步;母亲点头说:"到了来信。"3.6—4.8秒,车门提示音响,女儿转身登车,手握门框停半秒。4.8—6秒,车门关闭列车启动,母亲原地抬手又放下,暖光从她肩上移开。剪辑与动作:中近景只保留停顿、呼吸、手部未完成动作,切镜由说话权与动作决定触发。视觉风格:暖橙站台灯与蓝灰暮色对比,远景人流柔焦。声音设计:广播底噪、轮轨声、两句台词、车门提示音,无配乐。`;
const B2 = `${A2}\n【严格限制】不要额外台词;不要拥抱、痛哭、奔跑追车;不要闪回蒙太奇;不要字幕与水印;不要面部畸变与多余手指;不要围观群众正脸特写;不要手机入镜;不要配乐煽情盖过人声;不要镜头晃动;不要逆光剪影替代表情。`;

const A3 = `生成一段6秒、16:9、2K、原生立体声视频:雨后夜晚的城市窄巷,青灰石板路面积水如镜。0—1.2秒,低机位,积水倒映两侧暖黄灯箱,一滴雨水落进水洼涟漪荡开。1.2—2.6秒,镜头沿水面低角度缓慢前推,涟漪把倒影打碎又合拢,巷口出现撑透明雨伞的行人剪影由远及近。2.6—4秒,行人经过镜头,伞沿雨水成串落下,脚步踏碎灯箱倒影水花微溅。4—5秒,行人走远背影缩小,巷尾信号灯由红转绿,光在积水里换色。5—6秒,画面恢复平静,只剩雨声与镜面水洼,灯箱倒影重新拼合完整。剪辑与动作:单镜头缓慢前推,速度均匀。视觉风格:青灰与暖黄双色,雨后高反射,轻微颗粒。声音设计:细雨底噪、脚步踏水声、远处车声一次掠过,无配乐。`;
const B3 = `${A3}\n【严格限制】不要大雨倾盆只要细雨;不要闪电;不要行人正脸;不要多人同框;不要车辆驶入巷道;不要霓虹紫粉配色;不要赛博朋克 HUD;不要镜头快速推拉与手持晃动;不要字幕、水印、Logo。`;

interface AbItem {
  id: string;
  scenario: string;
  style: "A" | "B";
  style_label: "全正向" | "正向+严格限制";
  prompt: string;
  status: "pending" | "done" | "error" | "timeout" | "submit_failed";
  submit_http: number | null;
  prompt_id: string | null;
  worker: string | null;
  seed: number | null;
  video_url: string | null;
  wait_ms: number | null;
  frames: string[];
  error: string | null;
  backend_status_on_timeout: string | null;
}

const ITEMS: AbItem[] = [
  { id: "A1", scenario: "武戏·雪夜一刀", style: "A", style_label: "全正向", prompt: A1, status: "pending", submit_http: null, prompt_id: null, worker: null, seed: null, video_url: null, wait_ms: null, frames: [], error: null, backend_status_on_timeout: null },
  { id: "B1", scenario: "武戏·雪夜一刀", style: "B", style_label: "正向+严格限制", prompt: B1, status: "pending", submit_http: null, prompt_id: null, worker: null, seed: null, video_url: null, wait_ms: null, frames: [], error: null, backend_status_on_timeout: null },
  { id: "A2", scenario: "文戏·车站告别", style: "A", style_label: "全正向", prompt: A2, status: "pending", submit_http: null, prompt_id: null, worker: null, seed: null, video_url: null, wait_ms: null, frames: [], error: null, backend_status_on_timeout: null },
  { id: "B2", scenario: "文戏·车站告别", style: "B", style_label: "正向+严格限制", prompt: B2, status: "pending", submit_http: null, prompt_id: null, worker: null, seed: null, video_url: null, wait_ms: null, frames: [], error: null, backend_status_on_timeout: null },
  { id: "A3", scenario: "氛围·雨后窄巷", style: "A", style_label: "全正向", prompt: A3, status: "pending", submit_http: null, prompt_id: null, worker: null, seed: null, video_url: null, wait_ms: null, frames: [], error: null, backend_status_on_timeout: null },
  { id: "B3", scenario: "氛围·雨后窄巷", style: "B", style_label: "正向+严格限制", prompt: B3, status: "pending", submit_http: null, prompt_id: null, worker: null, seed: null, video_url: null, wait_ms: null, frames: [], error: null, backend_status_on_timeout: null },
];

interface AbReport {
  task: string;
  started_at: string;
  finished_at: string | null;
  engine_id: string;
  engine_label: string | null;
  engine_options_video: string[];
  degraded_path: boolean;
  params: Record<string, unknown>;
  per_job_timeout_ms: number;
  items: AbItem[];
  summary: unknown;
}

const report: AbReport = {
  task: "P0.3 H3 提示词风格 A/B 真机对比(全正向 vs 正向+严格限制)",
  started_at: new Date().toISOString(),
  finished_at: null,
  engine_id: H3_ENGINE_ID,
  engine_label: null,
  engine_options_video: [],
  degraded_path: false,
  params: { width: 1344, height: 768, length: 141, steps: 20, seed: "random(每条随机)", fps: "24(H3 固定)" },
  per_job_timeout_ms: PER_JOB_TIMEOUT_MS,
  items: ITEMS,
  summary: null,
};

function flushReport() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

/** 剥掉 URL 上的 token 查询参数(报告只留签名 URL,不落 token)。 */
function stripToken(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, "http://192.168.71.47:3100");
    u.searchParams.delete("token");
    return u.pathname + u.search;
  } catch {
    return rawUrl.replace(/([?&])token=[^&]*/g, "$1").replace(/[?&]$/, "");
  }
}

/** 视频就绪:等 metadata,muted+play(浏览器 autoplay 策略),pause,seek 到 t 秒并等 seeked。 */
async function seekVideo(page: Page, t: number) {
  const video = page.locator(".stage-media-wrap video.media-main");
  await video.evaluate(async (v, time) => {
    const vid = v as HTMLVideoElement;
    vid.muted = true;
    if (vid.readyState < 1) {
      await new Promise<void>((res) => {
        const done = () => res();
        vid.addEventListener("loadedmetadata", done, { once: true });
        vid.load();
        setTimeout(done, 15000);
      });
    }
    try {
      await vid.play();
    } catch {
      /* muted 下一般可播;失败也继续 seek */
    }
    vid.pause();
    const dur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 1;
    const target = Math.min(Math.max(0.05, time), Math.max(0.05, dur - 0.05));
    await new Promise<void>((res) => {
      const done = () => {
        vid.removeEventListener("seeked", done);
        res();
      };
      vid.addEventListener("seeked", done);
      vid.currentTime = target;
      setTimeout(done, 8000);
    });
  }, t);
}

/** 抽 起/中/尾 三帧截图,返回落盘路径。 */
async function captureFrames(page: Page, itemId: string): Promise<string[]> {
  const video = page.locator(".stage-media-wrap video.media-main");
  const duration = await video.evaluate(
    (v) => ((v as HTMLVideoElement).duration as number) || 0,
  );
  const times: Array<[string, number]> = [
    ["start", 0.1],
    ["mid", duration > 0 ? duration / 2 : 3],
    ["end", duration > 0 ? duration - 0.15 : 5.8],
  ];
  const out: string[] = [];
  for (const [tag, t] of times) {
    await seekVideo(page, t);
    const p = path.join(OUT_DIR, `${itemId}-${tag}.png`);
    await video.screenshot({ path: p });
    out.push(p);
  }
  return out;
}

/** 前端跟踪超时后,只读查询后端 /api/jobs 拿该 prompt_id 的真实状态(不提交生成,不违反浏览器约束)。 */
async function backendJobStatus(page: Page, promptId: string | null): Promise<string> {
  if (!promptId) return "no_prompt_id";
  try {
    return await page.evaluate(async (pid) => {
      const token = window.localStorage.getItem("toiv_token") ?? "";
      const res = await fetch("/api/jobs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return `http_${res.status}`;
      const data = (await res.json()) as {
        jobs?: Array<{ prompt_id?: string; id?: string; status?: string }>;
      };
      const jobs = Array.isArray(data) ? (data as unknown as Array<{ prompt_id?: string; id?: string; status?: string }>) : (data.jobs ?? []);
      const hit = jobs.find((j) => j.prompt_id === pid || j.id === pid);
      return hit?.status ?? "not_found_in_jobs";
    }, promptId);
  } catch (e) {
    return `query_failed:${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 超时后点「取消」重置前端跟踪(后端作业继续在实例排队/执行),让下一条可提交。 */
async function resetFrontendTracking(page: Page) {
  const cancelBtn = page.locator('.promptbar-actions button:has-text("取消")');
  if (await cancelBtn.isVisible().catch(() => false)) {
    await cancelBtn.click();
  }
  await expect(page.locator("button.promptbar-submit")).toBeEnabled({
    timeout: 15000,
  });
}

test.describe("H3 提示词风格 A/B 真机对比(P0.3)", () => {
  test.use({
    storageState: ".auth/admin.json",
    viewport: { width: 1600, height: 900 },
  });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: ".auth/admin.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    const token = await page.evaluate(() =>
      window.localStorage.getItem("toiv_token"),
    );
    await context.close();
    if (!token) {
      test.skip(true, "storageState 中无 token,跳过 H3 A/B 对比测试");
    }
  });

  test("6 条 H3 t2v(6 秒档)串行生成并抽帧", async ({ page }) => {
    test.setTimeout(110 * 60 * 1000); // 6×12min + 导航/抽帧余量
    flushReport();

    // SFW 上下文进视频工作台(显式清 R18 键,防其它 spec 残留状态)
    await page.addInitScript(() => {
      window.localStorage.removeItem("toiv_r18_mode");
      window.localStorage.removeItem("toiv_nsfw_age_confirmed");
    });
    await page.goto("/?view=video", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      /* networkidle 不强制 */
    }

    // 引擎下拉就绪,列出视频引擎确认真实显示名
    const engineSel = page.locator(
      '.generate-params select[aria-label="选择引擎"]',
    );
    await expect(engineSel).toBeVisible({ timeout: 20000 });
    await expect
      .poll(
        async () => engineSel.locator("option").count(),
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
    const optionTexts = await engineSel.locator("option").allTextContents();
    report.engine_options_video = optionTexts;
    const h3Option = engineSel.locator(`option[value="${H3_ENGINE_ID}"]`);
    const h3Count = await h3Option.count();
    if (h3Count === 0) {
      report.degraded_path = true;
      report.finished_at = new Date().toISOString();
      flushReport();
      test.skip(
        true,
        `GenerateView 无 SFW H3 引擎入口(可选:${optionTexts.join(" / ")}),需走降级路径`,
      );
      return;
    }
    report.engine_label = ((await h3Option.first().textContent()) ?? "").trim();
    const h3Disabled = await h3Option.first().isDisabled();
    if (h3Disabled) {
      report.finished_at = new Date().toISOString();
      flushReport();
      test.skip(true, `H3 引擎不可用:${report.engine_label}`);
      return;
    }
    await engineSel.selectOption(H3_ENGINE_ID);
    await expect(engineSel).toHaveValue(H3_ENGINE_ID);

    // 时长(秒)→ 6(6 秒档;后端策略层 17k+5 吸附 141 帧);宽高/步数保持引擎默认(1344×768/20 步)
    const durationInput = page
      .locator(".generate-params label.ui-field", { hasText: "时长" })
      .locator("input");
    await expect(durationInput).toBeVisible({ timeout: 10000 });
    await durationInput.fill(H3_DURATION_SEC);
    await expect(durationInput).toHaveValue(H3_DURATION_SEC);

    const promptTa = page.locator(".promptbar-textarea");
    const submitBtn = page.locator("button.promptbar-submit");
    const seenVideoUrls = new Set<string>();

    for (const item of ITEMS) {
      const t0 = Date.now();
      try {
        // 填提示词(正向框固定 .promptbar-textarea,避免误中高级参数负向框)
        await expect(promptTa).toBeEnabled({ timeout: 15000 });
        await promptTa.fill(item.prompt);
        await expect(promptTa).toHaveValue(item.prompt);
        await expect(submitBtn).toBeEnabled({ timeout: 15000 });

        // 提交:等 POST /api/h3/t2v 响应作为 job 提交成功证据
        const respPromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/h3/t2v") && r.request().method() === "POST",
          { timeout: 60000 },
        );
        await submitBtn.click();
        const resp = await respPromise;
        item.submit_http = resp.status();
        const body = (await resp.json().catch(() => null)) as {
          prompt_id?: string;
          worker?: string;
          seed?: number;
          detail?: unknown;
        } | null;
        if (!resp.ok()) {
          item.status = "submit_failed";
          item.error = `HTTP ${resp.status()}: ${JSON.stringify(body?.detail ?? body)}`;
          await page.screenshot({
            path: path.join(OUT_DIR, `${item.id}-submitfail.png`),
          });
          flushReport();
          continue;
        }
        item.prompt_id = body?.prompt_id ?? null;
        item.worker = body?.worker ?? null;
        item.seed = typeof body?.seed === "number" ? body.seed : null;

        // 先确认新条目进入 running(防止匹配到上一条残留 done 态)
        await expect(page.locator(".stage-loading")).toBeVisible({
          timeout: 30000,
        });

        // 等终态:done(舞台出视频)或 error(错误卡)
        const terminal = page.locator(
          ".stage-media-wrap video.media-main, .stage-error-card",
        );
        try {
          await terminal.first().waitFor({
            state: "visible",
            timeout: PER_JOB_TIMEOUT_MS,
          });
        } catch {
          item.status = "timeout";
          item.wait_ms = Date.now() - t0;
          item.backend_status_on_timeout = await backendJobStatus(
            page,
            item.prompt_id,
          );
          await page.screenshot({
            path: path.join(OUT_DIR, `${item.id}-timeout.png`),
          });
          await resetFrontendTracking(page);
          flushReport();
          continue;
        }
        item.wait_ms = Date.now() - t0;

        if (await page.locator(".stage-error-card").isVisible().catch(() => false)) {
          item.status = "error";
          item.error = (
            (await page.locator(".stage-error-desc").textContent()) ?? ""
          ).trim();
          const detail = await page
            .locator(".stage-error-raw")
            .textContent()
            .catch(() => null);
          if (detail) item.error += ` | detail: ${detail.trim().slice(0, 400)}`;
          flushReport();
          continue;
        }

        // done:取产物签名 URL(剥 token),防与历史条目重复
        const video = page.locator(".stage-media-wrap video.media-main");
        const rawSrc = (await video.getAttribute("src")) ?? "";
        item.video_url = stripToken(rawSrc);
        item.status = "done";
        if (seenVideoUrls.has(item.video_url)) {
          item.error = "产物 URL 与上一条重复(疑似匹配到残留条目)";
        }
        seenVideoUrls.add(item.video_url);
        item.frames = await captureFrames(page, item.id);
        flushReport();
      } catch (e) {
        item.status = item.status === "pending" ? "error" : item.status;
        item.wait_ms = item.wait_ms ?? Date.now() - t0;
        item.error = `用例异常: ${e instanceof Error ? e.message : String(e)}`;
        await page
          .screenshot({ path: path.join(OUT_DIR, `${item.id}-exception.png`) })
          .catch(() => {});
        await resetFrontendTracking(page).catch(() => {});
        flushReport();
      }
    }

    report.finished_at = new Date().toISOString();
    flushReport();

    // 收口断言:至少 1 条 done(全灭说明生产链路故障,测试应失败暴露)
    const doneCount = ITEMS.filter((i) => i.status === "done").length;
    expect(
      doneCount,
      `6 条全部未成功:${ITEMS.map((i) => `${i.id}=${i.status}`).join(",")}`,
    ).toBeGreaterThan(0);
  });
});

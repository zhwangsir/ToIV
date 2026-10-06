import { readFile } from "node:fs/promises";
import path from "node:path";

// C6 全平台(2026-10-07)：微信小程序 web-view「业务域名」校验文件承载。
// mp 后台配置业务域名时会要求下载形如 xxxxx.txt 的校验文件并可从站点根访问——
// 部署侧把该文件放进 STUDIO_MP_VERIFY_DIR(默认 /home/merlin/toiv/deploy/mp-verify/)即可，
// 本路由按一级路径直出。仅认 [a-z0-9]+\.txt 形态，防目录穿越与误当静态托管。
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VERIFY_DIR = process.env.STUDIO_MP_VERIFY_DIR || "/home/merlin/toiv/deploy/mp-verify";

export async function GET(_req: Request, ctx: { params: Promise<{ verifyFile: string }> }) {
  const { verifyFile } = await ctx.params;
  if (!/^[a-z0-9]+\.txt$/i.test(verifyFile)) {
    return new Response("not found", { status: 404 });
  }
  try {
    const body = await readFile(path.join(VERIFY_DIR, verifyFile), "utf8");
    return new Response(body, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

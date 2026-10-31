import { readFile } from "node:fs/promises";
import path from "node:path";

// 发版指纹探针(发版防御三件套之一):GET /version.json → { buildId }。
// 客户端轮询本端点,与 bundle 烘焙的 NEXT_PUBLIC_BUILD_ID 比对侦测发版
// (见 lib/releaseWatch.ts、components/ReleaseWatch.tsx)。
//
// 运行时读磁盘上的 .next/BUILD_ID,而非构建期常量:
// deploy.sh 回滚只恢复 web/.next 快照,磁盘 BUILD_ID 永远与当前实际服务的
// bundle 一致,不会出现「bundle 已回滚、指纹却是新版」的持续假提示。
// BUILD_ID 本身由 next.config.mjs generateBuildId 注入为我们的构建指纹。
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

export async function GET() {
  try {
    // toiv-web.service WorkingDirectory=/home/merlin/toiv/web,cwd 即 web 根
    const raw = await readFile(
      path.join(process.cwd(), ".next", "BUILD_ID"),
      "utf8",
    );
    const buildId = raw.trim();
    if (!buildId) throw new Error("BUILD_ID 为空");
    return Response.json({ buildId }, { headers: NO_STORE });
  } catch {
    // 构建产物缺失/不可读:返回 null,客户端按「无法确定」处理,不提示
    return Response.json({ buildId: null }, { status: 503, headers: NO_STORE });
  }
}

// M4-4 Phase C:/studio/entry.json 从 gate 移交 Next——ToIV 首页探测「BeefTV 是否为产品 UI」
// 的开关文件(存在即 enabled)。文件路径 env 可覆写,默认与 gate 同一开关文件。
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { existsSync } from "node:fs";

const ENTRY_FILE = process.env.STUDIO_ENTRY_FILE || "/home/merlin/beeftv-prod/ENTRY_ON";

export async function GET() {
  return Response.json({ enabled: existsSync(ENTRY_FILE) }, { headers: { "cache-control": "no-store" } });
}

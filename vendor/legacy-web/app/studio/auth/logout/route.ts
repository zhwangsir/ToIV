// M4-4 Phase C:/studio/auth/logout 从 gate 移交 Next——清 /studio 路径域的 toiv_session cookie。
// ToIV 主应用登出/401 时以 keepalive 发后即忘调用(见 app/page.tsx)。
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": "toiv_session=; Path=/studio; HttpOnly; SameSite=Strict; Max-Age=0", "cache-control": "no-store" } },
  );
}

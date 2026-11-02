// ToIV P0: mock SuperTale /api/v1 for Freezone shell. No real gen/jobs/SSE.
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
type CanvasDoc = {
  schema_version: 2;
  canvas_id: string;
  project_id: string;
  base_revision: number | null;
  revision: number;
  client_save_id?: string;
  save_source?: string;
  nodes: unknown[];
  edges: unknown[];
  viewport: unknown;
  metadata: Record<string, unknown> | null;
  updated_at: string;
};

const projects = new Map<string, { id: string; name: string; updated_at: string }>();
const canvases = new Map<string, Map<string, CanvasDoc>>(); // projectId -> canvasId -> doc

function ensureProject(id: string, name?: string) {
  if (!projects.has(id)) {
    projects.set(id, {
      id,
      name: name ?? `ToIV Freezone ${id.slice(0, 8)}`,
      updated_at: new Date().toISOString(),
    });
  }
  if (!canvases.has(id)) canvases.set(id, new Map());
  return projects.get(id)!;
}

function ok<T>(data: T, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ ok: true, data, ...extra });
}

function notImpl(msg: string) {
  return JSON.stringify({
    ok: false,
    error: `toiv-mock: ${msg} (BE freezone not wired; gen/jobs/SSE disabled)`,
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

// Seed a demo project so a bare /projects/toiv-demo/freezone lights up.
ensureProject("toiv-demo", "ToIV Freezone Demo");

const SURFACES = [
  { surface_code: "mainline", label: "Mainline", available: true, unavailable_message: "" },
  { surface_code: "freezone", label: "Freezone", available: true, unavailable_message: "" },
  { surface_code: "assistant", label: "Assistant", available: false, unavailable_message: "SuperChat default off until BE" },
  { surface_code: "freezone_assistant", label: "Freezone Assistant", available: false, unavailable_message: "SuperChat default off until BE" },
  { surface_code: "payment", label: "Payment", available: false, unavailable_message: "N/A in ToIV mock" },
];

const IMAGE_MODELS = [
  {
    id: "mock_gpt_image",
    providerId: "openai",
    apiModel: "gpt-image-1",
    label: "Mock GPT Image (fixture)",
    resolutionOptions: ["1024x1024"],
    ratioOptions: ["1:1"],
  },
];

const CAMERA_OPTIONS = {
  camera_bodies: [{ id: "mock-body", label: "Mock Body" }],
  lenses: [{ id: "mock-lens", label: "Mock Lens" }],
  focal_lengths_mm: [24, 35, 50],
  apertures: ["f/1.8", "f/2.8"],
};

export function toivMockApiPlugin(): Plugin {
  return {
    name: "toiv-freezone-mock-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || "";
        if (!rawUrl.startsWith("/api/v1")) return next();

        const url = new URL(rawUrl, "http://toiv.local");
        const path = url.pathname.replace(/^\/api\/v1\/?/, "").replace(/\/$/, "");
        const method = (req.method || "GET").toUpperCase();

        try {
          // --- config / auth ---
          if (method === "GET" && path === "config") {
            return send(
              res,
              200,
              ok({
                edition: "ce",
                auth_required: false,
                instance_id: "toiv-freezone-mock",
                mcp_direct_canvas_apply: false,
              }),
            );
          }
          if (method === "GET" && path === "auth/me") {
            return send(
              res,
              200,
              ok({
                username: "toiv-local",
                role: "owner",
                credit_balance: 0,
                credential_kind: "mock",
                avatar_url: null,
              }),
            );
          }
          if (method === "GET" && path === "auth/ui-config") {
            return send(res, 200, ok({ phone_otp_entry_visible: false }));
          }
          if (method === "POST" && (path === "auth/logout" || path === "auth/login")) {
            return send(res, 200, ok({}));
          }
          if (method === "GET" && path === "product-surfaces/me") {
            return send(res, 200, ok({ items: SURFACES }));
          }

          // --- projects ---
          if (method === "GET" && path === "projects") {
            const list = [...projects.values()].map((p) => ({
              id: p.id,
              name: p.name,
              display_name: p.name,
              updated_at: p.updated_at,
              episode_count: 0,
            }));
            return send(res, 200, ok(list));
          }
          if (method === "GET" && path === "projects/summaries") {
            const list = [...projects.values()].map((p) => ({
              id: p.id,
              name: p.name,
              status: "active",
              owner_username: "toiv-local",
              effective_role: "owner",
              updated_at: p.updated_at,
              episode_count: 0,
              beat_count: 0,
            }));
            return send(res, 200, ok(list));
          }

          const projectMatch = path.match(/^projects\/([^/]+)(?:\/(.*))?$/);
          if (projectMatch) {
            const projectId = decodeURIComponent(projectMatch[1]);
            const rest = projectMatch[2] || "";
            ensureProject(projectId);

            if (method === "GET" && rest === "") {
              const p = projects.get(projectId)!;
              return send(res, 200, ok({ id: p.id, name: p.name, updated_at: p.updated_at }));
            }
            if (method === "GET" && rest === "characters") return send(res, 200, ok([]));
            if (method === "GET" && rest === "scenes") return send(res, 200, ok([]));
            if (method === "GET" && rest === "episodes") return send(res, 200, ok([]));
            if (method === "GET" && rest === "assets") return send(res, 200, ok([]));
            if (rest.startsWith("freezone/assets")) return send(res, 200, ok([]));

            // canvases list
            if (method === "GET" && rest === "freezone/canvases") {
              const items = [...(canvases.get(projectId)?.values() || [])].map((c) => ({
                id: c.canvas_id,
                modified_at: c.updated_at,
                size: JSON.stringify(c).length,
                schema_version: 2,
                canvas_scope: "default",
                revision: c.revision,
                metadata: c.metadata,
              }));
              return send(res, 200, ok(items));
            }

            // single canvas GET/PUT/DELETE
            const canvasMatch = rest.match(/^freezone\/canvases\/([^/]+)$/);
            if (canvasMatch) {
              const canvasId = decodeURIComponent(canvasMatch[1]);
              const bag = canvases.get(projectId)!;
              if (method === "GET") {
                const doc = bag.get(canvasId);
                if (!doc) {
                  // blank default so shell can open a deep link
                  const blank: CanvasDoc = {
                    schema_version: 2,
                    canvas_id: canvasId,
                    project_id: projectId,
                    base_revision: null,
                    revision: 0,
                    nodes: [],
                    edges: [],
                    viewport: null,
                    metadata: { canvas_origin: "mock_blank", display_name: "Untitled" },
                    updated_at: new Date().toISOString(),
                  };
                  bag.set(canvasId, blank);
                  return send(res, 200, ok(blank));
                }
                return send(res, 200, ok(doc));
              }
              if (method === "PUT") {
                const raw = await readBody(req);
                const body = raw ? JSON.parse(raw) : {};
                const prev = bag.get(canvasId);
                const next: CanvasDoc = {
                  schema_version: 2,
                  canvas_id: canvasId,
                  project_id: projectId,
                  base_revision: body.base_revision ?? prev?.revision ?? null,
                  revision: (prev?.revision ?? 0) + 1,
                  client_save_id: body.client_save_id,
                  save_source: body.save_source,
                  nodes: Array.isArray(body.nodes) ? body.nodes : [],
                  edges: Array.isArray(body.edges) ? body.edges : [],
                  viewport: body.viewport ?? null,
                  metadata: body.metadata ?? null,
                  updated_at: new Date().toISOString(),
                };
                bag.set(canvasId, next);
                return send(
                  res,
                  200,
                  ok({
                    saved: true,
                    revision: next.revision,
                    updated_at: next.updated_at,
                    client_save_id: next.client_save_id,
                    backup_status: "disabled",
                  }),
                );
              }
              if (method === "DELETE") {
                bag.delete(canvasId);
                return send(res, 200, ok({ deleted: true }));
              }
            }

            // fixtures
            if (method === "GET" && rest === "freezone/image/models") {
              return send(res, 200, ok(IMAGE_MODELS));
            }
            if (method === "GET" && rest === "freezone/image/camera-options") {
              return send(res, 200, ok(CAMERA_OPTIONS));
            }
            if (method === "GET" && rest === "freezone/image/style-templates") {
              return send(res, 200, ok([]));
            }
            if (method === "GET" && rest === "freezone/video/models") {
              return send(res, 200, ok([]));
            }
            if (method === "GET" && rest === "freezone/video/camera-templates") {
              return send(res, 200, ok([]));
            }
            if (method === "GET" && rest === "freezone/projections:status") {
              return send(res, 200, ok({ canvas_id: url.searchParams.get("canvas_id") || "", projections: [] }));
            }
            if (method === "GET" && /freezone\/canvases\/[^/]+\/history$/.test(rest)) {
              return send(res, 200, ok([]));
            }
            if (method === "GET" && /freezone\/workflow-runs/.test(rest)) {
              return send(res, 200, ok([]));
            }

            // Anything generative / push / jobs — explicit not implemented
            if (
              /freezone\/(gen|edit|redraw|relight|outpaint|upscale|multi-view|scene-360|template-edit|init|upload|video\/|push|jobs|agent-|recipes|skills|audio|text|analyze|extract)/.test(
                rest,
              )
            ) {
              return send(res, 501, notImpl(rest));
            }
          }

          // Soft-default: empty ok for unknown GETs under /api/v1 so shell doesn't spin
          if (method === "GET") {
            console.warn(`[toiv-mock] unhandled GET /api/v1/${path} → empty ok`);
            return send(res, 200, ok([]));
          }
          console.warn(`[toiv-mock] unhandled ${method} /api/v1/${path} → 501`);
          return send(res, 501, notImpl(path || "(root)"));
        } catch (err) {
          console.error("[toiv-mock] error", err);
          return send(res, 500, notImpl(err instanceof Error ? err.message : "mock crash"));
        }
      });
    },
  };
}

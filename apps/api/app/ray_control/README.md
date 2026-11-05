# app.ray_control (tip feature branch)

Narrow JR-R1…R5 merge from scratch. **`TOIV_RAY_CONTROL_ENABLED` defaults false.**

## Invariants

| Knob | Tip default | Notes |
|---|---|---|
| `TOIV_RAY_CONTROL_ENABLED` | **false** | Missing/empty → false |
| `JobRouterConfig.unknown_kind_policy` | **`fail`** | Keep aligned with live config |
| tip_mount | **false** | FE pseudocode only; no live hub |

## unknown_kind_policy · paper

`resolve_adapter(..., unknown_kind_policy="echo")` historical helper default stays documented in JR-R3 parity. **Do not** flip `JobRouterConfig` to echo on this branch — discuss on paper / follow-up card if product wants echo fallback.

## Not in this card

- `git push` / PR
- Wave B / JR-R6 H3 live pool
- `ray start` / production tip hot-cut
- Mounting routes into `app.main` lifespan (stays zero behavior change)

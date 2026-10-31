# NOTICE — Wave2 absorption attribution

This file records third-party sources consulted or copied under their licenses
for ToIV canvas frontend patterns. Local learning / non-commercial.

## MIT (code copy allowed with attribution)

### Toonflow-app
- Upstream: HBAI-Ltd/Toonflow-app
- Commit: 30139c931e80476caa718b31684b86383c6e83ce
- Copied/adapted:
  - `lib/absorb/toonflow/arrange-selection.ts` ← arrangeSelection.ts
  - `lib/absorb/toonflow/floating-agent-geometry.ts` ← floatingAgent.vue geometry
  - Wired: `use-canvas-node-operations` arrange row/column/grid; assistant dock↔float toggle
- Retain: `lib/absorb/toonflow/NOTICE` + this file + `third_party/licenses/toonflow-MIT.txt`

### LumenX
- Upstream: alibaba/lumenx
- Commit: f2a02e23171447c939e7d8e1386b24d17049bbf1
- Copied/adapted:
  - `lib/absorb/lumenx/character-image.ts` ← characterImage.ts helpers
  - `lib/absorb/lumenx/three-view-lock.ts` ← CharacterWorkbench lock rules
  - `components/canvas/canvas-character-reference-modal.tsx` three-panel lock UI
  - `components/canvas/storyboard-shot-card-shell.tsx` ShotCard chrome
  - Dock `scene_asset · 三视图/R2V 锁定` entry
- Retain: `lib/absorb/lumenx/NOTICE`

## Non-copy (pattern / token rewrite only)

- BeefTV@4e832b7 — SAL 1.0 — IA / toolbar rhythm rewritten ✅
- DramaClaw@f14b8e4 — ELv2 — Freezone shell / dual-rail rewritten ✅
- AIMovieStudioV2@eb52643 — AGPL-3.0 — editor Stage/Library/Timeline pane labels (rewrite) ✅ incremental
- CineGen@f823501 — AniKuku ACL — grid picker first/last-frame hint (rewrite) ✅ incremental
- BigBanana@ead7a5c — Community NC — creation phase strip 01–04 (rewrite) ✅

See also: apps/canvas/docs/absorption-ledger.md · docs/WAVE2_ABSORB_LEDGER.md

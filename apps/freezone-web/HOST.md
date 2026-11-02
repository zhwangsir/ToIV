Entry path (1:1 DramaClaw):

- Route marker: `src/routes/_app/projects.$project/freezone.lazy.tsx` (returns null)
- Keep-alive host: `src/features/freezone/FreezoneCanvasHost.tsx`
- Content root: `src/features/freezone/FreezoneCanvasRoot.tsx` → FreezoneShell + canvas + superchat

Prime does not import these; it iframes this app.

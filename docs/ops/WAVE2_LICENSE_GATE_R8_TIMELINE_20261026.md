# 第8轮·license 闸 — 预览时间线 UI 参考仓快判
交 TL + 跨端 · 逆向安全 · 2026-10-26 ~14:40 Asia/Shanghai  
范围：预览时间线拟借鉴 BeefTV / ArcReel / dramaclaw / LumenX / CineGen / Toonflow（及时间线强相关对照）  
规则：AGPL/GPL/NC → **仅本地学习、不商用进仓**；本轮 **不写业务码、不 push**  
三档：**可抄像素**（MIT/Apache，标源+NOTICE）｜**可学模式**（SAL/ELv2/ACL 等，重写实现）｜**禁并码**（AGPL/GPL/NC，学模式亦不进仓复制）

## 一页结论（时间线吸收用）

| 参考仓 | 许可 | 快判 | 时间线相关可吸收什么 | 跨端注意 |
|--------|------|------|----------------------|----------|
| **HBAI-Ltd/Toonflow-app** | MIT | **可抄像素** | 画布侧时间轴/助手同屏节奏、节点边界 | 优先抄源；保留版权头+NOTICE；勿整仓白标 |
| **alibaba/lumenx** | MIT | **可抄像素** | 分镜表+卡片与播放/锁定联动（非纯时间轴，常与预览并排） | 可抄组件；勿照搬通义托管审核 |
| **HBAI-Ltd/Toonflow-web** | Apache-2.0 | **可抄像素·归档** | 旧 Web 时间线若有可抄 | archived，不主用；优先 app |
| **glanderness/BeefTV** | SAL 1.0 + 历史 MIT | **可学模式**（SAL 区禁并） | 预览条/影音检查节奏、任务态与画布同屏 | **禁抄 Part A 像素/源码**；历史 MIT 文件须可证属 Part B 才另议 |
| **dramaclaw/dramaclaw** | ELv2 | **可学模式** | 任务队列长任务面板、画布⇄流水线切换时的预览位 | **禁并码**；禁对外托管同款壳；只重写 |
| **UllrAI/CineGen-ShortDrama** | AniKuku ACL | **可学模式**（无商用例外=禁并） | Shot 网格、首尾帧、Interval 与 scrub 交互 | **禁并码**；只重写 Shot/Keyframe 交互 |
| **ArcReel/ArcReel** | AGPL-3.0 | **禁并码** | 长篇分镜单元审片/可恢复预览链（模式） | **仅本地学习不商用**；实现必须自写 |
| **Heroesjouney/AIMovieStudiov2**（对照） | AGPL-3.0 | **禁并码** | 三栏里 Timeline 布局节奏 | 同上；Comfy 链只学不抄 |
| **shuyu-labs/BigBanana**（对照） | Community NC | **禁并码** | 阶段条与「先资产后镜头」序 | NC：本地可学，禁并码 |

### 执行口令（给跨端）
1. **可直接标源抄像素**：Toonflow-app →（需要时）LumenX 分镜/锁定旁路。  
2. **只重写、不贴源码**：BeefTV 预览条节奏、DramaClaw 长任务/双轨预览位、CineGen 首尾帧 scrub。  
3. **碰都不要进仓复制**：ArcReel、AIMovieStudio Timeline、BigBanana 阶段实现。  
4. 与第1轮 A/B 闸一致：A≈可抄像素；B≈可学模式∪禁并码（进仓一律重写）。

## 红线（不变）
闸仍集中 `apps/canvas/web/src/redline.ts` + `apps/api/app/redline.py`；本轮不改。  
详参：`docs/ops/WAVE2_LICENSE_GATE_R1_20261026.md` · 深挖 Page `9a6e4b46-d3de-4981-bebf-88a9bdd8c5f6`

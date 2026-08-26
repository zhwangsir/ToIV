# ToIV 文档整合方案

> **生成时间**: 2026-08-26
> **目的**: 系统性整合项目文档，保留有价值内容，删除过时信息，确保文档结构清晰、内容连贯、无重复

---

## 一、文档现状盘点

### 1.1 核心文档（必须保留，持续更新）

| 文档 | 路径 | 价值 | 更新频率 | 状态 |
|------|------|------|----------|------|
| **AGENTS.md** | `/AGENTS.md` | 集群操作记忆与决策记录，每次会话必读 | 每次会话 | ✅ 最新（2026-08-26) |
| **STATE.json** | `/STATE.json` | 项目状态快照（结构化状态） | 每次里程碑 | ✅ 最新（2026-08-26) |
| **TEST_LOG.md** | `/TEST_LOG.md` | 测试日志（按时间倒序） | 每次里程碑 | ✅ 最新（2026-08-26) |
| **README.md** | `/README.md` | 项目入口文档 | 低频 | ⚠️ 需更新（指向新技术文档） |

### 1.2 技术文档（新生成，保留）

| 文档 | 路径 | 价值 | 生成时间 | 状态 |
|------|------|------|----------|------|
| **VIDEO_PIPELINE_MODULES.md** | `/docs/VIDEO_PIPELINE_MODULES.md` | 视频创作四模块完整技术文档（架构/接口/测试/部署/排查） | 2026-08-26 | ✅ 新生成 |

### 1.3 历史测试报告（有价值但已过时，建议归档）

| 文档 | 路径 | 价值 | 生成时间 | 建议 |
|------|------|------|----------|------|
| E2E_TEST_REPORT.md | `/apps/web/E2E_TEST_REPORT.md` | 2026-07-27 端到端测试报告（109 用例，UX 评分 80.8) | 2026-07-27 | 📦 归档到 `docs/archive/` |
| QUALITY_ASSESSMENT_REPORT.md | `/apps/web/QUALITY_ASSESSMENT_REPORT.md` | 2026-07-27 质量评估报告（总分 93.7/100) | 2026-07-27 | 📦 归档到 `docs/archive/` |

### 1.4 运维文档（有价值，保留）

| 文档 | 路径 | 价值 | 状态 |
|------|------|------|------|
| Gitee上传方法.md | `/Gitee上传方法.md` | 代码托管统一规范（Gitee 私有仓库） | ✅ 保留 |
| deploy/README.md | `/deploy/README.md` | 部署说明 | ✅ 保留 |
| deploy/lipsync-setup.md | `/deploy/lipsync-setup.md` | 唇形同步服务部署 | ✅ 保留 |

### 1.5 过时文档（建议删除或归档）

| 文档 | 路径 | 问题 | 建议 |
|------|------|------|------|
| 设备说明.md | `/设备说明.md` | 与 AGENTS.md 重复（AGENTS.md 是单一真相源） | 🗑️ 删除（内容已合并到 AGENTS.md) |
| opentalking/设备说明.md | `/opentalking/设备说明.md` | 与 AGENTS.md 重复 | 🗑️ 删除 |

### 1.6 第三方文档（不动）

| 文档 | 路径 | 说明 |
|------|------|------|
| Mobile/docs/* | `/Mobile/docs/` | 移动端开发规范（独立子项目） |
| MiniProgram/docs/* | `/MiniProgram/docs/` | 小程序交付文档（独立子项目） |
| opentalking/docs/* | `/opentalking/docs/` | OpenTalking 第三方库文档（不动） |
| apps/api/app/agent/knowledge/* | `/apps/api/app/agent/knowledge/` | 助手知识库（运行时依赖） |
| apps/api/app/skills/*/SKILL.md | `/apps/api/app/skills/` | 技能定义（运行时依赖） |

---

## 二、整合动作

### 2.1 已完成的整合

✅ **生成 VIDEO_PIPELINE_MODULES.md**（2026-08-26):
- 完整的架构设计说明（模块间关系/数据流图/核心技术栈）
- 完整的接口定义（Request/Response 格式/参数说明/错误码定义）
- 系统测试报告（测试环境/测试用例/测试结果/性能指标）
- 部署说明（环境要求/部署步骤/配置说明）
- 常见问题排查指南（7 个典型问题）

### 2.2 建议执行的整合

#### 动作 1：归档历史测试报告

```bash
mkdir -p docs/archive
mv apps/web/E2E_TEST_REPORT.md docs/archive/E2E_TEST_REPORT_2026-07-27.md
mv apps/web/QUALITY_ASSESSMENT_REPORT.md docs/archive/QUALITY_ASSESSMENT_REPORT_2026-07-27.md
```

**理由**：这些报告是 2026-07-27 的历史快照，当时测试用例 109/171 个，现在已发展到 2248 后端 + 641 前端，报告内容已过时但有历史价值，归档保留。

#### 动作 2：删除重复文档

```bash
rm 设备说明.md
rm opentalking/设备说明.md
```

**理由**:AGENTS.md 是设备信息的单一真相源（2026-08-23 用户拍板），这两份文档内容已完全合并到 AGENTS.md，保留会造成信息不一致。

#### 动作 3：更新 README.md

在 README.md 中添加指向新技术文档的链接：

```markdown
## 技术文档

- [视频创作四模块技术文档](docs/VIDEO_PIPELINE_MODULES.md) - 多镜头/关键帧链/视频编辑/Motion Brush 完整技术文档(2026-08-26)
- [AGENTS.md](AGENTS.md) - 集群操作记忆与决策记录(每次会话必读)
- [STATE.json](STATE.json) - 项目状态快照
- [TEST_LOG.md](TEST_LOG.md) - 测试日志
```

---

## 三、整合后的文档结构

```
ToIV/
├── AGENTS.md                          # 集群操作记忆(每次会话必读)
├── STATE.json                         # 项目状态快照
├── TEST_LOG.md                        # 测试日志
├── README.md                          # 项目入口(已更新,指向技术文档)
├── Gitee上传方法.md                    # 代码托管规范
├── docs/
│   ├── VIDEO_PIPELINE_MODULES.md     # 视频创作四模块技术文档(新生成)
│   └── archive/                       # 历史文档归档
│       ├── E2E_TEST_REPORT_2026-07-27.md
│       └── QUALITY_ASSESSMENT_REPORT_2026-07-27.md
├── deploy/
│   ├── README.md                      # 部署说明
│   └── lipsync-setup.md              # 唇形同步部署
├── Mobile/
│   └── docs/                          # 移动端文档(独立子项目,不动)
├── MiniProgram/
│   └── docs/                          # 小程序文档(独立子项目,不动)
├── opentalking/
│   └── docs/                          # OpenTalking 第三方文档(不动)
└── apps/
    ├── api/app/agent/knowledge/      # 助手知识库(运行时依赖,不动)
    └── api/app/skills/*/SKILL.md     # 技能定义(运行时依赖,不动)
```

---

## 四、文档维护规范

### 4.1 更新频率

| 文档 | 更新频率 | 责任人 |
|------|----------|--------|
| AGENTS.md | 每次会话 | 设备管家（AI Assistant) |
| STATE.json | 每次里程碑 | 开发团队 |
| TEST_LOG.md | 每次里程碑 | 开发团队 |
| VIDEO_PIPELINE_MODULES.md | 每次功能变更 | 开发团队 |
| README.md | 低频（重大变更） | 开发团队 |

### 4.2 文档质量要求

1. **准确性**: 技术描述准确无误，术语使用规范
2. **时效性**: 文档与代码保持同步，过期内容及时删除或归档
3. **完整性**: 覆盖架构/接口/测试/部署/排查全链路
4. **可读性**: 兼顾开发人员和运维人员的阅读需求
5. **一致性**: 遵循统一的 Markdown 格式和文档结构

### 4.3 文档审查流程

- **每次里程碑**: 更新 STATE.json 和 TEST_LOG.md
- **每次功能变更**: 更新相关技术文档（如 VIDEO_PIPELINE_MODULES.md)
- **每月审查**: 检查文档时效性，删除过时内容，归档历史文档
- **每季度审查**: 全面审查文档结构，优化文档组织

---

## 五、整合收益

### 5.1 结构清晰

- 核心文档（AGENTS.md/STATE.json/TEST_LOG.md）与技术文档（VIDEO_PIPELINE_MODULES.md）分离
- 历史文档归档到 `docs/archive/`，不占用主目录空间
- 重复文档删除，避免信息不一致

### 5.2 内容连贯

- VIDEO_PIPELINE_MODULES.md 提供完整的四模块技术文档，覆盖架构/接口/测试/部署/排查
- AGENTS.md 提供集群操作记忆与决策记录
- TEST_LOG.md 提供按时间倒序的测试日志
- 三者形成完整的文档体系

### 5.3 无重复信息

- 设备信息统一在 AGENTS.md（单一真相源）
- 技术文档统一在 VIDEO_PIPELINE_MODULES.md（四模块）
- 测试报告统一在 TEST_LOG.md（最新）和 docs/archive/（历史）

---

**整合完成时间**: 2026-08-26
**整合执行人**: 设备管家（AI Assistant)
**下次审查时间**: 2026-09-26

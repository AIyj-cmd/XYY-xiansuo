# 项目文档索引

当前状态：**阶段一“安全与数据库基线”与阶段二“业务一致性基线”均已代码验收通过，尚未生产部署；生产发布、真实环境核验和备份恢复演练门禁仍有效。** 阶段二 Git 基线冻结报告将存放在 `04-验收交付/PHASE_2_BASELINE_FREEZE_REPORT.md`。通知、普通微信、企业微信、DeepSeek/AI、拜访、日报和周报等后续能力尚未实现，须按已批准设计另行确认和实施。

## 事实优先级

1. 生产状态以实际运行的发布制品、环境变量、数据库路径和运行记录为准。
2. 代码当前行为及[验收报告](04-验收交付/ACCEPTANCE_REPORT.md)、[测试报告](03-测试验证/TEST_REPORT.md)优先于历史审计快照。
3. 审计与设计文档定义已确认的设计边界和后续实现方案，不等同于已上线功能。
4. [系统分析](01-审计与设计/SYSTEM_ANALYSIS.md)中的“当前事实”是 2026-07-30 实施前审计快照，不能覆盖当前代码、测试和验收结论。

## 目录结构

```text
docs/
├── README.md
├── 00-项目说明/
│   ├── README.md
│   └── CLAUDE.md
├── 01-审计与设计/
│   ├── SYSTEM_ANALYSIS.md
│   ├── TECH_DESIGN.md
│   ├── DATABASE_CHANGE_PLAN.md
│   ├── API_CHANGE_PLAN.md
│   └── DEVELOPMENT_PLAN.md
├── 02-开发实现/
│   ├── BASELINE_IMPLEMENTATION_REPORT.md
│   ├── PHASE_2_BUSINESS_CONSISTENCY_IMPLEMENTATION.md
│   └── CHANGELOG.md
├── 03-测试验证/
│   ├── TEST_REPORT.md
│   └── PHASE_2_TEST_REPORT.md
├── 04-验收交付/
│   ├── ACCEPTANCE_REPORT.md
│   ├── DEPLOYMENT_NOTES.md
│   ├── ROLLBACK_PLAN.md
│   ├── PHASE_2_ACCEPTANCE_REPORT.md
│   ├── PHASE_2_DEPLOYMENT_NOTES.md
│   ├── PHASE_2_ROLLBACK_PLAN.md
│   └── PHASE_2_BASELINE_FREEZE_REPORT.md（冻结阶段生成）
└── 99-其他/
    └── goal-part1.md
```

未来新增的需求审计、技术设计和影响分析文档也统一归入 `01-审计与设计/`；上图只列出当前已存在的文件。

## 文档用途

| 分组 | 文档 | 用途 |
| --- | --- | --- |
| 项目说明 | [README.md](00-项目说明/README.md) | 项目定位、开发启动、构建、环境变量及基础部署说明。 |
| 项目说明 | [CLAUDE.md](00-项目说明/CLAUDE.md) | 项目协作与开发辅助上下文。 |
| 审计与设计 | [SYSTEM_ANALYSIS.md](01-审计与设计/SYSTEM_ANALYSIS.md) | 实施前系统审计快照、事实分层与后续业务边界。 |
| 审计与设计 | [TECH_DESIGN.md](01-审计与设计/TECH_DESIGN.md) | 通知、微信和 AI 的整体技术设计与安全边界。 |
| 审计与设计 | [DATABASE_CHANGE_PLAN.md](01-审计与设计/DATABASE_CHANGE_PLAN.md) | 迁移、数据模型、兼容和回滚设计。 |
| 审计与设计 | [API_CHANGE_PLAN.md](01-审计与设计/API_CHANGE_PLAN.md) | API 契约、权限与调用方兼容设计。 |
| 审计与设计 | [DEVELOPMENT_PLAN.md](01-审计与设计/DEVELOPMENT_PLAN.md) | 后续实施阶段、依赖关系和退出条件。 |
| 开发实现 | [BASELINE_IMPLEMENTATION_REPORT.md](02-开发实现/BASELINE_IMPLEMENTATION_REPORT.md) | 阶段一安全与数据库基线的实施范围、迁移 `001`/`002` 和验证证据。 |
| 开发实现 | [PHASE_2_BUSINESS_CONSISTENCY_IMPLEMENTATION.md](02-开发实现/PHASE_2_BUSINESS_CONSISTENCY_IMPLEMENTATION.md) | 阶段二负责人授权、转移审计、跟进派生时间与迁移 `003` 的实施记录。 |
| 开发实现 | [CHANGELOG.md](02-开发实现/CHANGELOG.md) | 阶段一、阶段二已实现变更与明确未包含范围。 |
| 测试验证 | [TEST_REPORT.md](03-测试验证/TEST_REPORT.md) | 独立测试、历史发现的修复复测与 28/28 结果。 |
| 测试验证 | [PHASE_2_TEST_REPORT.md](03-测试验证/PHASE_2_TEST_REPORT.md) | 阶段二独立测试、阻断发现与后续复测记录。 |
| 验收交付 | [ACCEPTANCE_REPORT.md](04-验收交付/ACCEPTANCE_REPORT.md) | 阶段一验收结论、残余风险和上线建议。 |
| 验收交付 | [DEPLOYMENT_NOTES.md](04-验收交付/DEPLOYMENT_NOTES.md) | 生产上线门禁、部署步骤、验证与监控要求。 |
| 验收交付 | [ROLLBACK_PLAN.md](04-验收交付/ROLLBACK_PLAN.md) | 迁移、应用和配置的回滚准备、触发条件及验证步骤。 |
| 验收交付 | [PHASE_2_ACCEPTANCE_REPORT.md](04-验收交付/PHASE_2_ACCEPTANCE_REPORT.md) | 阶段二验收结论、最小验收修复与残余风险。 |
| 验收交付 | [PHASE_2_DEPLOYMENT_NOTES.md](04-验收交付/PHASE_2_DEPLOYMENT_NOTES.md) | 阶段二上线前副本迁移、验证及监控要求。 |
| 验收交付 | [PHASE_2_ROLLBACK_PLAN.md](04-验收交付/PHASE_2_ROLLBACK_PLAN.md) | 阶段二迁移、应用与数据异常的回滚准备。 |
| 验收交付 | `PHASE_2_BASELINE_FREEZE_REPORT.md`（冻结阶段生成） | 记录冻结分支、提交 SHA、剩余差异和后续开发起点。 |
| 其他 | [goal-part1.md](99-其他/goal-part1.md) | 阶段一原始目标与过程记录。 |

根目录的 [AGENTS.md](../AGENTS.md) 是整个仓库的代理与工程工作流约束，保留在根目录以便自动发现。

# 项目约束（必读）

- 需求唯一来源：PRD.md，按其第 10 节顺序执行，不跳步。
- 技术栈不可更换：uni-app（Vue3+TS）/ Fastify / node:sqlite / Zod v4 / wot-design-uni。
- 界面文字全部简体中文。
- 所有前端请求走 app/src/utils/request.ts，禁止 fetch/axios。
- 不引入 PRD 未提及的第三方库，确需引入先说明理由等确认。
- 每完成一个任务：本地跑通、简述改动与验证方式，再进入下一任务。

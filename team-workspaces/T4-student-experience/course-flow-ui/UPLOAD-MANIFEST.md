# 上传清单

任务：T4 / course-flow-ui
目标目录：`team-workspaces/T4-student-experience/course-flow-ui/`

## 纳入

- 静态网页 `dist/`
- 虚构演示快照 `dist/data.json`
- 网页测试 `tests.mjs`
- 功能说明和协作说明

## 排除

- 原始 `school-workflow/state/`、`inbox/`、`extractions/` 和输出台账：可能包含学校通知或个人任务资料。
- `sites/campus-flow/.openai/hosting.json`：部署项目元数据，不属于协作代码。
- `sites/campus-flow/qa/`：本机 QA 原件和截图未纳入本次最小代码贡献。
- Python 缓存、临时文件、真实数据、凭据、Token、Cookie、密码、私钥和 `.env`。

## 验收边界

本次只证明本目录网页测试通过。协作区 PR 合并不表示产品集成、正式 QA、Android 真机验收或发布。

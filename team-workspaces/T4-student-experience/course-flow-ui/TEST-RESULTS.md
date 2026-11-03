# 测试记录

执行目录：`team-workspaces/T4-student-experience/course-flow-ui/`

- `node tests.mjs`：通过；网页引擎、流程、时间表、任务状态、删除/恢复、PDF/PPTX 边界测试通过。
- `node --check dist/app.mjs`：通过。
- `node --check dist/engine.mjs`：通过。
- `node --check dist/pdf-reader.mjs`：通过。
- `node --check dist/pptx-reader.mjs`：通过。
- `git diff --check`：上传前执行。

未覆盖：真实来源采集、真实模型、OCR、Android APK、手机安装、生产后台和正式 QA。

# 课序网页测试版（T4 协作贡献）

这是课序项目的浏览器端静态测试界面，作为 T4 学生端体验贡献上传到协作区。

## 内容

- `dist/`：静态网页、流程引擎、PDF/PPTX 读取器、样式和本地 vendor 资源。
- `tests.mjs`：网页流程、时间表、任务状态、回收站、PDF/PPTX 安全边界测试。
- `README.md`：原项目功能和本地预览说明。
- `UPLOAD-MANIFEST.md`：本次上传范围、排除项和安全说明。

## 本地验证

在本目录执行：

```powershell
node tests.mjs
node --check dist/app.mjs
node --check dist/engine.mjs
node --check dist/pdf-reader.mjs
node --check dist/pptx-reader.mjs
```

## 数据边界

`dist/data.json` 只保留虚构演示项目和流程目录。本地工作区中的原始通知、学校名称、课程资料、个人字段、Python 台账、部署元数据和 QA 原件没有上传。该贡献不代表真实学校身份、真实学生资料、生产数据库、正式后台或真机验收。

## 依赖说明

课序网页的原始 `export_data.py` 依赖外部 `school-workflow` 台账；该台账不属于本次 T4 上传范围。需要接入真实或本地工作流数据时，应另行登记依赖和 owner，不要把原始台账复制到本目录。

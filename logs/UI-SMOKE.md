# 现行本机演示页面冒烟检查

2026-10-23，使用隔离 Chrome headless profile、1280×800 浏览 `http://127.0.0.1:18766/`，每次从新 profile 开始。页面使用虚拟演示账号 A；不接触真实身份或数据。

1. 点击“以虚拟学生甲 · A 进入”，首页显示账号 A、4 项待处理事务。截图 [`web-demo-login-before-after-click.png`](web-demo-login-before-after-click.png)，SHA256 `8c18fd7ac0abf2381bdb978c604106954f58d8d8989b19fd072b87d03e135810`。
2. 点击“查看待办”，列表标题显示“已加载 4 项、显示 4 项”及筛选项；截图内前两张卡片完整可见，第三张仅上部可见，第四张在屏幕下方。截图 [`web-demo-tasks-before-after-2-clicks.png`](web-demo-tasks-before-after-2-clicks.png)，SHA256 `dac41ebd01a0e0e0ca84ed1c320b3682b7ef585227932854bc9c3e2aa9d87fb4`。
3. 点击首项，任务详情显示要求与阅读、确认、提交状态。截图 [`web-demo-detail-before-after-3-clicks.png`](web-demo-detail-before-after-3-clicks.png)，SHA256 `b1a740fd3f60b99eff38111f54211aa38f57b4400311849ca4efc80893d645ad`。

这三张图的中文均完整。该检查仅覆盖入口、待办列表和首项详情；附件、草稿、正式提交、离线冷启动及手机尚未做浏览器操作验收。虚拟数据接口的独立 HTTP 主线与重启保持证据见原交互端 `RESULT.json`。

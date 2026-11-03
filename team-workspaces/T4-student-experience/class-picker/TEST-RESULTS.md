# 选人测试记录

执行目录：`team-workspaces/T4-student-experience/class-picker/`

- `node --test test/*.test.mjs`：普通沙箱中 40 项测试通过 39 项；HTTP 测试因沙箱禁止绑定临时回环端口而报告 `EACCES 127.0.0.1`。
- `node --test test/store-http.test.mjs`：在受控本机测试权限下 7/7 通过，覆盖 HTTP 认证、Cookie、CSP、来源检查、冲突和路径穿越。
- 其余单元、核心、名单、规则和 Harness 客户端测试：39/39 通过。
- `node scripts/pack.mjs`：通过，生成 21 文件的本地插件包；压缩包及校验文件按规则排除，不提交。

未覆盖：运行中的 Harness 安装验收、真实学校身份、真实学生资料、生产后台和发布。

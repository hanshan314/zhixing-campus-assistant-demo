# 本机演示网页加载过程中的中文方框（已复核）

- 复现：用独立 Chrome headless profile 打开 `http://127.0.0.1:18766/`，窗口 1280×800，等待 12 秒截图。
- 截图：`web-local-headless.png`，SHA256 `2201881c4dcf6641614fca72a6034463d74c87581963fab75488b12b93a4116c`。
- 首次快速截图：源码的“校园的事，/从容一点。”出现多个方框；“选择一个演示身份”也缺“一”等字。
- 更正复测：用隔离 Chrome CDP 按真实时间等待 15 秒、同样 1280×800 条件，旧 `web-current-local` 与新 `web-current-cjk` 的最终画面中文均完整。旧版截图 `web-local-realwait.png`（SHA256 `f047d14d9d511c13c01cf5b26bf2a1e40d7a9f4fa4cc203e2fca0a70b6840066`）；新候选截图 `web-cjk-candidate-realwait.png`（SHA256 `43f42d50327aa52d9ce103710bd0e743ee0f7862b4c0dc5cd29065c90f10229c`）。因此首次截图只证明加载中短暂出现方框，不能证明旧版稳定画面缺字。
- 5 秒复核更正：旧版的 5 秒、重复 5 秒与 15 秒截图三个文件字节及 SHA256 完全相同；新候选版也如此。一次图片预览显示为空白是预览异常，不能据此声称新包加载更快。
- 范围：真实浏览器的首页最终渲染；文件 HTTP200 与哈希匹配本身不构成 UI 验收，后续点击流程仍未验证。
- 只读定位：当前 Flutter `FontManifest.json` 仅有 MaterialIcons 与 Roboto；当前 `pubspec.yaml` 未声明中文字体，`style.dart` 未指定中文主字体。历史发布包包含项目内 NotoSansCJKsc-Regular.otf 与 `CampusChinese` 配置。
- 状态：原交互端 owner 已在新有界卡恢复项目内中文字体，新候选包隔离构建并通过独立静态复核。今天仍使用 `web-current-local`，未切换现行服务；原交互端源码已受控恢复，候选包作为备查保留。新字体提高本地资源确定性，但额外增加约 16.44 MB，不能仅凭截图推断完全离线可用或加载更快。

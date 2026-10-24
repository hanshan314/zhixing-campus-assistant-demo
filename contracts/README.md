# 学生端统一契约消费者快照

本目录消费全项目统一契约，**不维护第二套 OpenAPI 生成源**。App、Mock、客户端请求和接口类型均以 `upstream/openapi.json` 的 HTTP 字段、状态、响应和错误为准。上一轮技术文档中的本稿建议不是已冻结 wire 契约；差异见 [接口适配与未覆盖项](../docs/接口适配与未覆盖项_v0.1.md)。

当前：OpenAPI **3.1.0**；业务契约 **0.2.0**；样例 **0.2.0 / demo**。上游定义 61 个操作、145 个命名 schema；这不表示业务服务已经实现或 P0 验收通过。2026-10-16 迁移差异见 [ST-01 审查](../docs/coordination/ST-01-contract-diff.md)。

2026-10-16 IF-003 修复采用 `lock_format=2` 的四文件快照，增加上游 `runtime-validator.mjs`。OpenAPI 与 examples 未变；当前四份源/目标 SHA-256 见 `source.lock.json`。下方 revision18 三文件记录保留为历史；当前采用记录见 `../../修复记录/2026-10-16-interface-fixes/contract-adoption.json`。

2026-10-22 ST-01 限定增量采纳：按原任务累计第 3 次、同一原写入者，将权威源 OpenAPI `56f6576725d0cb526c8118a95c12a1662cea90f8b107fc4912939ac315416ebf` 逐字节同步到消费者，另三份快照字节未变，四文件锁已更新。仅 `POST /v1/sources` 的 `x-protocol.state_rule` 和 `SourceCreate.description` 两处文字变化，明确已保存文件来源的显式 `private/class` 范围、本人 `source` 用途 UTF-8 文本/CSV、完整原件字节对应、班级文本副本不扩展原文件下载权限、文件端口未启用时 503，以及自报 `captured_at` 与可信 `received_at` 的区别；路径、字段、必填性和版本号未变。学生端没有因此开放新的来源创建能力，也不代表真实文件服务或 P0 已联调。此次核收以本目录新锁、前后指纹及独立复核为准；历史 IF-003 采用记录保留原状。

## revision18 消费者维护（待 QA 定向复核）

2026-10-16T13:57:46.451364Z 从下述同一源目录刷新三文件，版本仍为 0.2.0，OpenAPI 字节未变。按 `case.name` 比较：旧 195 个样例全部保留且未改，新增 32 个（10 valid、22 invalid），合计 227 个；身份更正字段由可信原 fact 解析，不能给请求注入 `field`。另补强私人来源隔离、缺失要求、来源与身份核验、版本绑定及指定拒绝原因。完整原始 validator 差异及审查中源再次变化的诊断见 [revision18 差异审查](../docs/coordination/evidence/revision-18-integration-contract-delta.md)。

| 源文件（目录 `C:/Users/huang/Documents/ChatGPT/AI比赛相关/contracts/`） | 采用 SHA-256 |
| --- | --- |
| openapi.json | `c63d1fabaae5ed10d59c7122e59c193735d87e487b3aeded97f81d54c3559792` |
| examples.json | `ce8419137008d52819c8028c1c40e707f92a3ef3d034d7ba3ef2a1b3a077b1d8` |
| validate.mjs | `4b4a8a64e22bd0bb4aaa1cac9ce46c9732bc6e6d2ddd31d71ff2cf3cb92fef5a` |

复制前后源/目标/锁逐项一致，三个快照已恢复只读。未采用 QA 初次记录后又被上游修订的中间样例/validator。本角色未运行测试、服务或模型；快照与锁现已冻结，等待 QA 默认契约检查及相关 HTTP 复核。本次维护不开放新学生入口，不改变业务授权或证明真实联调完成。

## 文件职责

| 文件 | 用途 |
| --- | --- |
| `upstream/openapi.json` | 上游逐字节复制的 HTTP 契约；Windows 文件属性设置为只读 |
| `upstream/examples.json` | 上游同版虚拟场景与协议样例；独立快照，不是已执行的请求链 |
| `upstream/validate.mjs` | 原样复制的上游校验入口；仅直接 CLI 执行固定样例验收 |
| `upstream/runtime-validator.mjs` | 原样复制的通用结构、对象内部一致性及显式动态绑定校验库，无样例依赖 |
| `source.lock.json` | 每个快照文件的上游绝对路径、SHA-256、版本和复制时间 |
| `integrity.mjs` | 只读核验本地及上游指纹，不自动刷新或更新锁 |
| `integrity.test.mjs` | 隔离副本验证快照漂移、上游漂移和上游缺失均正确失败 |
| `runtime-validation.mjs` | 给本地 Mock/测试复用的端点请求、响应和 schema 校验封装 |
| `runtime-validation.test.mjs` | 覆盖采用版全部成功请求形状及关键不兼容请求的拒绝 |
| `../scripts/contract-check.mjs` | 统一执行指纹、原样上游校验器和本地适配检查 |

上游位置：`C:/Users/huang/Documents/ChatGPT/AI比赛相关/contracts/`。权威可编辑源是该目录的 `build.mjs`；本任务未修改上游。只读属性用于防止误改，内容一致性仍以 SHA-256 检查为准。

## 验证命令

在 `E:/ai比赛/交互端` 执行：

```powershell
node scripts/contract-check.mjs
```

默认同时检查本地四份快照与上游源文件，任意指纹变化、缺文件、版本不符、坏引用或样例不符均非零退出；检查前后再次核验，检查器不会改写快照或锁。负向测试只在本目录的独立临时副本中制造变化并清理，不改真实源文件。无需第三方 Node 包。

其他机器确实没有上游资料目录时，可以明确选择：

```powershell
node scripts/contract-check.mjs --snapshot-only
```

此模式仍检查锁、本地三个文件、schema 与正反样例，但明确输出“上游新鲜度未验证”；不能把该结果记作当前机器已核对上游。禁止在默认核验失败时自动回退该模式。

## Mock 和测试复用

```js
import {
  spec, fixtures, getOperation,
  validateSchema, validateRequest, validateResponse,
} from '../contracts/runtime-validation.mjs';

const requestErrors = validateRequest('submitMaterials', {
  pathParameters: { task_id: 'task_demo_001' },
  headers: { 'Idempotency-Key': 'op_demo_submit_001' },
  body: {
    draft_id: 'draft_demo_001',
    draft_version: 2,
    requirement_version: 1,
    expected_effective_submission_id: null,
  },
});
const dataErrors = validateSchema('SubmissionRequest', {
  draft_id: 'draft_demo_001', draft_version: 2,
  requirement_version: 1, expected_effective_submission_id: null,
});
// responseBody 必须是 { data, meta }，而不是只传 data。
// validateResponse('submitMaterials', 201, responseBody) -> string[]
// getOperation('submitMaterials') -> { path, method, operation }
```

- 三个 `validate*` 方法返回 `string[]`；空数组仅表示结构符合契约。`getOperation` 对未知 operationId 抛错，两个端点校验函数对未知 operationId 返回错误数组。
- `validateRequest` 参数支持 `pathParameters`（兼容样例 `path_parameters`）、`query`、`headers`、可选 `body` 和 `mediaType`。参数名不改写；HTTP query 中的整数字符串会按声明类型解析。未声明的 query/path/业务请求头拒绝；常见 HTTP 传输头不参与业务 schema 校验。
- multipart body 为已解析字段的检查视图；`file` 的 schema 占位符不证明实际文件字节、格式、长度、哈希或权限正确。文件处理器仍须独立校验真正的数据流。
- `validateResponse(operationId, status, body, mediaType='application/json')` 验证响应状态及完整信封。文件内容需明确传 `application/octet-stream`；该 helper 不验证真实二进制完整性。
- `spec` 和 `fixtures` 深冻结。Mock 的可变业务状态必须通过 `structuredClone` 从虚拟样例复制，不能修改契约或原样例。
- 首次导入先验证本地锁，然后使用上游 `createValidator(spec)`，不执行固定样例验收、不修改进程退出码。完整样例仍由统一检查命令显式执行。
- 动态运行时 helper 验证结构和对象内部一致性；授权、幂等、事务、版本竞争仍由服务负责。额外导出 `validateReportBinding(report, snapshot)` 与 `validateArtifactBinding(artifact, report)`，要求调用方传入获授权的真实关联记录；缺少记录或绑定不一致均拒绝。普通 schema 校验不证明跨对象关系成立。

## 刷新规则

刷新不能只把新文件复制过来或改锁消除失败。每次需：

1. 比较上游 `build.mjs` 生成物、版本、错误、状态和样例差异，明确影响哪些客户端、Mock 与测试；更新本项目差异文档。
2. 在上游负责人的既定范围内完成必要契约修改和上游验证；本目录不反向修改上游，也不擅自增添已缺失的端点。
3. 将同一上游版本的 `openapi.json`、`examples.json`、`validate.mjs`、`runtime-validator.mjs` 整组替换，重新计算每份源文件和目标文件的 SHA-256 并核对一致，更新 `source.lock.json`；恢复四个目标文件的只读属性。
4. 更新受影响的调用方和验收样例，运行默认 `node scripts/contract-check.mjs` 及相关业务验证，再记录本次采用的契约版本与差异。

上游缺口保留为未开放能力。当前消费者快照和本地 demo 骨架不能标记真实身份、上传服务、模型连接、事务持久化、APK 或 AC-01～AC-21 已通过。

# TC Prompt Workflow Validation Adapter v0.7 Candidate 2

```text
adapter_revision: TC-PROMPT-WF-VAL-ADAPTER-v0.7-candidate.2
predecessor_revision: TC-PROMPT-WF-VAL-ADAPTER-v0.7-candidate.1
predecessor_file_sha256: 7049e9812f7af1a2528ab437e6c50f4c643b40b7100130db3d1e243c50f4472c
core_prompt_revision: TC-SESSION-PROMPT-v2.6-candidate.2
document_roles: [PRD, ADR, SYSTEM_DESIGN, API_CONTRACT, ACCEPTANCE_CRITERIA]
integrated_frozen_document: true
changes_existing_persisted_data: false
migration_contract_required: false
publication_status: CANDIDATE_BYTES_AWAITING_USER_APPROVAL
experiment_status: NOT_LAUNCHED
```

本 Adapter 是 Durable Lease Queue latency-bounded clean-room 实验的 **integrated frozen implementation document**。发布后，它同时承载 PRD、ADR、System Design、CLI/API Contract 和 Acceptance Criteria。新实验不需要为这些角色再生成五份物理文件，也不需要独立 inventory、复杂 manifest 或外部专用 validator。

本 Adapter 不授权读取或复用旧实验的实现、测试、migration 或 Git history。允许只读引用持久化的 v2.5.1/v0.6.1 workflow snapshot 作为 predecessor 与对照证据，但不得把旧产品实现作为新实现输入。

---

## 1. 实验目标

验证以下降耗流程能否在 clean-room 中保持独立审查质量，同时避免每个 code remediation 都重启完整双审查：

```text
Integrated Frozen Bundle
→ Lightweight Machine Gate
→ Developer
→ automated verification
→ one Full Discovery Review: Reviewer A + Blind Challenger
→ one persistent Adjudicator
→ batched Developer remediation when required
→ Reviewer A closure
→ one Final Fresh Challenger after remediation
→ Final Adjudication
→ accepted CODE_DEFECT findings return to the Developer remediation loop
→ Human Final Confirmation
```

不得创建 Architecture Reviewer、Architecture Challenger、Design Adjudicator、Freeze Builder、Machine Decision、Exit Auditor 或 Hidden Holdout。每个 Bundle cycle 的 Full Discovery Review pair 只能出现一次；Final Fresh Challenger identity 只能出现一次。

---

## 2. PRD

构建一个 Python 标准库程序：

```text
Durable Lease Queue
```

它是 SQLite + CLI 的本地持久化任务队列，支持：

- `enqueue`：使用 idempotency key 创建任务；
- `claim`：worker 以 lease token 和 expiry 领取任务；
- `ack`：当前有效 lease holder 完成任务；
- `fail`：有效失败增加 attempt，达到上限进入 dead letter；
- `cancel`：取消 pending；running 进入 cancellation requested；
- `reconcile`：处理过期 lease；
- `status`：读取稳定 JSON 状态；
- append-only event log；
- 并发 worker 不得同时成功领取同一任务。

只允许 Python 标准库与环境已存在的测试工具；禁止网络、外部服务和 Financial Agent 代码。

### DLQ-I1 Idempotent Enqueue

相同 idempotency key + 相同 canonical payload 返回同一 task ID；相同 key + 不同 payload 冲突且不得覆盖。

### DLQ-I2 Exclusive Lease

同一 task 同时最多一个有效 lease；并发 claim 最多一个成功。

### DLQ-I3 Lease Authority

`ack` 与 `fail` 只接受当前有效、未过期且与 task 绑定的 lease token。错误、缺失、跨 task、stale 或过期 token 必须 fail closed。

### DLQ-I4 Retry / Dead Letter

`max_attempts = 3`。第一次和第二次有效普通 `fail` 使 task 可重试；第三次进入 `dead_letter`，之后不可 claim。

### DLQ-I5 Cancellation

pending 直接进入 `cancelled`。running 进入 `cancellation_requested`，不得被新 worker claim。

当前 lease holder 在 `cancellation_requested` 下执行有效 `fail`：

- attempt + 1；
- 未到第三次：`cancelled`；
- 第三次：`dead_letter`。

当前有效 lease holder 仍可 `ack → completed`。一个 cancellation request 只能产生一个 terminal resolution。

### DLQ-I6 Reconciliation

普通 running task 的过期 lease 可以 reconcile 回到 pending；重复 reconcile 幂等；terminal task 不得复活。

`cancellation_requested` 的 lease 过期时：

- reconcile 后进入 `cancelled`；
- attempt 不变；
- 追加唯一 `cancellation_reconciled` event。

### DLQ-I7 Auditability

每次成功状态迁移必须在同一 transaction 追加唯一 event。失败命令不得追加伪成功 event；task state 与 event lineage 可核对。

### DLQ-I8 CLI Contract

所有命令输出稳定 JSON 和明确 exit code；数据库路径必须显式传入，测试不得读取用户真实数据库。

---

## 3. ADR

冻结以下架构决定：

1. 使用 Python 标准库 `sqlite3` 作为唯一持久化 authority；不引入 ORM、网络服务或外部队列。
2. 每个状态迁移使用一个 SQLite write transaction；task state mutation 与 event append 原子提交或共同回滚。
3. claim 使用数据库原子条件更新或等价事务序列化，不能依赖进程内锁作为唯一保护。
4. lease token 是不透明 capability，必须与 task 及当前 lease 绑定；status/event 输出不得泄露完整 token。
5. 所有时间比较在同一次操作中使用一个明确的 `now` 值；测试必须能够控制时间。
6. CLI 是唯一公共接口；输入与输出为 versioned JSON，错误也返回 JSON 和非零 exit code。
7. terminal states 为 `completed`、`cancelled`、`dead_letter`，没有出向生命周期迁移。
8. 本实验从空数据库创建 schema，不迁移任何既有用户数据；因此 `changes_existing_persisted_data = false`，不需要 Migration Contract。

---

## 4. System Design

### 4.1 状态

```text
pending
running
cancellation_requested
completed
cancelled
dead_letter
```

### 4.2 持久化模型

至少持久化：

- task identity；
- idempotency key 与 canonical payload；
- state；
- attempt 与 max attempts；
- current lease token digest / version / expiry；
- created / updated timestamps；
- append-only event identity、task identity、event type、event payload 与发生时间。

具体模块和文件划分由 Developer 决定，只要全部位于 Bundle 的 allowed scope。不得在 Freeze 前预测或枚举源码文件清单。

### 4.3 事务规则

- enqueue 的 key/payload 比较与 task 创建在一个 transaction 中；
- claim 的 eligible check 与 lease 写入原子化；
- ack/fail 验证 lease authority 后才能迁移；
- cancel/reconcile 与 holder terminal resolution 按 SQLite transaction 顺序线性化；
- 成功 state change 与对应 event 同 transaction；
- 失败、race loser 和 stale authority 不得写 success event。

### 4.4 Repository baseline

R7 latency-bounded experiment 从新的空 projectless 目录开始。允许 Developer 初始化新的 Git repository，但不得导入 R1–R6 Git history、源码、测试或 migration。

---

## 5. CLI / API Contract

调用形式可以是等价的 Python module CLI，但必须稳定支持：

```text
enqueue --db <path> --idempotency-key <key> --payload <json>
claim --db <path> --worker <id> --lease-seconds <n>
ack --db <path> --task-id <id> --lease-token <token>
fail --db <path> --task-id <id> --lease-token <token> [--reason <text>]
cancel --db <path> --task-id <id>
reconcile --db <path>
status --db <path> --task-id <id>
```

成功输出至少包含：

```json
{"ok": true, "command": "<name>", "result": {}}
```

失败输出至少包含：

```json
{"ok": false, "command": "<name>", "error": {"code": "<stable_code>", "message": "<text>"}}
```

Exit code：

- `0`：成功；
- `2`：输入/CLI contract 错误；
- `3`：业务冲突或 authority 拒绝；
- `4`：not found；
- `5`：storage/internal failure。

精确字段可以扩展，但同一版本必须稳定，且不得输出完整 lease token 到 status 或 event log。

---

## 6. Acceptance Criteria

发布候选至少通过：

1. 相同 key + 相同 payload 幂等，相同 key + 不同 payload 冲突；
2. 两个并发 claim 最多一个成功；
3. missing/wrong/stale/expired/cross-task token 不能 ack 或 fail；
4. 第三次有效普通 fail 进入 dead letter；
5. pending cancel、running cancellation request、holder ack/fail 规则正确；
6. cancellation-requested expiry reconcile 为 cancelled、attempt 不变且 event 唯一；
7. 普通过期 lease 可 reconcile 一次，terminal task 不复活；
8. rejected transition 不追加 success event；
9. transaction rollback 不留下 state/event 半提交；
10. SQLite 关闭重开后状态和 event 保持；
11. CLI success/error JSON 与 exit code 符合合同；
12. 测试全部使用临时数据库路径；
13. malformed CLI arguments 必须输出稳定 JSON error envelope、exit 2 且 stderr 为空；
14. payload 任意嵌套层级的 `NaN`、`Infinity`、`-Infinity` 必须作为 invalid JSON 拒绝且不得持久化；
15. lease duration 必须为有限正数；非有限值或非正值必须在创建 lease 前拒绝且不得留下 task/event mutation；
16. 完整 lease token 不得出现在 status、event payload、error、fail reason 或其他持久化/可观察文本中。

`acceptance_checks[]` 至少包含真实命令，覆盖：

- focused unit tests；
- SQLite persistence / reopen；
- concurrent claim；
- CLI subprocess E2E；
- rollback / atomicity；
- malformed CLI JSON envelope；
- strict JSON constants（scalar 与 nested）；
- finite positive lease duration；
- exact 与 embedded lease-token redaction；
- full regression。

本实验没有既有数据库迁移，因此不得因缺少 migration dry-run / rollback 阻断。

---

## 7. Compact Bundle for R7

发布本 Adapter 时同时发布一个轻量 `bundle.json`，绑定：

- 本 Adapter 的 exact SHA，document roles 为 PRD / ADR / SYSTEM_DESIGN / API_CONTRACT / ACCEPTANCE_CRITERIA；
- allowed scope：R7 当前空 repository 内的 `src/`、`tests/` 和必要根级项目配置；
- forbidden scope：R1–R6 路径、父目录、`.codex/`、Financial Agent 路径和 Frozen Bundle bytes；
- acceptance checks；
- `changes_existing_persisted_data = false`；
- user publication approval reference。

不发布 inventory、`implementation-manifest.json` 或专用 Gate validator。

---

## 8. 角色与隔离

- Develop Loop 中只有独立 Developer identity 可以在 allowed scope 内创建、修改、删除或重命名产品源码、测试、migration、配置或产品文档；
- Orchestrator、Machine Gate、automated verification、Reviewer A、Reviewer Closure、Blind Challenger、Final Fresh Challenger、Adjudicator、Human Final Authority 以及其他 Develop Loop 角色对 product candidate 一律只读；它们不得通过 helper、subagent、脚本、formatter 或 code generator 间接写入。验证产生的临时 cache、test output 和日志必须隔离在 candidate snapshot 之外且不得提交；
- 非 Developer 角色只能在 product candidate 外写自己的最小报告或运行记录；任何非 Developer 产品写入使 candidate 失效并触发 `UNAUTHORIZED_PRODUCT_WRITE_VIOLATION`；
- Reviewer A 与 Blind Challenger 为不同 identity，并只读审查同一 snapshot；
- Reviewer A 建立 Requirement → Code → Test → Result 的确定性符合性证明；Blind Challenger 只尝试通过 race、bypass、rollback、stale authority、异常输入和 false-positive test 等高风险路径推翻它，不重复普通 acceptance checklist；
- Adjudicator 与前三者不同，只读裁定 finding 和根因；
- Reviewer 与 Challenger 在报告 sealed 前互相 blind，且都不得修复自己的 finding；
- 发生 code remediation 时，同一 Reviewer A 做只读增量 closure，同一 Adjudicator做只读 closure adjudication；不得每轮重建完整角色组；
- code closure 后只启动一个 Final Fresh Challenger；它与前述角色不同且只读。其 accepted CODE_DEFECT 必须经 Adjudicator 交给后续 Developer remediation loop，不能由 Challenger 自行处理；
- 最终 GO 只由 Human Experiment Owner 批准。

## 9. P0/P1 根因路由

accepted P0/P1 必须分类为 Core v2.6 定义的 root cause。

`CODE_DEFECT` 沿用原 Bundle SHA，将同一 adjudication 中的 accepted findings 合并为一个 batch，回到同一 Developer，由 Developer 独占执行产品修改，再执行完整机器验证、Reviewer A 只读增量 closure，并在 code closure 后执行一次只读 Final Fresh Challenger。Final Fresh Challenger 新发现的 accepted CODE_DEFECT 同样回到后续 Developer remediation loop；不得由 Challenger 修改代码，也不得每轮重新创建 Reviewer A + Blind Challenger + Adjudicator。

任何 frozen-document defect 停止本 cycle，经对应 Owner 修改、人工审核并发布 superseding Bundle 后开启新 cycle。不得由实验角色自行解释合同。

## 10. Workflow 验收

实验成功至少证明：

1. Lightweight Gate 通过后立即 dispatch Developer；
2. Developer 前没有 Architecture 或 Builder 角色；
3. 至少产生产品源码和测试；
4. automated verification 使用真实命令与退出码；
5. 初始 Reviewer A 与 Blind Challenger 独立且审查同一 snapshot；
6. 初始两份报告批量列出 findings，不在第一个问题处提前结束；
7. Adjudicator 没有引入新要求，并在一个 cycle 内沿用同一 identity 做 closure；
8. accepted P0/P1 按根因进入正确回路；
9. 纯代码修复保持原 Bundle SHA，并以 batch remediation 处理；
10. remediation 后使用 Reviewer A closure，而非新建完整双审查；
11. 发生 remediation 时只启动一个 Final Fresh Challenger；未发生 remediation 时不重复 challenger；
12. Full Discovery Review pair count <= 1，Final Fresh Challenger identity count <= 1；
13. 文档修订需要人工批准的新 Bundle；
14. 无 accepted P0/P1 时进入 Human Final Confirmation；
15. active run 没有创建 inventory、manifest Builder 或专用 Gate validator；
16. 历史 Bundle、finding 与 cycle 保持 append-only；
17. 记录每个 phase 和 cycle elapsed time；Agent phase 默认 30 分钟、cycle 默认 180 分钟；超时只允许 retry/blocked，不得降低门槛；
18. 只有 Developer 产生 product candidate 写入；所有其他 Develop Loop 角色保持产品只读，且 Final Fresh Challenger 的 accepted code finding 被交还 Developer remediation loop。

没有自然产生 accepted P0/P1 时记录：

```text
remediation_path_coverage = NOT_TRAVERSED
```

不得伪造 finding。

## 11. 终态

允许：

- `EXPERIMENT_WORKFLOW_VALIDATED`；
- `EXPERIMENT_ZERO_FINDING_PATH_ONLY`；
- `EXPERIMENT_IMPLEMENTATION_DEFECT_OPEN`；
- `EXPERIMENT_BLOCKED_INVALID_FROZEN_BUNDLE`；
- `EXPERIMENT_BLOCKED_DOCUMENT_DEFECT_PENDING_HUMAN_APPROVAL`；
- `EXPERIMENT_BLOCKED_PLATFORM_GATE_UNAVAILABLE`；
- `EXPERIMENT_BLOCKED_PLATFORM_LATENCY`；
- `EXPERIMENT_WORKFLOW_ROLE_MULTIPLICATION_VIOLATION`；
- `EXPERIMENT_NO_GO_BY_HUMAN`。

任一 Agent 自报 PASS、测试绿色或 commit 均不等于 GO。

## 12. 启动限制

本候选对 R6 为 `NO_EFFECT_ON_ACTIVE_ROUND`，不得修改已验证的 v2.5.1/v0.6.1 运行或持久化快照。只有 Core v2.6、Adapter v0.7 和下一轮 Bundle exact bytes 经用户批准后，才能创建新的 latency-bounded clean-room experiment。旧 R6 history 必须保留。

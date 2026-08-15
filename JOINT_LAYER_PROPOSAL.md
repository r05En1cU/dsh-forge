# 联合封装层提案：dsh-forge × cordis-fabric

> 状态：草案 v0.1（2026-08-15），供与 cordis-fabric 作者（omdsh-dev）讨论
> 验证代码：`research/facade-poc.mjs`（7 断言全绿，`node facade-poc.mjs` 复现）

## 1. 提案一句话

双方联合维护一个**封装层包**：上游是 fabric 的变换引擎（在场时）或我们的原型补丁后端（兜底），下游是标准化 Cordis 事件——社区开发者只写 `ctx.on('official-chat/message', handler)`，对底层引擎零感知。

## 2. 为什么合作对双方都成立

**fabric 侧的痛点**（其 README 明示）：
- 需要宿主接线（`patches/fabric-host-integration.patch`），官方 npm 版 dsh 目前无法启用，"等官方合并"是被动的；
- 引擎强大但没有消费生态：每个使用者都要自己写 module/versionRange/filePath/functionQuery 并扛版本漂移。

**我们侧（API 维护者团体）的痛点**：
- 原型补丁只能覆盖 service 原型方法，拦不了模块级函数、闭包、`#private`、浏览器端；
- 长期看官方若合并 fabric 接线，纯运行时方案窗口期有限。

**合作后**：
- fabric 获得现成消费生态与"官方应当合并接线"的现实压力来源——封装层在**无 fabric 宿主上也能跑**（原型兜底），用户基数不依赖官方动作；fabric 在场时自动升级为全能力引擎；
- 我们获得全能力后端（任意函数、around/replace、浏览器）而无需自研 AST 变换；
- 社区开发者获得唯一稳定接口：`ctx.on()` 事件，引擎切换对他们透明。

## 3. 分层架构

```
┌────────────────────────────────────────────────────┐
│ 消费层：社区插件 ctx.on('official-chat/message')    │  ← 唯一稳定契约
├────────────────────────────────────────────────────┤
│ 封装层（联合维护，本提案主体）                        │
│  · 注入点注册表（按官方插件组织，版本跟踪+契约测试）    │
│  · 事件转译器（后端调用记录 → ctx.bail/emit）        │
│  · 后端协商（fabric 在场用 fabric，否则原型兜底）      │
├────────────────┬───────────────────────────────────┤
│ fabric 引擎     │ 原型补丁引擎（dsh-forge-core）      │
│（omdsh-dev 维护）│（我方维护，零宿主依赖）              │
└────────────────┴───────────────────────────────────┘
```

## 4. 核心契约：统一注入点描述符

一个注入点 = 一份声明，同时携带两种后端所需的 targeting 信息（字段级映射，PoC 场景 B 已验证）：

```ts
interface InjectionPoint {
  /** 事件命名空间，也是下游消费入口，如 'official-chat/message' */
  id: string
  /** 目标层级：1=消费方调用视图；2=service 原型方法；3=非 service 函数/闭包/#private/浏览器 */
  tier: 1 | 2 | 3
  /** fabric 后端目标：字段级对应 FabricPatchStub（module/versionRange/filePath/functionQuery）；tier 3 必填 */
  fabric?: {
    target: FabricTarget          // 直接复用 cordis-fabric 的类型
    operation: FabricOperation    // before/after/around/replace
  }
  /** 原型兜底目标 */
  runtime: { service: string; method: string }
  /** 该注入点要求的能力；原型后端不支持 around/replace 时降级为观察并告警 */
  requires?: 'observe' | 'mutate' | 'replace'
  /** 引擎独占（仅 tier 3 豁免场景，见 §5.0.1）：放弃运行时兼容性保证，禁止多中间件链 */
  engineExclusive?: boolean
  /** 接口抽象：向下游暴露稳定领域 payload 而非裸位置参数（官方签名漂移由 catalog 吸收） */
  map?: {
    toEvent?: (args: unknown[]) => Record<string, unknown>
    applyEvent?: (payload: Record<string, unknown>, args: unknown[]) => void
  }
}
```

> 实现状态：上述描述符已在 `dsh-forge` 包落地（`src/types.ts`），门面为标准 Cordis 服务 `ForgeService`（`ctx.forge`，可 `inject`、可 `ctx.intercept('forge', policy)` 治理：`deny` 禁用指定注入点、`allowMutate: false` 将变更点降级为纯观察），统一验证姿势为 `contractSuite(catalog, harness)`。

事件语义（与后端无关；命名约定：裸 id 即观察事件，最大限度降低学习成本）：
- `{id}`：`ctx.emit` 派发，调用 settle 后触发，携带 `event.result`——90% 场景的唯一点；
- `{id}/before`：`ctx.bail` 派发，事件对象可变（`event.args` 改参），仅需要变更时接触；
- `around`/`replace` 语义仅 fabric 后端提供，通过 `requires` 声明并在描述符文档中注明后端要求（M2）。

## 5. 后端协商与集成接缝

### 5.0 选择原则：最小充分机制（capability tiering）

加载期 AST 变换**不是默认引擎，而是最后手段**。它的组合性代价是结构性的：变换按模块文件烘焙进进程级 module cache，无法按 Cordis 上下文分化（`ctx.isolate()` 子树对它不可见）；hooks 无 unregister，停用只是透传而非回滚，旧 exports 对象保留旧变换；跨 installation 的组合顺序在变换期锁死、priority 语义失效（以上均见其 `docs/fabric.md` 自述）。运行时机制则相反：`internal/get` waterfall 按消费方 ctx 逐次求值，原型补丁可 descriptor 级精确回滚、链式顺序调用时才解析。

因此封装层按目标类型选"最小充分机制"，而非按系统二选一：

| 目标层级 | 机制 | 何时需要 fabric |
|---|---|---|
| 消费方调用视图 | `internal/get` waterfall 包装 | 否 |
| service 原型方法（含内部自调用） | 原型补丁（`this.ctx` 路由事件） | 否 |
| 非 service 函数 / 闭包 / `#private` / 浏览器端 | 加载期 AST 变换 | **是——仅此类注入点** |

`InjectionPoint.tier` 显式声明层级；前两级在官方 npm 宿主上即可用，第三级才要求宿主接线。fabric 的宿主依赖由此从"整个方案的硬门槛"降级为"少数高级注入点的可选增强"。

### 5.0.1 引擎互斥规则（硬性）

**禁止用加载期变换直打运行时可达的 service 方法。** 一旦 AST 变换改写 service 方法体，本方案已验证的全部兼容性保证整体失效：

- 回滚作废——原方法体被桥接代码替换并烘焙进 module cache，dispose 仅剩透传，且先/后创建的实例可能跑不同代变换（行为分裂）；
- 多中间件链式纪律作废——运行时链操作 descriptor，看不见也管不了文本期嵌套的变换层，跨引擎叠加无仲裁；
- 事件路由从上下文级退化为进程级（bridge 通道全局激活，`FabricCall.self` 只能事后找回上下文）；
- 热重载语义破坏——官方 fiber restart 后新旧实例行为不一致。

注册表校验落地：注入点审核时若 `fabric.target` 解析结果落在某个 `Service` 子类的原型方法上（CI 里对目标包做静态检查即可判定），tier 3 注册直接拒绝。

**仅有的两个豁免场景**（运行时原理性不可达）：
1. 目标为 `#private` 硬私有成员；
2. 官方在构造期捕获了绑定引用（如 `this.cb = this._m.bind(this)` 或把方法引用注册进回调表），后装原型补丁影响不到已捕获拷贝。

豁免注入点必须：标记 `engineExclusive: true`、`required: true` + 精确版本钉扎、文档明示"以牺牲全部运行时兼容性保证为代价"、不参与多中间件链。此类注入点数量是"应推动官方暴露正规事件"的量化信号。

### 5.1 协商逻辑

封装层插件启动时按注入点的 `tier` 声明选择后端（`facade-poc.mjs` 已验证该协商逻辑）：

1. **tier 1/2（运行时可达目标）**：默认走运行时后端，无论 fabric 是否在场——组合性优先。service 注册检测用 Cordis 官方 `internal/service` 事件 + `ctx.get(name, false)` 追赶，与加载顺序无关（已在 `research/poc.mjs` 对真实 `@deepseek-ai/cordis@4.0.1` 验证，22 断言）。
2. **tier 3（运行时不可达目标）**：fabric 在场（宿主已接线）时经 `ctx.fabric.register()` 注册（可复用 `FabricCompatService.observe()` 的懒认领模式——首个监听器认领 patch、末个监听器释放，这个设计很好，建议保留）；fabric 缺席时该注入点降级为不可用并显式告警，**不**静默回退（原型后端够不着这类目标，假装支持比拒绝更糟）。

**关键集成接缝——fabric 的加载期约束**：fabric 的 instrumentations 必须在目标模块首次 import 前安装。因此注册表包需额外导出：

```ts
// 供宿主 bootstrap 期调用（对齐 fabric-api 既有的 buildCompatInstrumentations 模式）
export function buildInstrumentations(registry: InjectionPoint[]): FabricInstrumentationConfig[]
```

宿主（或 fabric 的 `config.fabric.patches` 组合行）在 `boot()` 前合并这些静态描述符；运行期封装层再通过 `ctx.fabric.register()` 绑定 handler。**这条接缝 fabric-api 已经设计好了，我们只是把注册表做成它的上游数据源**——这是对 fabric 作者改动最小的接入方式。

## 6. 对 fabric 现有代码的复用点（不需要 fabric 改动的部分）

- `FabricTarget` / `FabricPatchStub` 类型：直接 import 复用；
- `buildCompatInstrumentations()` 模式：注册表包照搬其形态导出 `buildInstrumentations()`；
- `isFabricInstalled()` / `getFabric(ctx)`：后端探测与按需挂载；
- `FabricCompatService.observe()` 的懒认领/HMR 代际所有权逻辑：封装层 fabric 后端直接复用或镜像；
- `ctx.fabric.bindings()` / `list()`：注入点诊断（"本注入点实际绑定了哪些文件"）直接透传给社区开发者。

**需要 fabric 侧配合的唯一事项**：联合发布与文档互链；可选——将 `cordis-fabric-api` 的 compat 配置来源从静态 config 扩展为可注入注册表（不破坏现有 API 的纯增量）。

## 7. 治理与分工建议

| 事项 | 负责方 |
|---|---|
| 变换引擎、hooks、浏览器构建、优先级语义 | fabric 作者（现状不变） |
| 原型兜底引擎 | 我方 |
| 注入点注册表（每个官方插件一份 catalog + 契约测试） | 联合，PR 双 review |
| 事件命名空间规范（`{插件名}/{动作}` 保留字、冲突仲裁） | 联合 |
| 社区文档与示例 | 我方为主 |
| 官方对接（推动宿主合并 fabric 接线） | 联合署名提案 |

注入点入库标准（草案）：附官方插件版本范围 + 契约测试（对目标方法发一次调用断言事件触发）；官方插件升级导致契约测试红 → 注册表标记该注入点 `degraded`，封装层运行时降级为观察/跳过并告警，不炸下游。

## 8. 里程碑建议

- **M1（2 周）**：封装层 MVP = 统一描述符 + 原型后端 + 事件转译 + 1 个官方插件的示范注册表。npm 独立可用（零宿主依赖），作为合作诚意的可运行交付物。**（已完成：仓库根 `dsh-forge` 包，12 项契约测试通过，见 `README.md`）**
- **M2**：注册表导出 `buildInstrumentations()`；在打了宿主 patch 的 deepseek-harness 检出上跑通 fabric 后端双模式；同一注入点两种后端行为一致性测试。**（已完成：`buildPatchStubs()` + 真实 cordis-fabric 引擎 E2E（`test/fabric-e2e.test.ts`，before/around/replace/卸载回退/跨后端事件契约，27 项总测试全绿）；真实 DSH 宿主验证待宿主接线合并后进行）**
- **M3**：联合向 deepseek-harness 官方提交宿主接线提案（以封装层生态作为采用证据）；浏览器端注入点支持。
- **M4**：治理正式化——注入点登记流程、命名空间仲裁、第三方中间件团体的链接入规范（shimmer 式链式纪律，已在 `research/poc.mjs` 场景 D 验证）。

## 9. 验证状态

- `research/poc.mjs`：原型后端完整验证（顺序无关拦截、精确回滚、多中间件链、版本漂移降级、性能基线 ~8µs/次），22 断言。
- `research/facade-poc.mjs`：双后端协商验证——同一份描述符，fabric 缺席时走原型后端、在场时字段级映射为 `FabricPatchStub` 且事件流与变更回写行为一致；fabric 模式下原型零污染，7 断言。
- fabric 侧结论来自 `github.com/omdsh-dev/fabric` main 分支源码通读（`docs/fabric.md`、`packages/cordis-fabric/src/types.ts`、`packages/cordis-fabric-api/src/compat.ts`）。

# dsh-forge 架构：Mixin 一等公民 + Cordis 原生事件总线

> 目标：让 DSH 社区插件开发者以最低学习成本、最小破坏性更新冲击开发插件；
> 底层复用 `omdsh-dev/fabric` 的 Mixin 引擎，上层复用官方 Cordis 事件注册与 HMR。

## 1. 分层

```
┌──────────────────────────────────────────────────────────┐
│ 消费层：社区插件                                           │
│   ctx.on('vendor/action', handler)                        │
│   ctx.forge.on(...) 语法糖（1:1 委托 ctx.on）              │
├──────────────────────────────────────────────────────────┤
│ 标准 API 层（dsh-forge，本仓库）                           │
│   defineMixin       —— 一等 Mixin 声明                     │
│   defineEventPoint  —— Mixin → 稳定事件契约                │
│   defineCatalog     —— 每个官方包一份版本化 catalog         │
│   ForgeService      —— 注册、诊断、host policy             │
│   buildPatchStubs   —— 宿主 bootstrap 接缝                 │
├───────────────────────────┬──────────────────────────────┤
│ fabric 引擎（cordis-fabric）│ 运行时 fallback（tier 1/2）    │
│ 加载期 AST 变换、优先级、   │ internal/get 消费方视图；       │
│ bindings、HMR ownership   │ internal/service + 原型补丁     │
└───────────────────────────┴──────────────────────────────┘
│ Cordis 内核（事件、fiber、reflect、loader HMR）             │
└──────────────────────────────────────────────────────────┘
```

## 2. 关键决策

### 2.1 不另造事件发射器

事件总线直接使用 `ctx.bail` / `ctx.emit` / `ctx.on`：

- listener 随注册 fiber 自动回收——这就是官方 HMR 事件注册方式；
- context 过滤、isolate、prepend、global 等官方语义免费保留；
- 不引入第二个“订阅表”，不存在自定义 emitter 漏卸载问题。

`ForgeService.on/once/emit/bail` 只是委托方法，返回值是官方 disposer。

### 2.2 Mixin 声明与事件点分离

- `Mixin` 是可直接交给 `ctx.fabric` 的静态描述符（`id/target/operation/priority/required`），不含 handler。
- `EventPoint` 引用一个 Mixin 并声明事件契约（`requires`、`map`、阶段）。
- `buildPatchStubs()` 是二者到 fabric 加载期 stubs 的唯一编译函数，宿主在 `boot()` 前调用。
- 裸 `Mixin[]` 也可以直接传给 `createForge()`：标准层自动派生事件投影，真正做到“Mixin 一等公民，事件总线可选”。

### 2.3 tier 选择

| tier | 目标 | 后端 | 条件 |
|---|---|---|---|
| 1 | 消费方调用视图 | `internal/get` waterfall | 无 |
| 2 | service 原型方法（含内部自调用） | `internal/service` + 原型补丁 | 无 |
| 3 | 模块函数/闭包/`#private`/浏览器 | `cordis-fabric` 加载期变换 | 宿主已 bootstrap |

硬规则：**运行时可及的 service 方法不得用加载期变换直打**，除非 `engineExclusive: true` 并有文档化理由——加载期变换无法 descriptor 回滚，且跨安装组合顺序在文本期锁死。

### 2.4 能力与策略

- `requires` 是能力的显式声明：`observe`（默认）/ `mutate` / `replace`。
- 宿主通过 `ctx.intercept('forge', { deny, allowMutate })` 按子树治理。
- `allowMutate: false` 时，before/after 收到浅拷贝，任何写入都不可回流；这是策略保证，不是约定。

### 2.5 HMR 三段式

1. **消费方 listener**：官方 `ctx.on` effect。
2. **fabric patch 注册**：`ctx.fabric.register` 的 fiber effect + same-owner transfer；新代接管，旧代卸载 no-op。
3. **tier-2 原型代际**：`internal/service` 同步通知；`retire(oldProto) → attach(newProto)` 在同一同步窗口内完成；回滚重放旧类时恰好一次重绑。

### 2.6 漂移与降级

- 定义期：错误 id、错误 operation/capability 组合、缺 target 直接 throw。
- 绑定期：方法缺失 → `missing`；opt-out → `opted-out`；fabric 未接线 → `unavailable`。
- 诊断期：`status()` 实时复核 fabric `list()`、`bindings()`、`readVersion()`，报告 `bound/pending/stale`。

## 3. 目录

```
src/
  mixin.ts           defineMixin / buildPatchStubs / 静态 stub 编译
  registry.ts        defineEventPoint / defineCatalog / 定义期校验
  service.ts         ForgeService：注册、诊断、事件糖、registerMixin
  dispatch.ts        FabricCall/方法调用 → ForgeEvent 的稳定转译
  backends/
    fabric.ts        tier 3：ctx.fabric 注册 + operation → 事件阶段
    prototype.ts     tier 2：原型补丁 + internal/service + HMR 代际
    getview.ts       tier 1：internal/get 消费方视图
  testkit.ts         contractSuite：一个 catalog 一次调用的标准验证
test/
  forge.test.ts      41 项中的运行时/注册表/HMR/policy/事件糖部分
  fabric-e2e.test.ts 真实 cordis-fabric 引擎 E2E
research/fabric/     vendored omdsh-dev/fabric（build 后本地使用）
```

## 4. 尚未做 / 明确非目标

- 不提供注解/decorator 版 `@SubscribeEvent`：JS/TS 生态下 `ctx.on` 就是官方方式，装饰器只是无收益的平行入口。
- 不镜像 `ctx.slots` / `ctx.tools` 等已有官方注册面；官方已有标准 API 时一律用官方 API。
- 浏览器端 tier-3 目标复用 fabric 的 browser transform，标准层只负责事件契约不变。

# dsh-forge

面向 DeepSeek Harness（DSH）插件开发的**类 NeoForge 标准 API 层**：

- **Mixin 是一等公民**：`defineMixin()` 是唯一、显式、可版本治理的织入声明，直接复用 [`omdsh-dev/fabric`](research/fabric)（`cordis-fabric`）的加载期变换引擎、优先级组合、bindings 内省与 HMR ownership transfer。
- **事件总线是消费面**：织入点被转译为标准 Cordis 事件，开发者只写 `ctx.on('vendor/action', handler)`（或 `ctx.forge.on(...)` 语法糖）——这就是 DSH 官方的事件注册方式，因此 **HMR 回收、fiber 生命周期、context 过滤天然复用官方机制**。
- **破坏性更新由 catalog 吸收**：官方包签名漂移只改 catalog，不改下游插件；稳定 `payload` 映射把“位置参数”变成“领域事件”。

```
官方模块函数/私有方法 ──cordis-fabric 加载期变换──► FabricCall
                                                        │
                         defineMixin ──► ctx.fabric.register
                                                        │
                         defineEventPoint ──► {id}/before (ctx.bail)
                                              {id}        (ctx.emit)
                                                        │
社区插件 ctx.on('vendor/action', event => …) ◄──────────┘
```

## 快速开始

### 1. 宿主 bootstrap（只对 tier-3 mixin 目标）

fabric 的变换 hooks 必须在目标模块首次 import 前安装。catalog 包导出静态 stubs：

```ts
import { bootstrapFabric } from 'cordis-fabric'
import { buildPatchStubs } from 'dsh-forge'
import agentCatalog from './catalogs/agent.ts'

const disposeHooks = bootstrapFabric(buildPatchStubs([agentCatalog]))
// 之后再 import @deepseek-ai/dsh-agent 等目标包
```

### 2. catalog 作者：声明一等 mixin + 稳定事件

```ts
import { defineCatalog, defineEventPoint, defineMixin } from 'dsh-forge'
import type { ForgeEvent } from 'dsh-forge'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent-preset/switch'(event: ForgeEvent<{ to: string }>): void
    'agent-preset/switch/before'(event: ForgeEvent<{ to: string }>): void
  }
}

export default defineCatalog({
  plugin: '@deepseek-ai/dsh-agent',
  versionRange: '>=0.0.0-0',          // DSH 全系 rc：不能用 '^x'（不匹配预发布）
  points: [
    defineEventPoint({
      id: 'agent-preset/switch',
      tier: 3,
      requires: 'mutate',
      mixin: defineMixin({
        id: 'agent-preset/switch',
        target: {
          module: '@deepseek-ai/dsh-agent',
          versionRange: '>=0.0.0-0',
          filePath: 'lib/index.js',
          functionQuery: { className: 'AgentPresets', methodName: 'recompose', kind: 'Method' },
        },
        operation: 'around',
        priority: 100,
      }),
      map: {
        toEvent: (args) => ({ to: args[0] }),
        applyEvent: (payload, args) => { args[0] = payload.to },
      },
    }),
  ],
})
```

### 3. 装配 catalog

```ts
import { createForge } from 'dsh-forge'
import agentCatalog from './catalogs/agent.ts'

ctx.plugin(createForge(agentCatalog))
```

### 4. 社区插件：零 mixin 概念

```ts
export const name = 'my-preset-logger'

export function apply(ctx) {
  // 官方 HMR 事件注册方式：listener 是当前 fiber 的 effect，卸载自动回收
  ctx.on('agent-preset/switch/before', (event) => {
    event.payload.to = 'code'          // 改稳定 payload，不碰位置参数
  })
  ctx.on('agent-preset/switch', (event) => {
    console.log('switched to', event.result)
  })
}
```

等价写法（仍然是 `ctx.on`，只是类型化入口更显式）：

```ts
export const inject = ['forge']
export function apply(ctx) {
  ctx.forge.on('agent-preset/switch', (event) => { … })
}
```

## Mixin：一等公民

```ts
const mixin = defineMixin({
  id: 'vendor/raw-patch',              // fabric patch id，进程内独占
  target: {
    module: 'some-package',
    versionRange: '>=0.0.0-0',
    filePath: /^(lib|src)\/index\.js$/,
    functionQuery: { functionName: 'compute', kind: 'Sync' },
  },
  operation: 'before' | 'after' | 'around' | 'replace',
  priority: 100,                       // 越大越先执行（外层）
  required: true,                      // 启动后未绑定任何文件则 fail-loud
})
```

两种用法：

```ts
// A. 低层：直接注册完整 fabric handler（不做事件投影）
ctx.forge.registerMixin(mixin, (call, invoke) => {
  call.arguments[0] = String(call.arguments[0]).toUpperCase()
})

// B. 标准层：包成事件点，或直接注册 mixin 数组自动派生事件
ctx.plugin(createForge([mixin]))
ctx.on('vendor/raw-patch/before', event => { … })
```

## 事件语义

| 织入 operation | `{id}/before`（`ctx.bail`） | `{id}`（`ctx.emit`） |
|---|---|---|
| `before` | 可改 `event.args` | 无 |
| `after` | 无 | `event.result` 可改并回流 |
| `around` | 可改参；`event.veto = true` 跳过原方法 | settle 后携带 `event.result` |
| `replace` | 完全接管；`event.invoke()` 才执行原方法 | 无 |

运行时后端（tier 1/2）统一提供 `{id}/before` + `{id}` 两阶段，与 fabric 后端的 around 语义一致。

## 破坏性更新影响最小化

- **稳定事件面**：事件名是 catalog 的公共契约，官方方法改名/改签名只改 catalog。
- **版本治理**：`target.versionRange` + `readVersion` 诊断；tier-3 漂移报告 `stale` 而不是静默失效。
- **契约测试**：每个 catalog 必须附带 `contractSuite(catalog, harness)` —— 一次安装、一次调用、断言事件恰好一次。
- **默认观察、显式写入**：`requires: 'mutate' | 'replace'` 是 review-listed 能力；宿主可 `ctx.intercept('forge', { allowMutate: false })` 降级为只读。

## HMR 语义

- 下游监听器就是官方 `ctx.on`，DSH loader 卸载旧 fiber 时官方事件服务自动回收 listener。
- fabric patch 注册走 `ctx.fabric.register()`，复用其 **same-owner HMR ownership transfer**：新代插件接管旧代 patch，旧代卸载成为 no-op。
- 运行时原型后端对齐 loader 的串行 `dispose → start → rollback` 线：`internal/service` 同步通知，新类 prototype 在同一同步窗口内完成代际交接，dependents 首次重载调用即见新行为。
- tier-3 变换覆盖面不可运行时刷新：`status()` 复核 bridge 注册、bindings 与版本范围，漂移显式 `stale`。

## 服务与治理

`ForgeService` 是标准 Cordis 服务（`ctx.forge`）：

```ts
ctx.intercept('forge', { deny: ['vendor/unsafe-point'] })         // 子树上禁用某注入点
ctx.intercept('forge', { allowMutate: false })                    // 全降级为 observe-only

ctx.forge.register(catalog)         // fiber-scoped 注册
ctx.forge.registerMixin(mixin, h)   // 裸 mixin 注册
ctx.forge.status()                  // 每个注入点的后端/绑定/漂移诊断
ctx.forge.on(name, listener)        // = ctx.on，官方 HMR 事件路径
```

## 开发

```sh
pnpm install         # 同时执行 prepare 构建 dist/
pnpm run typecheck   # tsc strict
pnpm test            # 41 项：真实 cordis-fabric E2E + 运行时后端 + HMR + policy
pnpm run build       # dist/ ESM + d.ts
```

要求 Node ≥ 22.19；fabric 的同步 `module.registerHooks` 路径需要 Node ≥ 22.22.3 / ≥ 24.11.1。更完整的架构决策见 [`docs/architecture.md`](docs/architecture.md)，vendored 上游见 [`research/fabric`](research/fabric)。

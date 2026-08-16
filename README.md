# dsh-forge

面向 DeepSeek Harness（DSH）插件开发的**类 NeoForge 标准 API 层**：

- **语义化 source，先 seam 后 mixin**：catalog 作者声明 `event / service / view / mixin / fabric`，后端自动选择；官方已有事件或服务方法时零补丁。
- **Mixin 是一等公民**：`defineMixin()` 是显式、可版本治理的织入声明；默认在**运行期**解析目标、保留旧快照、执行修改后的包装，卸载时恢复旧快照——不需要宿主安装任何加载期 hooks。
- **运行期目标全局独占**：同一目标被多个第三方包 patch 时直接 loud error，不做隐式链式叠加。
- **事件总线复用官方 HMR**：`ctx.on('vendor/action', handler)` / `ctx.forge.on(...)` 就是官方 Cordis 事件注册，fiber 卸载自动回收 listener。

```
语义 source
  ├─ event     → 官方事件别名（零补丁）
  ├─ service   → internal/service + 原型快照/恢复
  ├─ view      → internal/get 消费方视图
  ├─ mixin     → 运行期 resolve → descriptor 快照 → wrapper → 恢复
  └─ fabric    → 可选加载期桥（仅运行期不可达目标）
                    │
                    ▼
            {id}/before (ctx.bail) + {id} (ctx.emit)
                    │
                    ▼
        社区插件 ctx.on('vendor/action', …)
```

## 快速开始

### 1. catalog 作者：语义 source + 稳定事件

```ts
import { defineCatalog, defineEventPoint } from 'dsh-forge'
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
      requires: 'mutate',
      source: {
        kind: 'mixin',
        target: {
          module: '@deepseek-ai/dsh-agent',
          versionRange: '>=0.0.0-0',
          filePath: 'lib/index.js',
          functionQuery: { className: 'AgentPresets', methodName: 'recompose', kind: 'Method' },
        },
        operation: 'around',
        priority: 100,
      },
      map: {
        toEvent: (args) => ({ to: args[0] }),
        applyEvent: (payload, args) => { args[0] = payload.to },
      },
    }),
  ],
})
```

### 2. 装配 catalog

```ts
import { createForge } from 'dsh-forge'
import agentCatalog from './catalogs/agent.ts'

ctx.plugin(createForge(agentCatalog))
```

### 3. 社区插件：零 mixin 概念

```ts
export const name = 'my-preset-logger'

export function apply(ctx) {
  ctx.on('agent-preset/switch/before', (event) => {
    event.payload.to = 'code'
  })
  ctx.on('agent-preset/switch', (event) => {
    console.log('switched to', event.result)
  })
}
```

## 运行期 Mixin：快照 → 修改后运行 → 恢复

每个 runtime-mixin 注册都执行：

1. `Object.getOwnPropertyDescriptor(holder, key)` 保存**精确旧快照**；
2. `Object.defineProperty(holder, key, { ...snapshot, value: wrapper })`；
3. 调用经 wrapper 执行 Advice 语义；
4. fiber 卸载时恢复旧快照 descriptor。

**冲突策略**：目标 `(holder, key)` 运行期全局独占。第二个第三方包尝试 patch 同一目标时注册直接抛错：

```text
forge: runtime mixin "b" conflicts with "a" on Object.helper —
a runtime patch target is exclusive
```

同一 mixin id 的同 owner 重注册视为 HMR/重放，卸载后目标恢复可再次注册。

## 运行期 Mixin 能做什么

| 目标 | 支持 | 机制 |
|---|---|---|
| CJS `exports.helper` / 对象属性函数 | ✅ | 保存 descriptor，替换为 wrapper |
| class 实例方法 `ChatService.prototype._send` | ✅ | `className + methodName` 定位 prototype，现有实例立即生效 |
| ESM class export 的实例方法 | ✅ | namespace 绑定只读，但 `class.prototype` 可变 |
| 尚未加载模块里的 class 方法 | ✅ | 监听官方 `internal/service`，服务注册时补丁 |
| ESM named export 模块级函数 | ❌ `unavailable` | namespace 绑定运行期不可写 |
| `#private`、闭包、`astQuery` | ❌ `unavailable` | 运行期原理性不可达 |

不可达目标不会静默假装成功：`ctx.forge.status()` 明确报告 `bound / pending / missing / unavailable / stale`。

## Advice：唯一拦截原语

`before / after / around / replace` 全部编译为同一个 `around` 形态：

```ts
type OperationPhases = {
  before?(call): void
  after?(call): unknown
  around?(call, proceed): unknown
}
```

事件后端和裸 `registerMixin` 后端共享这一个操作分发器，因此 async settle、host policy、payload 映射只实现一次。

## 事件语义

| 织入 operation | `{id}/before`（`ctx.bail`） | `{id}`（`ctx.emit`） |
|---|---|---|
| `before` | 可改 `event.args` | 无 |
| `after` | 无 | `event.result` 可改并回流 |
| `around` | 可改参；`event.veto = true` 跳过原方法 | settle 后携带 `event.result` |
| `replace` | 完全接管；`event.invoke()` 才执行原方法 | 无 |

`source: { kind: 'event' }` 是纯观察别名，只有 `{id}`，没有写回能力。

## 破坏性更新影响最小化

- **稳定事件面**：事件名是 catalog 的公共契约，官方方法改名/改签名只改 catalog。
- **版本治理**：`target.versionRange` + 自动读取目标包 `package.json`（或注入 `readVersion`）。
- **契约测试**：`contractSuite(catalog, harness)` —— 一次安装、一次调用、断言事件恰好一次。
- **默认观察、显式写入**：`requires: 'mutate' | 'replace'` 是 review-listed 能力；宿主可 `ctx.intercept('forge', { allowMutate: false })` 降级为只读。

## 模块级函数 mixin：自定义事件层

`functionName` / `expressionName` 类型的 `mixin` source 会自动路由到 `module-mixin` 后端，它专门消费以下标准 Cordis 事件：

| 事件 | 语义 |
|---|---|
| `forge/module/load` | 模块 handle 首次可用 → 解析并 patch |
| `forge/module/reload` | 重新求值产生新 exports holder → 退役旧快照、patch 新 holder |
| `forge/module/unload` | 模块句柄失效 → 恢复当前快照，回到 pending |

宿主 / loader / bundle 刷新器只需发布：

```ts
import { trackModule, reloadModule, untrackModule } from 'dsh-forge'

trackModule(ctx, {
  id: '@pkg/lib/index.js',      // 与 mixin target 的 module/filePath 对应
  module: '@pkg',
  filePath: 'lib/index.js',
  exports: cjsExports,          // 可变 exports holder
  version: '1.2.0',
})

// HMR/重导入后
reloadModule(ctx, { ...same, exports: freshExports })

// 卸载
untrackModule(ctx, '@pkg/lib/index.js')
```

事件派发是同步的，因此 reload 完成后旧 holder 已恢复、新 holder 已 patch。该层仍只对运行期可写的 CJS exports / class prototype 有效；ESM named export 绑定依旧需要 `kind: 'fabric'`。

## HMR 语义

- **下游监听器**：官方 `ctx.on`，loader 卸载旧 fiber 时自动回收。
- **catalog/forge 插件自身**：注册是 `ctx.effect`；卸载恢复快照，重载重新注册。
- **service 类目标**：完整代际 HMR。`internal/service` 同步通知，新类 prototype 在同一窗口内完成 `retire(old) → attach(new)`。
- **模块级 CJS 目标**：无官方“模块被重新求值”事件，运行期无法自动感知；`getForgeStatus(ctx)` / `status()` 会重新解析已绑定目标，发现新 exports holder 后自动退役旧快照、补丁新 holder。
- **ESM named export / `#private` / 闭包**：运行期不可达，仍走 `kind: 'fabric'` 可选加载期桥。

## 服务与治理

`ForgeService` 是标准 Cordis 服务（`ctx.forge`）：

```ts
ctx.intercept('forge', { deny: ['vendor/unsafe-point'] })
ctx.intercept('forge', { allowMutate: false })

ctx.forge.register(catalog)         // fiber-scoped 注册
ctx.forge.registerMixin(mixin, h)   // 裸 mixin 运行期注册
ctx.forge.status()                  // 每个注入点的 source/后端/绑定/漂移诊断
ctx.forge.on(name, listener)        // = ctx.on，官方 HMR 事件路径
```

旧 catalog 的 `tier/runtime/mixin/fabric` 字段会 normalize 为语义 source，现有声明无需迁移。

## WebUI / TUI：事件跨树

- **TUI（cc-tui）**：Node 同树场景直接 `ctx.on`，无需额外层；组件注入仍按目标可达性选择 `mixin` 或 `fabric`。
- **WebUI**：浏览器是另一棵 Cordis 树，使用两个新入口：

```ts
// host 侧：把最新事件发布到官方 webserver exact route
import { createForgeRelay } from 'dsh-forge'

ctx.plugin(createForgeRelay({
  path: '/forge/snapshot',
  points: ['agent-preset/switch'],
}))
```

```ts
// browser 侧：dsh-forge/client 轮询 relay 并 re-emit 同名 forge 事件
import { createForgeClient } from 'dsh-forge/client'

ctx.plugin(createForgeClient({
  route: '/forge/snapshot',
  points: ['agent-preset/switch'],
  interval: 1500,
}))
```

`createForgeClient` 是浏览器安全入口，不 import 任何 Node builtin；事件到达浏览器树后，UI 注册仍走官方 `ctx.slots` / `ctx.command`，forge 只负责事件语义跨树。

## 可选：保留加载期桥

运行期不可达目标可显式声明 `source: { kind: 'fabric' }`，并导出静态 stubs 由宿主自行 bootstrap：

```ts
import { buildPatchStubs } from 'dsh-forge'
import { bootstrapFabric } from 'cordis-fabric'

bootstrapFabric(buildPatchStubs([catalog]))
```

这是兼容出口，不是默认路径；`dsh-forge` 本身不依赖 `cordis-fabric`。

## 开发

```sh
pnpm install         # 同时执行 prepare 构建 dist/
pnpm run typecheck   # tsc strict
pnpm test            # 50 项：Advice + source + runtime/module mixin + WebUI relay/client + HMR + policy
pnpm run build       # dist/ ESM + d.ts
```

要求 Node ≥ 22.19；ESM class 运行期补丁依赖当前 Node 的同步 `require(esm)`（Node 24 默认启用）。架构决策见 [`docs/architecture.md`](docs/architecture.md)，vendored 上游参考 [`research/fabric`](research/fabric)。

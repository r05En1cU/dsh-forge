# dsh-neoforge 调用文档

> 包名：`dsh-neoforge`
> 运行环境：Node ≥ 22.19（ESM class 运行期补丁建议 Node ≥ 24.11）
> 唯一硬 peer：`@deepseek-ai/cordis ^4.0.1-0`

## 0. 包入口

| 入口 | 平台 | 内容 |
|---|---|---|
| `dsh-neoforge` | Node host / TUI | 全部核心 API |
| `dsh-neoforge/client` | Browser / WebUI | 浏览器安全 client 入口 |
| `dsh-neoforge/relay` | Node host | host→browser 快照路由 |
| `dsh-neoforge/ui` | 纯 Cordis，Node/Browser 均可 | 统一 UI 服务 |

```sh
pnpm add dsh-neoforge @deepseek-ai/cordis
# 或通过官方 plugin channel 安装 bundle carrier
dsh plugin --profile <profile> add github:r05En1cU/dsh-neoforge
```

`dsh plugin add` 会在 profile 中插入默认禁用的 `dsh-neoforge` 行。默认只安装包、不 mount 插件；启用该行会执行根入口的 `apply`，挂载 `ctx.neoforge`。

```yaml
- id: dsh-neoforge
  disabled: false
```

---

## 1. 核心模型

```text
catalog  ──定义──> injection points（source）
                        │
                 createNeoForge(catalog)
                        │
                 NeoForgeService（ctx.neoforge）
                        │
                 backend：event / view / service / mixin
                        │
                 Advice（唯一操作原语）
                        │
        {id}/before（ctx.bail）+ {id}（ctx.emit）
                        │
               ctx.on / ctx.neoforge.on
```

一个 injection point 描述：

1. 目标在哪里：`source`
2. 调用前后做什么：`operation`（mixin）或固定两阶段（view/service）
3. 给下游什么：事件 id、payload、能力 `requires`

---

## 2. 一等 Mixin：`defineMixin`

```ts
import { defineMixin } from 'dsh-neoforge'

export const recomposeMixin = defineMixin({
  id: 'agent/presets/recompose',        // 全局唯一 patch id
  target: {
    module: '@deepseek-ai/dsh-agent',
    versionRange: '>=0.0.0-0',
    filePath: 'lib/index.js',
    functionQuery: {
      className: 'AgentPresets',
      methodName: 'recompose',
      kind: 'Method',
    },
  },
  operation: 'around',                  // before | after | around | replace
  priority: 100,                        // 越大越外层
})
```

`functionQuery` 运行期可解析形态：

| 形态 | 用途 |
|---|---|
| `{ functionName, kind }` | CJS exports 函数，走 module-mixin |
| `{ expressionName, kind }` | 同上 |
| `{ className, methodName, kind }` | class prototype / static method，走 runtime-mixin |
| `{ methodName, kind }` | 导出中唯一同名方法，多匹配会要求 `className` |
| `{ className, privateMethodName }` | `#private`：运行期不可达 |

不可达目标会返回 `unavailable`：ESM named export、`#private`、`astQuery`、闭包。

---

## 3. 语义 source：`defineEventPoint`

推荐 catalog 全部使用 `defineEventPoint`。旧字段 `tier/runtime/mixin` 仍兼容。

### 3.1 `event`：官方已有事件，零补丁

```ts
defineEventPoint({
  id: 'chat/message-logged',
  source: { kind: 'event', event: 'chat/message' },
  map: {
    toEvent: (args) => ({ text: args[0] }),
  },
})
```

- 只发 `{id}`；
- 不能声明 `requires: 'mutate' | 'replace'`；
- 不能写 `map.applyEvent`。

### 3.2 `view`：只包消费方视图

```ts
defineEventPoint({
  id: 'chat/message-from-consumer',
  requires: 'mutate',
  source: { kind: 'view', service: 'chat', method: '_processMessage' },
})
```

- 通过官方 `internal/get` waterfall；
- 只拦插件 fiber 里的 `ctx.chat._processMessage(...)`；
- 拦不住官方插件内部自调用。

### 3.3 `service`：服务原型方法

```ts
defineEventPoint({
  id: 'chat/message',
  requires: 'mutate',
  source: { kind: 'service', service: 'chat', method: '_processMessage' },
})
```

- `internal/service` + 原型快照；
- 与加载顺序无关；
- 能拦截官方插件内部 `this._processMessage(...)`。

### 3.4 `mixin`：运行期 Mixin

```ts
defineEventPoint({
  id: 'agent/presets/recompose',
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
})
```

- `functionName/expressionName` 自动路由到 module-mixin 事件层；
- 其他查询路由到 runtime-mixin 快照/恢复；
- 同一 `(holder, key)` 被第二个第三方 mixin patch 时直接抛错。

---

## 4. `defineCatalog`

```ts
import { defineCatalog } from 'dsh-neoforge'

export default defineCatalog({
  plugin: '@deepseek-ai/dsh-agent',
  versionRange: '>=0.0.0-0',
  points: [
    /* defineEventPoint(...) */
  ],
})
```

定义期校验：

- point id 必须为 `namespace/action` 风格；
- duplicate point id / duplicate mixin id 抛错；
- operation 与 `requires` 组合不合法时抛错：

| operation | 允许的 requires |
|---|---|
| `before` | `observe`, `mutate` |
| `after` | `observe`, `mutate`, `replace` |
| `around` | `mutate`, `replace` |
| `replace` | `replace` |

---

## 5. 装配与事件消费

### 5.1 `createNeoForge`

```ts
import { createNeoForge } from 'dsh-neoforge'
import agentCatalog from './catalogs/agent.ts'

await ctx.plugin(createNeoForge(agentCatalog))
```

也接受裸声明：

```ts
await ctx.plugin(createNeoForge([point]))
await ctx.plugin(createNeoForge([mixin]))   // 自动派生事件点
```

`RegisterOptions`：

```ts
await ctx.plugin(createNeoForge(catalog, {
  mixin: {
    resolveModule: (specifier) => exportsObject, // 自定义模块解析
    readVersion: (module) => '1.2.0',            // 版本漂移诊断
  },
}))
```

### 5.2 下游监听

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/presets/recompose'(event: NeoForgeEvent<{ to: string }>): void
    'agent/presets/recompose/before'(event: NeoForgeEvent<{ to: string }>): void
  }
}

export const inject = ['neoforge']

export function apply(ctx) {
  // 官方事件注册方式；fiber 卸载自动回收
  ctx.on('agent/presets/recompose/before', (event) => {
    event.payload.to = 'code'
  })
  ctx.on('agent/presets/recompose', (event) => {
    console.log(event.result)
  })
}
```

`ctx.neoforge` 语法糖（仍是 `ctx.on`）：

```ts
ctx.neoforge.on(name, listener, options?)
ctx.neoforge.once(name, listener, options?)
ctx.neoforge.emit(name, event)
ctx.neoforge.bail(name, event)
```

### 5.3 事件对象

```ts
interface NeoForgeEvent<TPayload = Record<string, unknown>> {
  point: string
  mixin?: string
  service?: string
  method?: string
  args: unknown[]
  payload?: TPayload
  result?: unknown
  self?: unknown
  moduleVersion?: string
  veto?: boolean       // around 专用
  invoke?: () => unknown // replace 专用
}
```

operation → 阶段映射：

| operation | `{id}/before` | `{id}` |
|---|---|---|
| `before` | 可改 `args` | 无 |
| `after` | 无 | 可改 `result` 并回流 |
| `around` | 可改 `args`，可 `veto` | settle 后携带 `result` |
| `replace` | 完全接管，`invoke()` 委托原函数 | 无 |

---

## 6. `ctx.neoforge` 服务

```ts
const neo = getNeoForge(ctx)
neo.register(catalog, options)
neo.registerMixin(mixin, handler, options)
neo.status()
neo.on(...) / once(...) / emit(...) / bail(...)
```

### 6.1 裸 Mixin 注册

```ts
ctx.neoforge.registerMixin(mixin, (call, invoke) => {
  // call: { arguments, self, result? }
  call.arguments[0] = String(call.arguments[0]).toUpperCase()
})
```

- 不经过事件总线；
- 是 fiber effect，卸载恢复快照；
- `missing/unavailable` 立即抛错，`pending` 告警后等待后续解析。

### 6.2 诊断

```ts
const status = getNeoForgeStatus(ctx)
```

每条记录：

```ts
{
  catalog: string
  point: string
  tier: number
  source: PointSource
  kind: 'event' | 'view' | 'service' | 'mixin'
  backend: string
  status: 'bound' | 'pending' | 'missing' | 'opted-out'
        | 'unavailable' | 'stale' | 'denied'
  reason?: string
  operation?: MixinOperation
  downgraded?: boolean
}
```

| status | 含义 |
|---|---|
| `bound` | 已解析并 patch |
| `pending` | 目标尚未出现；等待 `internal/service`、module event 或 `status()` 重试 |
| `missing` | 目标已加载但函数/版本不匹配 |
| `opted-out` | 官方插件声明 `Symbol.for('dsh-neoforge.optout')` |
| `unavailable` | ESM named export / `#private` / `astQuery` / 目标描述符不可写 |
| `stale` | 模块版本已漂移 |
| `denied` | 宿主 policy 拒绝 |

### 6.3 Host policy

```ts
const governed = ctx.intercept('neoforge', {
  deny: ['vendor/unsafe-point'],
  allowMutate: false,
})
await governed.plugin(createNeoForge(catalog))
```

- `deny`：完全不绑定；
- `allowMutate: false`：`mutate/replace` 点降级为观察；before 收到浅拷贝，写回无效。

---

## 7. 模块级函数：自定义事件层

`functionName/expressionName` 的 mixin 自动走 `module-mixin`，消费：

```ts
MODULE_EVENTS.load   // 'neoforge/module/load'
MODULE_EVENTS.reload // 'neoforge/module/reload'
MODULE_EVENTS.unload // 'neoforge/module/unload'
```

宿主/loader 发布模块生命周期：

```ts
import { trackModule, reloadModule, untrackModule } from 'dsh-neoforge'

trackModule(ctx, {
  id: '@pkg/lib/index.js',
  module: '@pkg',
  filePath: 'lib/index.js',
  exports: cjsExports,
  version: '1.2.0',
})

reloadModule(ctx, { ...record, exports: freshExports })
untrackModule(ctx, '@pkg/lib/index.js')
```

reload 是同步语义：返回时旧 holder 已恢复、新 holder 已 patch。

---

## 8. WebUI / TUI 跨树

### 8.1 Host relay

```ts
import { createNeoForgeRelay } from 'dsh-neoforge'

ctx.plugin(createNeoForgeRelay({
  path: '/neoforge/snapshot',
  points: ['agent/presets/recompose'],
}))
```

- 软探测 `ctx.get('webServer', false)`；
- webserver 后到经 `internal/service` 补挂；
- 每个 point 发布最新 observe 事件。

### 8.2 Browser client

```ts
import { createNeoForgeClient } from 'dsh-neoforge/client'

ctx.plugin(createNeoForgeClient({
  route: '/neoforge/snapshot',
  points: ['agent/presets/recompose'],
  interval: 1500,
  immediate: true,
}))
```

- `interval: 0` 表示只拉一次；
- `points` 过滤快照事件；
- `fetch` 可注入；
- 文件零 Node builtin。

---

## 9. 统一 UI：`dsh-neoforge/ui`

### 9.1 vnode

```ts
import { h, Fragment } from 'dsh-neoforge/ui'

const view = h('view', { direction: 'column' }, [
  h('text', { value: 'hello' }),
  h('button', { label: 'Go' }),
  h(Fragment, null, [
    h('text', { value: 'a' }),
    h('text', { value: 'b' }),
  ]),
])
```

统一 vnode，不在 catalog 层写 React/Ink/RN JSX。

### 9.2 state

```ts
const store = ctx.ui.state({
  id: 'feed',
  init: () => ({ items: [] }),
  actions: {
    push(draft, item) { draft.items.push(item) },
  },
})

store.getSnapshot()
store.subscribe(listener)
store.select((s) => s.items, listener)
store.actions.push({ id: 1 })
```

### 9.3 四层结构

```ts
ctx.ui.page({ id: 'workspace', title: 'Workspace' })
ctx.ui.layer({ id: 'webui', kind: 'react-dom' })
ctx.ui.layer({ id: 'tui', kind: 'ink' })

ctx.ui.slot({ id: 'workspace.sidebar', page: 'workspace' })
ctx.ui.component({
  id: 'feed-panel',
  slot: 'workspace.sidebar',
  title: 'Feed',
  state: store,
  render: (h, props) => h('view', { direction: 'column', ...props }, [
    h('text', { value: `items: ${store.getSnapshot().items.length}` }),
    h('button', { label: 'Refresh' }),
  ]),
})
```

- `renderers` 可给每个 layer 单独渲染器；
- 迟到 layer/slot 会自动 reconcile；
- layer gone / 插件卸载自动 dispose。

### 9.4 Adapters

```ts
import { createUiKit, webuiSlotsAdapter, tuiPanelAdapter } from 'dsh-neoforge/ui'

ctx.plugin(createUiKit({
  adapters: [
    webuiSlotsAdapter({ createElement: React.createElement }),
    tuiPanelAdapter(),
  ],
}))
```

`webuiSlotsAdapter`：

- `service` 默认 `'slots'`；
- 把 vnode 转成 React 组件，注册 `{ name, title, component }`。

`tuiPanelAdapter`：

- `service` 默认 `'tui'`；
- 把 vnode 投影为 `string[]`，注册 `registerPanel({ id, title, lines })`。

自定义 surface：

```ts
const guiAdapter: SurfaceAdapter = {
  layer: 'gui',
  service: 'guiRegistry',
  mount(ctx, desc, slot, surface) {
    return surface.register({ name: slot?.id, component: desc.render })
  },
}
```

---

## 11. HMR

| 对象 | HMR 行为 |
|---|---|
| 下游 `ctx.on` | 官方 fiber effect，自动回收 |
| catalog 插件 | `ctx.effect` 卸载恢复，重载重新注册 |
| view/service | `internal/service` 同步代际交接 |
| service 类 mixin | `internal/service` 同步代际交接 |
| 模块级 CJS mixin | 由 `neoforge/module/reload` 驱动；或 `status()` 重解析 |
| relay/client | timer、route、listener 均为 fiber effect |

---

## 12. 冲突策略

- runtime mixin 的 `(holder, key)` 全局独占；
- 第二个第三方包 patch 同一目标时注册抛错：

```text
neoforge: runtime mixin "b" conflicts with "a" on Object.helper —
a runtime patch target is exclusive...
```

- 同 id + 同 owner 视为 HMR/重放；
- 卸载恢复后独占释放，可重新注册。

---

## 13. 契约测试

```ts
import { contractSuite } from 'dsh-neoforge'
import { officialChat } from './official-chat.ts'
import chatCatalog from './catalog.ts'

contractSuite(chatCatalog, {
  async install(ctx) {
    await ctx.plugin(officialChat)
  },
  invoke(point, ctx) {
    ctx.get('chat').send('contract')
  },
})
```

每个 catalog 应附带一个 harness；运行期 tier 点必须 `bound` 且 observe 事件恰好一次。mixin 点由 `test/runtime-mixin.test.ts` 等价套件或真实目标测试覆盖。

---

## 14. 从 dsh-forge 迁移

可自动迁移：

```sh
pnpm run migrate:neoforge
# 或先 dry-run：
node scripts/migrate-dsh-neoforge.mjs --dry-run
```

AI agent 可调用 `skills/dsh-neoforge-migrate/SKILL.md` 完成带校验的迁移。

| 旧 | 新 |
|---|---|
| package `dsh-forge` | package `dsh-neoforge` |
| `createForge` | `createNeoForge` |
| `getForge` | `getNeoForge` |
| `getForgeStatus` | `getNeoForgeStatus` |
| `ForgeService` | `NeoForgeService` |
| `ForgeEvent` | `NeoForgeEvent` |
| `ctx.forge` | `ctx.neoforge` |
| `ctx.intercept('forge', …)` | `ctx.intercept('neoforge', …)` |
| `createForgeRelay` / `createForgeClient` | `createNeoForgeRelay` / `createNeoForgeClient` |
| `forge/module/*` | `neoforge/module/*` |
| `/forge/snapshot` | `/neoforge/snapshot` |

旧 catalog 的 `tier/runtime/mixin` 字段仍然可用，会被 normalize 成语义 `source`。

---

## 15. 最小端到端示例

```ts
// catalog.ts
import { defineCatalog, defineEventPoint } from 'dsh-neoforge'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'chat/message'(event: NeoForgeEvent<{ text: string }>): void
    'chat/message/before'(event: NeoForgeEvent<{ text: string }>): void
  }
}

export default defineCatalog({
  plugin: 'official-chat',
  versionRange: '^1.0.0',
  points: [
    defineEventPoint({
      id: 'chat/message',
      requires: 'mutate',
      source: { kind: 'service', service: 'chat', method: '_processMessage' },
      map: {
        toEvent: (args) => ({ text: args[0] }),
        applyEvent: (payload, args) => { args[0] = payload.text },
      },
    }),
  ],
})
```

```ts
// host
import { createNeoForge } from 'dsh-neoforge'
import chatCatalog from './catalog.ts'

await ctx.plugin(createNeoForge(chatCatalog))
```

```ts
// consumer
export const inject = ['neoforge']

export function apply(ctx) {
  ctx.on('chat/message/before', (event) => {
    event.payload.text = event.payload.text.toUpperCase()
  })
  ctx.on('chat/message', (event) => {
    console.log(event.result)
  })
}
```

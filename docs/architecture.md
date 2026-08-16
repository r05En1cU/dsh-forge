# dsh-neoforge 架构：Advice 原语 + 语义 source + 运行期快照/恢复

> 目标：让 DSH 社区插件开发者以最低学习成本、最小破坏性更新冲击开发插件；
> 拦截逻辑默认运行期完成，官方已有 seam 时优先复用 seam。

## 1. 分层

```
┌──────────────────────────────────────────────────────────┐
│ 消费层：社区插件                                           │
│   ctx.on('vendor/action', handler)                        │
│   ctx.neoforge.on(...) 语法糖（1:1 委托 ctx.on）              │
├──────────────────────────────────────────────────────────┤
│ 标准 API 层（dsh-neoforge，本仓库）                           │
│   defineMixin       —— 可选 mixin 子层声明                 │
│   defineEventPoint  —— 语义 source → 稳定事件契约          │
│   defineCatalog     —— 每个官方包一份版本化 catalog         │
│   NeoForgeService      —— 注册、诊断、host policy             │
├──────────────────────────────────────────────────────────┤
│ Advice 层（唯一操作原语）                                   │
│   before/after/around/replace 全部投影为 around(proceed)    │
├───────────────────────────┬──────────────────────────────┤
│ source 后端选择             │                              │
│ event  → 官方事件别名      │ runtime-mixin（默认 mixin）     │
│ view   → internal/get      │   resolve → descriptor 快照    │
│ service→ internal/service  │   → wrapper → 恢复             │
└───────────────────────────┴──────────────────────────────┘
│ Cordis 内核（事件、fiber、reflect、loader HMR）             │
└──────────────────────────────────────────────────────────┘
```

## 2. Advice：唯一拦截原语

```ts
type OperationPhases = {
  before?(call): void
  after?(call): unknown
  around?(call, proceed): unknown
}
```

`dispatchOperation()` 是唯一 operation switch，事件路径和裸 `ctx.mixinLayer.register` 路径都编译为 phases：

- `before` → `phases.before` → `proceed`
- `after` → `proceed` → settle → `phases.after`
- `around` / `replace` → `phases.around(call, proceed)`

收益：async settle、host policy、payload 映射、`veto/invoke` 只实现一次；runtime-mixin 只负责“解析 + 快照 + 包装”。

## 3. 语义 source

catalog 声明意图，后端自动选择：

```ts
source:
  | { kind: 'event'; event: string }                          // 官方事件，零补丁
  | { kind: 'view'; service; method }                         // 消费方视图
  | { kind: 'service'; service; method }                      // 服务原型
  | { kind: 'mixin'; target; operation }                       // 运行期 mixin
```

旧 `tier/runtime/mixin` 字段在 `defineInjectionPoint()` 中 normalize 为 source，现有 catalog 不迁移也能跑。

## 4. 运行期 Mixin

### 4.1 解析

1. catalog 注册时；
2. 官方 `internal/service` 事件（service 类晚于 neoforge 加载时）；
3. `ctx.neoforge.status()` 的 `verify()`（模块晚于 neoforge import 时）。

解析规则：

- `functionName/expressionName`：CJS exports 属性；
- `className + methodName`：导出 class 的 prototype（或 static）；
- `methodName`：唯一同名方法，多匹配要求 `className`；
- ESM class export 可 patch prototype；ESM named export、`#private`、`astQuery` 返回 `unavailable`。

### 4.2 快照

```ts
const desc = Object.getOwnPropertyDescriptor(holder, key)
```

wrapper 标记 `Symbol.for('dsh-neoforge.patched')`，携带 `{ id, owner, original, holder, key }`。

### 4.3 修改后运行

```ts
Object.defineProperty(holder, key, { ...desc, value: wrapper })
```

### 4.4 恢复与独占

- 卸载时恢复旧 descriptor。
- **同一 `(holder, key)` 运行期全局独占**：第二个第三方包 patch 同一目标直接 loud error，不隐式链式叠加。
- 同 mixin id + 同 owner 的重注册视为 HMR/重放；卸载后独占释放，可再次注册。

HMR 分级：

- service 类目标：`internal/service` 同步代际交接，新类 prototype 自动补丁；
- 模块级函数目标：由 `neoforge/module/load|reload|unload` 自定义事件层驱动；宿主发布 reload 后同一同步调用内退役旧 holder、patch 新 holder；
- 无发布者的模块级 CJS 目标：`status()/verify()` 重新解析作为兜底；
- ESM named export / `#private` / 闭包：运行期不可达；应改用官方事件、service seam 或让模块暴露可变句柄。

## 5. 关键决策

- **不另造事件发射器**：事件总线就是 `ctx.bail/emit/on`，HMR 回收、context 过滤、isolate 语义免费复用。
- **seam-first**：审核顺序固定为官方事件 → 官方服务 → view → mixin。
- **能力显式**：`requires: 'observe' | 'mutate' | 'replace'`；宿主 `ctx.intercept('neoforge', { allowMutate: false })` 降级为只读。
- **drift 响亮**：版本漂移报 `missing/stale`；运行期不可达目标报 `unavailable`，不静默。

## 6. 目录

```
src/
  advice.ts          OperationPhases + dispatchOperation（唯一操作原语）
  version.ts         satisfies：保守 semver 漂移诊断
  mixin.ts           dsh-neoforge/mixin 子层入口 / createMixinLayer
  registry.ts        defineEventPoint / defineCatalog / source normalize
  service.ts         NeoForgeService：source → backend registry、诊断
  dispatch.ts        事件构造 + tier 1/2 的 dispatchCall
  backends/
    event-alias.ts   event source
    getview.ts       view source
    prototype.ts     service source
    runtime-mixin.ts class/service mixin：resolve + 快照 + wrapper + 独占冲突
    module-mixin.ts  functionName/expressionName mixin：消费模块生命周期事件
  module-events.ts   neoforge/module/load|reload|unload 自定义事件层
  relay.ts           host 侧 webserver 快照路由（WebUI relay）
  client.ts          dsh-neoforge/client：浏览器安全轮询/re-emit
  ui/                dsh-neoforge/ui：page/layer/slot/component + state + adapters
  testkit.ts         contractSuite
test/
  neoforge.test.ts             tier 1/2、HMR、policy、registry、stub 编译
  runtime-mixin.test.ts     运行期 mixin、冲突 loud error、语义 source
```

## 7. UI 侧

- `dsh-neoforge/ui` 提供渲染无关的 page → layer → slot → component 结构与 state seat；
- 组件返回统一 vnode，adapter 分别映射 React（WebUI）、Ink/文本（TUI）、React Native（GUI）；
- webui adapter 通过 `ctx.slots` 注册实际 React 组件，tui adapter 投影文本 panel；
- 跨树事件由 `relay + client` 负责，状态由 `ctx.ui.state` 承载；
- 所有注册是 fiber effect，HMR 自动回收。

## 8. 非目标

- 不提供 `@SubscribeEvent` 装饰器：`ctx.on` 是官方方式。
- 不镜像 `ctx.slots` / `ctx.tools` 等已有官方注册面。
- 浏览器端运行期注入不在本层范围；优先使用 `dsh-neoforge/ui` + 官方 `ctx.slots`。

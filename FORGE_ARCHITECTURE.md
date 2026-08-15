# DSH-Forge：Cordis 生态"类 Forge"插件中间件架构技术方案

> 版本：v1.0（2026-08-15）
> 验证环境：Node.js v24.16.0，`@deepseek-ai/cordis@4.0.1`（随包附完整 TS 源码，`node_modules/@deepseek-ai/cordis/src/`）
> 配套验证代码：`research/poc.mjs`（22 项断言全部通过，可直接 `node poc.mjs` 复现）

---

## 0. 结论摘要（TL;DR）

1. **不需要、也不应该劫持 `Context.prototype.set`**。Cordis v4 中服务注册走 `ctx.provide()` → `ReflectService.provide()`，`ctx.set` 只是"已注册服务的覆写接口"且仅限提供方 fiber 调用。你们参考思路里的"劫持 set"在 v4 架构下拦截不到任何注册行为。
2. **Cordis 已内置我们需要的两个官方钩子**（这是本次源码核查最重要的发现）：
   - `internal/service` 事件：任何服务注册/注销/fiber 激活状态切换时触发 —— 天然**与加载顺序无关**；
   - `internal/get` waterfall：拦截消费方对服务的属性式读取 —— 可用于按需 Proxy 包装。
3. **推荐组合策略：原型链补丁（Prototype Patching）为主，`internal/get` + 实例 Proxy 为辅**。只有原型补丁能拦截官方插件内部的 `this._privateMethod()` 自调用（实例 Proxy 拦不住，PoC 场景 F 已证实）。
4. **下游开发者体验完全达标**：`ctx.on('official-chat/message', handler)`，对底层 Mixin 零感知。
5. 生态中已有一个高度相似的早期项目 `cordis-fabric`（GitHub: omdsh-dev/fabric），命名上建议避开 `cordis-fabric*`；`cordis-mixin`/`cordis-proxy`/`cordis-bridge` 在 npm 均未被占用。

---

## 1. 验证报告：Cordis 源码核查结论

### 1.1 服务注册的真实路径：`provide`，不是 `set`

`Service` 基类构造函数（`src/service.ts:57`）：

```ts
self.ctx.reflect.provide(name, self, this[symbols.check])
```

`ReflectService.provide`（`src/reflect.ts:277-305`）：把 `{ name, value, fiber, check }` 写入 root reflect 的 `store[isolateLabel]`，重复注册直接抛错；返回的 disposer 负责注销并 `notify()`。

`ctx.set`（`src/reflect.ts:254-265`）只是覆写已存在的 `impl.value`，且有硬限制：

```ts
if (impl.fiber !== this.ctx.fiber) {
  throw new Error(`cannot set property "${name}" in multiple fibers`)
}
```

**结论**：第三方 fiber 根本无法 `ctx.set` 别人的服务；"劫持 `Context.prototype.set` 等官方注册"这条路在 v4 下不成立。而且所有 `Context` 实例本身就是 `Proxy`（`src/context.ts:74`），方法经由 accessor mixin 转发，劫持原型方法的意义也有限。

### 1.2 `internal/service`：官方提供的"服务注册事件"（顺序无关的关键）

`provide()` 注销时和 fiber 激活状态切换时都会走到 `ReflectService.notify()`（`src/reflect.ts:330-336`）：

```ts
for (const name of names) {
  const self: Context = Object.create(this.ctx)
  self[symbols.filter] = (target: Context) => filter(target, name)
  this.ctx.events.emit(self, 'internal/service', name, this._getImpl(name, false)?.value)
}
```

触发时机（三处，均已核实）：
- `provide()` 时（若提供方 fiber 已 ACTIVE，`reflect.ts:294`）；
- 服务注销时（`reflect.ts:299`，此时 `value` 为 `undefined`）；
- **fiber 在 ACTIVE ⇄ 非 ACTIVE 间切换时**，对该 fiber 提供的所有服务重新 notify（`fiber.ts:588-594`）——官方插件热重启/重载后我们的中间件会再次收到通知，可幂等重新介入。

注意事项：
- 事件 `this` 带 `[symbols.filter]`，按 isolate 作用域过滤监听器。中间件与官方服务在同一隔离域（默认情况）时普通 `ctx.on` 即可收到；跨 `ctx.isolate()` 作用域时需 `ctx.on('internal/service', cb, { global: true })`。
- 对"我们先加载"的追赶场景，`ctx.get(name, false)`（非 strict）可拿到已注册服务，无需事件。

**这直接满足"不依赖加载顺序"的约束，且是官方事件而非私有 hack。**

### 1.3 `internal/get` / `internal/set` waterfall：服务读写的洋葱模型拦截

Context 代理的 get 陷阱（`src/reflect.ts:153`）在服务属性读取时派发：

```ts
return ctx.events.waterfall('internal/get', ctx, prop, error, () => { ... })
```

监听器签名 `(ctx, name, error, next)`，包装 `next()` 的返回值即可替换消费方拿到的服务实例。两个重要边界（PoC 场景 F 实测）：

- **仅对声明了 `inject` 的插件 fiber 的属性式访问（`ctx.chat`）生效**；root 上下文直接走 `reflect.get()` 短路（`reflect.ts:152`：`if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)`），`ctx.get()` 方法调用也不经过 waterfall；
- **拦截不到官方插件的内部自调用**，除非调用恰好经由消费方的 traceable receiver 回流（Cordis 的 `createTraceable`/`createShadowMethod` 会把 `this` 重绑定到消费方代理上，`src/utils.ts:156-163`）——这不可靠，官方插件用裸 `this`（定时器回调、构造时保存的引用等）触发内部方法时 Proxy 完全绕过。

### 1.4 为什么原型补丁能拦住内部自调用

官方插件内部 `this._processMessage(...)` 的属性查找走实例的原型链。补丁 `ServiceClass.prototype._processMessage` 后，无论调用方是外部消费者、traceable shadow、还是插件自己的裸 `this`，都会命中包装函数。这是实例 Proxy 在语义上无法替代的（除非替换 `impl.value` 本身，而 `ctx.set` 又禁止跨 fiber 写）。

### 1.5 `ctx.effect()` 的 cleanup 机制

`fiber.effect()`（`src/fiber.ts:418` 起）：同步执行 effect 体，收集其返回/迭代产生的 disposer，fiber 卸载时**逆序**执行；返回的 disposer 幂等（重复调用 no-op）且可 await。我们的原型恢复逻辑作为 disposer 注册后，中间件插件卸载（或配置更新重载）时自动执行——PoC 场景 C 验证了恢复后 descriptor 与原始 descriptor 逐字段一致。

### 1.6 其他核查点

- **热替换**：服务不支持平滑热替换。`provide` 重复注册抛错；注销再注册会触发依赖方 fiber 重载。下游持有的是 `impl.value` 的 traceable 包装，替换后旧引用**不失效**（仍指向旧实例）——所以我们不做"实例替换"，只做"原地原型补丁"，无此问题。
- **`instanceof` 兼容**：`Service` 重写了 `Symbol.hasInstance`（`service.ts:104-114`），沿 constructor 链步行且容忍代理；原型补丁不触碰 constructor/原型链结构，`instanceof`、`service.name`、`service.ctx` 全部保留（PoC 场景 A 断言）。
- **元数据标记**：Cordis 自身用 `Symbol.for('cordis.*')` 全局符号（`utils.ts:50-73`）。我们应沿用同一约定（`Symbol.for('dsh-forge.patched')`），跨包副本也能互相识别，避免重复/循环包装。
- **已有机制避免重复造轮子**：`ctx.mixin()` 是"把服务方法转发到 ctx"，不是行为混入，不能用于拦截；`ctx.intercept()` 是服务配置拦截，与方法级介入无关。真正可复用的就是 1.2/1.3 的两组 `internal/*` 钩子。

---

## 2. 推荐架构

```
┌─────────────────────────────────────────────────────────┐
│ 上层：社区插件                                             │
│   ctx.on('official-chat/message', handler)               │
│   —— 标准 Cordis 事件，对底层零感知                         │
├─────────────────────────────────────────────────────────┤
│ 中层：dsh-forge（本方案）                                  │
│   InjectionPoint 注册表 → 原型补丁 → 事件转译器             │
│   检测：ctx.get(name,false) 追赶 + internal/service 监听   │
│   生命周期：ctx.effect() 托管全部恢复逻辑                    │
├─────────────────────────────────────────────────────────┤
│ 底层：官方插件（源码零改动）                                 │
│   ChatService.prototype._processMessage ← 被包装          │
├─────────────────────────────────────────────────────────┤
│ Cordis 内核（零改动）                                      │
│   provide / notify / internal/service / internal/get      │
└─────────────────────────────────────────────────────────┘
```

### 策略选型对比（均有 PoC 验证）

| 策略 | 拦内部自调用 | 顺序无关 | 可回滚 | 结论 |
|---|---|---|---|---|
| 劫持 `Context.prototype.set` | — | ✗（注册根本不走 set） | — | **排除** |
| 实例 Proxy（`internal/get` 包装） | ✗（裸 this 绕过） | ✓ | ✓（随 listener 注销） | **辅助**：适合"只包装消费方视图"的场景 |
| **原型链补丁** | **✓** | ✓（配合 `internal/service`） | ✓（`ctx.effect` + 描述符恢复） | **主力** |
| `ReflectService.prototype.provide` 全局劫持 | ✓ | ✓ | 差（无 fiber 生命周期托管） | 不必要，`internal/service` 已够用 |

### 核心代码骨架（TypeScript）

```ts
import type { Context } from '@deepseek-ai/cordis'

const kOriginal = Symbol.for('cordis.original')      // cordis traceable 解包符号
const kPatched = Symbol.for('dsh-forge.patched')     // 全局幂等标记（跨包副本可识别）

/** 一个注入点的声明：把 service 的某个私有方法转译为事件 */
export interface InjectionPoint {
  service: string            // 官方服务名，如 'chat'
  method: string             // 私有方法名，如 '_processMessage'
  event: string              // 事件名前缀，如 'official-chat/message'
  mode?: 'observe' | 'around' // observe=仅通知; around=可改参/短路
}

interface PatchEntry {
  wrapper: Function
  state: { active: boolean }
  desc: PropertyDescriptor   // 原始描述符，恢复用
}

export function createForge(points: InjectionPoint[]) {
  // 注意：cleanup 需要遍历，不能用 WeakMap（不可迭代）
  const patched = new Map<object, Map<string, PatchEntry>>()

  const unwrap = (v: any) => v?.[kOriginal] ?? v

  function patchInstance(serviceName: string, value: any, ctx: Context) {
    const raw = unwrap(value)
    const proto = raw && Object.getPrototypeOf(raw)
    if (!proto || proto === Object.prototype) return
    let table = patched.get(proto)
    if (!table) patched.set(proto, (table = new Map()))

    for (const p of points) {
      if (p.service !== serviceName || table.has(p.method)) continue
      const desc = Object.getOwnPropertyDescriptor(proto, p.method)
      // —— graceful degradation：官方升级改了签名/删了方法，告警并跳过 ——
      if (!desc || typeof desc.value !== 'function') {
        ctx.logger('dsh-forge').warn(
          `${p.service}.${p.method} 不存在或不可包装（官方版本漂移？），注入点 ${p.event} 已跳过`)
        continue
      }
      const orig = desc.value
      const state = { active: true }
      const wrapper = function (this: any, ...args: any[]) {
        if (!state.active) return orig.apply(this, args)  // 中间层已卸载：透传
        const ctx: Context | undefined = this.ctx          // 用服务自己的 ctx 派发事件
        if (!ctx) return orig.apply(this, args)
        const event = { service: p.service, method: p.method, args, result: undefined as any }
        ctx.bail(`${p.event}/before`, event)               // 可变更 event.args
        event.result = orig.apply(this, event.args)
        ctx.emit(p.event, event)                           // 裸 id = 观察事件（settle 后）
        return event.result
      }
      Object.defineProperty(proto, p.method, { ...desc, value: wrapper })
      table.set(p.method, { wrapper, state, desc })
    }
  }

  return {
    name: 'dsh-forge',
    // 故意不声明 inject：必须保证无论官方服务是否存在我们都能加载
    apply(ctx: Context) {
      // 情形 1：官方服务已注册（我们先到）—— 直接追赶
      for (const name of new Set(points.map(p => p.service))) {
        const existing = ctx.get(name, false)
        if (existing) patchInstance(name, existing, ctx)
      }
      // 情形 2：官方服务后注册 / 热重启 —— 官方事件钩子，顺序无关
      ctx.on('internal/service', (name, value) => {
        if (value) patchInstance(name, value, ctx)   // value === undefined 表示注销，无需处理
      })
      // 生命周期托管：卸载时精确恢复
      ctx.effect(() => () => {
        for (const [proto, table] of patched) {
          for (const [method, entry] of table) {
            const current = Object.getOwnPropertyDescriptor(proto, method)
            if (current?.value === entry.wrapper) {
              Object.defineProperty(proto, method, entry.desc) // 我们在链顶：直接恢复
            } else {
              entry.state.active = false // 上方还有别的中间件：转为透传（见 §4.3）
            }
          }
        }
        patched.clear()
      }, 'dsh-forge:restore')
    },
  }
}
```

---

## 3. 完整 PoC：拦截 `official-chat._processMessage`

以下是从 `research/poc.mjs` 提炼的最小完整示例（全部经实跑验证）：

```ts
import { Context, Service } from '@deepseek-ai/cordis'

// ===== 假设的官方插件（我们不改它一行代码）=====
class ChatService extends Service {
  constructor(ctx: Context) { super(ctx, 'chat') }
  send(text: string) {
    return this._processMessage(text)   // 内部自调用
  }
  _processMessage(text: string) {
    return `[official] ${text}`
  }
}
const officialChat = {
  name: 'official-chat',
  apply(ctx: Context) { new ChatService(ctx) },
}

// ===== 我们的中间件 =====
const forge = createForge([{
  service: 'chat',
  method: '_processMessage',
  event: 'official-chat/message',
}])

// ===== 下游社区开发者：完全标准的事件接口 =====
const communityPlugin = {
  name: 'community-censor',
  apply(ctx: Context) {
    ctx.on('official-chat/message/before', (e) => {
      e.args[0] = e.args[0].replace(/敏感词/g, '***')  // 可改参
    })
    ctx.on('official-chat/message', (e) => {           // 裸 id = 观察事件
      ctx.logger('censor').info('processed:', e.result)
    })
  },
}

// ===== 装配（任意顺序！）=====
const ctx = new Context()
await ctx.plugin(forge)           // 中间件先加载……
await ctx.plugin(communityPlugin)
await ctx.plugin(officialChat)    // ……官方插件后到也能被拦截
ctx.get('chat').send('含敏感词的消息')
// → before 事件改参 → 原方法执行 → after 事件
// → 输出: processed: [official] 含***的消息
```

实测覆盖的八个场景（`research/poc.mjs`，22 项断言全绿）：

| 场景 | 验证点 | 结果 |
|---|---|---|
| A | 中间件先加载，官方后注册，内部自调用被拦截、事件可改参 | ✓ |
| B | 官方先注册，`ctx.get(name,false)` 追赶补丁 | ✓ |
| C | `fiber.dispose()` 后 descriptor 逐字段恢复、事件停发、服务正常 | ✓ |
| D | 双中间件链式包装；**先卸载底层**后上层仍工作；全卸后恢复原实现 | ✓ |
| E | 方法名因官方升级漂移 → 告警跳过、不崩溃、服务不受影响 | ✓ |
| F | 实例 Proxy 拦外部调用 ✓、拦不住裸 this 内部调用 ✓（选型证据） | ✓ |
| G | 官方 fiber `restart()` 后事件恰好一次（幂等防重复包装） | ✓ |
| G2 | 双 root Context 共享类原型：补丁全局生效，事件按服务自身 ctx 路由 | ✓ |
| H | 性能基线（见 §4.2） | ✓ |

---

## 4. 风险清单与缓解方案

### 4.1 版本兼容性（最高优先级风险）

- **风险**：官方插件升级导致 `_processMessage` 改名/改签名/逻辑内联（方法被删掉，逻辑并入调用方）。
- **缓解**：
  - 注入点声明携带 `since`/`until` 版本范围，中间件读取 `impl.fiber.runtime` 或官方插件 `package.json` 版本做匹配；
  - 方法缺失时告警跳过而非抛错（PoC 场景 E）；
  - 签名漂移无法静态检测——建议在 wrapper 中对 `args.length`、`event.result === undefined` 做健全性检查，异常时降级为纯透传并告警；
  - 为每个注入点维护"契约测试"：CI 里对官方插件的每个新版本跑一遍 PoC 场景 A 的最小断言集。

### 4.2 性能

- **实测**（1e6 次调用，Node 24）：裸调用基线 2168ns（其中大部分是 Cordis 自身的 traceable 代理开销）；打补丁后无监听器 10542ns；2 个监听器 12170ns。**补丁本身引入约 8–10µs/次**，主要来自事件对象构造 + `bail`/`emit` 的 dispatch（listener 过滤、`reflect.bind` 包装）。
- **缓解**：
  - 对超高频方法（>10k 次/秒）不要默认打补丁，采用"懒激活"：wrapper 内先查 `ctx.events._hooks[event]?.length`（下划线字段，属内部 API，需自行兜底），无监听器时直接 `orig.apply` 零分配；
  - 事件对象池化/冻结模板，减少 GC；
  - 在注入点元数据中标注 `hot: true`，文档明确性能预算。

### 4.3 多中间件冲突

- **风险**：多个中间件团体同时包装同一原型方法；卸载顺序与包装顺序不一致时，粗暴恢复会截断调用链或永久丢失原实现。
- **缓解（PoC 场景 D 已验证）**——shimmer 式链式纪律：
  1. 包装时捕获的是"当前描述符"，天然形成调用链；
  2. 卸载时**仅当** `proto[method] === 我的 wrapper` 才直接恢复描述符；否则把自己的 wrapper 标记为 `active: false` 转为纯透传，等上层中间件卸载时自然跳过；
  3. 用 `Symbol.for('dsh-forge.patched')` 在 wrapper 上挂元数据（包装者标识、原始方法引用），任何生态成员都能检查链结构、避免对同一方法做语义冲突的包装；
  4. 治理层面：事件命名空间按团体隔离（`团体A/服务/方法`），注入点注册表公开文档化。
- **注意**：`shimmer` 库本身可直接借用（`wrap/unwrap/massWrap`，unwrap 遇非自身包装时只告警不强拆），但其 unwrap 语义在我们"中层可卸载"的诉求下不如上面的 state 透传方案精确，建议自实现（核心仅 30 行）。

### 4.4 原型补丁的进程级全局性

- **风险**：同一进程中多个 root Context（如测试、多实例宿主）共享服务类原型——补丁对所有 root 生效（PoC 场景 G2）。事件是按服务实例自己的 `ctx` 派发的，所以语义正确；但如果某个 root 是"沙箱隔离"用途，会意外被介入。
- **缓解**：提供 `includeRoots`/`excludeRoots` 配置；wrapper 内检查 `this.ctx.root` 是否在白名单内，否则透传。

### 4.5 官方对策与生态位风险

- **风险**：DSH 官方未来可能提供一等拦截 API（`internal/*` 事件已被列入其公开文档站，属半官方契约；但原型补丁始终是"对私有方法的越权访问"），或官方插件改用闭包私有方法（`#private` 字段、模块内函数）使原型补丁失效。
- **缓解**：
  - `#private` 硬私有字段在 JS 层面无法拦截——这是本方案的**理论边界**，需在文档中明示；目前官方插件普遍使用 `_` 前缀约定（可拦截）；
  - 优先消费官方已暴露的事件与 `internal/*` 钩子，原型补丁只作为兜底；
  - 保持注入点声明与实现分离，官方若提供正规 API 可将转译层整体切换而不影响下游。

### 4.6 异步方法的特殊性

- 若目标方法是 async 且事件需要"完成后通知"，wrapper 必须 `await` 原方法再 emit `after`——这会把同步方法意外变成异步。骨架中按同步处理；对异步目标应在注入点声明 `async: true`，wrapper 返回 `Promise.resolve(orig.apply(...)).then(r => { emit; return r })`，保持原方法的 thenable 契约。

---

## 5. 生态调研摘要

（调研时间 2026-08-15，来源附后）

- **DSH 与 `@deepseek-ai/cordis` 确认存在**：DeepSeek 于 2026-08-13/14 开源 DeepSeek Harness（deepseek.com/harness，GitHub `deepseek-ai/deepseek-harness`），`@deepseek-ai/cordis@4.0.1` 发布于约 2 天前，是 cordis 4.x 的 vendor 副本，随包附带完整 TS 源码与 `docs/cordis-api` 文档。官网明确 "built on Cordis's plugin system"。
- **最接近的先例：`cordis-fabric`**（GitHub `omdsh-dev/fabric`，三包工作区 `cordis-fabric` / `cordis-fabric-api` / `cordis-fabric-dsh`），自述 "The Fabric/Mixin extension layer for DSH"，走加载期变换路线，未发布 npm、需宿主打补丁、处早期。建议：调研其注入点声明格式以谋求兼容；命名避开 `cordis-fabric*`。
- **Koishi 生态无"插件 patch 另一插件 service"先例**：官方认可路径是生命周期事件 + 中间件链 + 同名服务替换。意味着我们这套方案在生态中是首创性实践，需自行承担治理规范（事件命名空间、注入点登记）。
- **可借用库**：`shimmer`（wrap/unwrap，`__wrapped` 标记，OTel/Sentry 同技术栈）、`require-in-the-middle`（模块加载期介入，本方案不需要）、`async_hooks`/`AsyncLocalStorage`（与本方案正交，可用于给事件补充调用链上下文）。
- **npm 命名**：`cordis-mixin`、`cordis-proxy`、`cordis-bridge` 均 404 未占用。

### 5.6 补充：官方 UI 扩展面已存在（2026-08-15 核查）

`@deepseek-ai/dsh-client-ui-slots`（被 `dsh-client-runtime` 依赖）是官方的浏览器端 slot 注册表：`SlotMap` 声明合并（与我们的 `Events` 增强同构）、单次 `register()` 组合 API（组件+子 slot+store seat+业务面）、四种 slot kind（single/list/keyed/chain）、store seat + selector hook 数据供给、账本式生命周期回收、renderer 安装缝（核心零依赖，React 18 实现在 web-react）。**推论**：社区 UI 扩展应基于 `ctx.slots` 写约定而非另起 `ctx.components`；数据供给应走 store seat 而非裸 `ctx.on`（事件适合动作语义，不适合响应式状态）；向官方未留 slot 的位置注入组件才是 tier-3 浏览器变换的合法场景。

### 5.7 补充：webui 层参照实现 better-sidebar（2026-08-15 核查）

`dsh-better-sidebar`（omdsh-dev，与 fabric 同 org，npm 0.12.2）是社区 UI 扩展的生产级实例：挂载走官方 `ctx.slots`（含 `slots.inject('conversation.chat.turnTail')`），安装走官方 bundle 渠道（`cordis.patch.yml` insert，零 patch）；领域扩展暴露 `ctx.betterSidebar` 标准服务（`registerTab`/`registerFileViewer` 返回 disposer、fiber 回收、HMR 干净重注册）；数据交互为 `getSnapshot`/`subscribeState` 订阅 + 命令式方法 + 生命周期回调；能力探测 `version`/`features` 单调递增；内置功能与第三方同一 API（dogfooding）。**定位**：webui 层约定的模板 + forge 事件全链路试点消费者 + M3 合作方。两层模型：`ctx.slots` 管渲染位置，领域服务管领域扩展，不合并。

---

## 5.5 与 `cordis-fabric` 的深度对比（2026-08-15 源码核查）

核查对象：`github.com/omdsh-dev/fabric`（dsh-external/fabric）`main` 分支，三包工作区 `cordis-fabric` / `cordis-fabric-api` / `cordis-fabric-dsh`。

### 机制层面：本质不同

| 维度 | cordis-fabric | 本方案（dsh-forge） |
|---|---|---|
| 介入机制 | **加载期 AST 变换**：`module.registerHooks`（Node ≥22.22.3/24.11.1）/ CJS `_compile` 包装 / 浏览器构建期重写，改写目标函数体向 bridge 通道发布调用记录（Orchestrion-JS / `@apm-js-collab/code-transformer`） | **运行期原型补丁**：`Object.defineProperty(proto, method, …)` |
| 可介入目标 | 模块内**任意函数**：顶层函数、内部闭包（esquery 选择器）、类方法、私有方法、箭头函数、generator；与 Cordis 完全无关 | 仅 Cordis service 原型链上的方法（`_` 前缀约定）；`#private` 硬私有字段不可达 |
| 宿主依赖 | **必须宿主配合**：hooks 须在任何目标模块 import 之前安装；官方 npm 版 dsh 当前无法启用（README 明示需 `patches/fabric-host-integration.patch` 打到 deepseek-harness 源码检出，或等官方合并） | 纯插件，官方 dsh 今天即可用 |
| 卸载语义 | hooks 进程级常驻不可注销；dispose 仅使已变换代码转为透传；真正还原代码需清模块缓存重变换（Node ≥22，且旧 exports 对象仍保留旧变换） | descriptor 逐字段精确恢复（PoC 场景 C 实测） |
| 操作语义 | before / after / around / **replace**（`invoke()` 委托，可完全接管调用） | before（可改参）/ after；around/replace 可在 wrapper 内扩展但非默认 |
| 版本治理 | `versionRange` semver 匹配 + `required: true` 启动期 fail-loud + `ctx.fabric.bindings()` 绑定内省 | 方法缺失告警跳过；契约测试外置 |
| 冲突治理 | patch id 独占、优先级组合、同目标双 `replace` 注册期拒绝 | shimmer 式链式包装 + 透传降级（PoC 场景 D 实测） |

### 价值层面：高度重叠，但生态位不同

用户感知上"差异不大"的判断在**维护者视角**成立——两者都是"不改官方源码介入内部行为 + fiber 生命周期托管"。但有一个结构性差异决定了两者的生态位：

**fabric 是单层工具，forge 是双层生态。** fabric 的消费方就是 patch 作者本人：每个想介入的开发者都要自己写 `module + versionRange + filePath + functionQuery/astQuery` 的目标描述符并处理版本漂移。`cordis-fabric-api` 的 compat 门面提供了 `observe(name, listener)` 的"合作式观察 API"，但目标是**静态配置声明**的，且刻意不暴露 AST 细节——它是"给没有扩展点的领域补一个观察口"，不是面向社区的事件总线。本方案的上层是标准化 Cordis 事件（`ctx.on('official-chat/message')`），注入点由少数维护者维护、绝大多数社区开发者零门槛消费——这正是 Forge 生态中"Forge 团队 vs 模组作者"的分工，fabric 没有对应物。

### 结论与定位建议

1. **不要重复造 fabric 的引擎。** 若官方 dsh 合并了 fabric 的宿主接线，"介入引擎"问题由 fabric 更通用地解决（可打任意函数、支持浏览器），我们的原型补丁仅在"官方 npm 宿主 + 仅拦截 service 方法"的窗口期有独家价值。
2. **我们的护城河是事件标准化层。** 建议将架构明确分层：`注入点注册表 + ctx.on 门面`（核心价值，长期存在）× `拦截后端`（可插拔：今天=原型补丁，未来可选=fabric backend）。
3. **短期共存策略**：检测 `ctx.get('fabric', false)`，若宿主已装 fabric 则同一注入点声明可编译为 fabric patch（`before`→`before`、`after`→`after`），否则回落原型补丁——注入点声明格式应从现在开始就与 fabric 的 `FabricTarget` 保持字段级映射能力。

---

## 6. 落地路线建议

1. **MVP**：按 §2 骨架实现 `dsh-forge-core`（原型补丁 + `internal/service` 检测 + effect 托管恢复），附 `research/poc.mjs` 级别的契约测试套件。
2. **注册表**：为每个官方插件维护一份 `injections.json`（方法名、事件名、适用版本范围、hot 标记），与核心解耦，官方升级时只改声明。
3. **开发者工具**：`dsh-forge list`（列出当前激活的注入点与包装链，读取 `Symbol.for('dsh-forge.patched')` 元数据）用于冲突诊断。
4. **对官方的策略**：公开文档化我们使用的 `internal/*` 钩子（已在其文档站列出，相对稳定），并为原型补丁部分准备降级预案。

---

## 7. 安全模型与信任边界

本层对官方 service 私有方法的介入属于**进程级全权 instrumentation**（与 OpenTelemetry/shimmer 同族），必须按基础设施级安全标准治理：

1. **信任模型**：事件转译 handler 永远是可信代码，永不从 YAML/配置/模型输入反序列化（沿用 cordis-fabric 的既有规则）。
2. **默认只观察**：tier 1/2 注入点默认只发只读事件；改参/短路能力须以 `requires: 'mutate'` 显式声明，注册表 review 单列。
3. **透明可审计**：启动时列出全部激活注入点及其绑定目标（`ctx.get('forge').boundAs`）；提供 `doctor` 诊断命令；注入点的一切降级/跳过行为必须留痕。
4. **合作式 opt-out**：官方插件在 service 类上声明 `static [Symbol.for('dsh-forge.optout')] = true` 即可拒绝被 patch，本层承诺尊重（包装前检查原型链）。这把对抗性介入转为可协商介入，也给官方低成本管控抓手。
5. **供应链**：注册表发布强制签名 + provenance；注入点入库必须附版本钉扎的契约测试。前车之鉴：Minecraft 生态 fractureiser 事件（2023，全信任模组生态被批量投毒）、`koishi-plugin-pinhaofa`（仅靠事件订阅窃听消息）——本层权力严格更大，按"何时被攻破"而非"是否"设计。
6. **多中间件即安全面**：一个中间件可静默绕过另一个中间件的安全检查事件（如内容审查）。链式纪律（§4.3）之外，安全敏感事件应在文档中标注"下游不得假设其必达"。
7. **披露政策**：仓库含 SECURITY.md，注入点被官方版本漂移破坏或被滥用时的响应流程。

### 4.7 HMR 语义（对齐 DSH loader 的串行线）

DSH loader 的插件替换是严格串行事务（`cordis-plugin-loader/src/config/entry.ts` `Entry.update()`）：dispose 旧 fiber → 重导入模块 → start 新 fiber → 失败回滚到上一模块。重导入意味着**服务类对象本身是新的**（新 prototype）。cordis 的 `notify()` 中 `internal/service` 同步派发、dependent fiber 异步重载，因此原型后端的代际交接（退役旧 prototype → 绑定新 prototype）落在同一个同步窗口内，先于任何 dependent 的重载体执行；回滚时旧类被重新投递，自然重新绑定且恰好一次。contract tests：`HMR handover` / `HMR rollback` / `HMR ordering`。

对比：cordis-fabric 的 HMR 靠 hooks 常驻 + 变换代码跨代残留 + ownership transfer 猜测代际（其 docs/fabric.md 明示"旧 exports 对象保留旧变换"），代际语义不如运行时方案干净——这是 tier 2 目标优先用运行时后端的又一论据（§5.0 分层原则的推论）。

**tier 3 目标的 HMR 立场**：loader 的串行线只覆盖 entry tree 里的插件模块，tier 3 目标（深度依赖、库代码）不在任何 HMR 线上。但需区分两种语义——**行为热更新**可以接：fabric 烘焙的只是 dispatch stub，handler 运行期经 bridge 分发，挂/卸 = `register`/`remove`，天然是 fiber effect，与运行时后端同一纪律（不同机制）；**变换覆盖面新鲜度**运行期无法修复（重求值需清整条 importer 链缓存且旧 namespace 已散播），立场是"检测陈旧、响亮降级"而非伪造模块级 HMR：`verify()` 复核 bridge 注册与 `versionRange`，漂移即 `stale`（contract tests：`tier 3: version drift…` / `…losing the bridge registration…`）。

### 附：验证环境复现

```bash
cd research
npm install   # 已安装 @deepseek-ai/cordis@4.0.1
node poc.mjs  # 8 场景 22 断言
```


### 附 2：M1 实现状态（2026-08-15）

本方案已落地为可用包 `dsh-forge`（仓库根：`src/` + `test/forge.test.ts`）：

- 门面为**标准 Cordis 服务** `ForgeService`（`ctx.forge`）：catalog 经 `ctx.forge.register()` 注册（fiber 作用域回收），其他服务可 `inject: ['forge']` 内省，宿主用 `ctx.intercept('forge', policy)` 分子树治理；
- 三级后端齐备：tier 1 `internal/get` 视图 / tier 2 原型补丁 / tier 3 fabric 委托（无桥时显式 unavailable，漂移时 `stale`）；
- capability 与行为可控：`requires` 声明 + 宿主 `deny` / `allowMutate: false`（变更点降级为纯观察，改参不回流，实测验证）；
- 接口抽象：注入点可声明 `map`（toEvent/applyEvent），下游面对稳定 payload；
- 统一开发标准：`defineCatalog` 声明 → `Events` 增强获得类型面 → `ctx.on` 消费 → `contractSuite` 验证；
- opt-out、版本漂移降级、链式纪律、异步方法、HMR 代际交接、`getForgeStatus()` 诊断；
- M2 已完成：`buildPatchStubs()` 宿主引导接缝（catalog → fabric 静态 stub，零依赖纯映射）；fabric 后端全操作（before/after/around 的 `event.veto`/replace 的 `event.invoke()`）；**对真实 cordis-fabric 引擎的 E2E 验证**（`test/fabric-e2e.test.ts`：真实 AST 变换 + bridge 分发 + 卸载回退透传）；
- 全链路示范插件 `examples/sidebar-bridge/`：forge 事件 → `ctx.betterSidebar.registerTab`（对着真实 `dsh-better-sidebar` 类型面编程，含 badge 投影与 fiber 级卸载回收）；注意宿主树↔浏览器树边界需经官方 relay，桥接逻辑两侧同构；
- 双端兼容模式 `examples/universal-panel/`：一套 panel 声明 → 多 surface 适配（betterSidebar tab / TUI 文本面板），surface 软探测（`ctx.get`，不硬 `inject`），web-only / tui-only / headless 宿主均可加载；DSH 无官方 TUI 注册表，示例附带 `TuiRegistry` 社区约定接口；
- 双端工作区面板 `examples/workspace-panel/`：目录树/文件查看以 forge 事件语义重写（`workspace/select`/`workspace/open` 请求 + `workspace/opened` 观察事件 + 单一 store 事实源），webui（betterSidebar tab）与 tui（行投影）同一声明；打开的文件经 `fs.watch` 实时刷新；附带零依赖 ANSI TUI host（j/k 移动、回车打开、q 退出），**真机验证**：`node examples/workspace-panel/tui-host.ts <dir>` 光标移动、打开、外部修改后视图自动更新；
- **UI 可移植层三服务**（`src/ui/`，route A renderer map）：`ctx.layers`（层注册 + `layer/ready`/`layer/gone` 生命周期）、`ctx.states`（渲染无关 store seat：draft actions/getSnapshot/subscribe/select）、`ctx.components`（一次声明多 surface 投影，适配器可插拔，迟到层自动补挂，fiber 级回收）；`createUiKit()` 一键挂载；E2E 验证单事件流同驱 webui badge 与 tui 文本；
- `npm test`：43 项契约/E2E/UI 测试全部通过；`npm run typecheck`：tsc strict 干净。

### 附 3：真机验证记录（2026-08-15，cc-tui profile）

两个样本在真实 DSH 安装（Node 24.16，`~/.dsh/profiles/cc-tui`）上端到端通过：

1. **dsh-forge-modes**（tier 2）：`AgentPresets.recompose` 注入点；TUI 内 `/preset` 切换到 code，`agent-preset/switch` 事件携带抽象 payload `{to:'code'}` 落盘。manifest 声明 capability、payload 抽象、宿主 policy（deny/allowMutate）与插件 allowlist 双层行为控制均有本地契约测试。
2. **dsh-fabric-demo**（tier 3 源码 patch）：`NODE_OPTIONS=--import fabric-bootstrap.mjs` 替代宿主接线，`@deepseek-ai/dsh-permission-presets` 的模块级函数 `effectivePermissionPreset` 被真实变换（bindings 1 节点），调用经 bridge 触发 handler。

**真机踩坑两条（已写入注册表约定）**：
- DSH 全系包是 rc 预发布版本，semver `'*'`/`^x` 不匹配预发布——fabric target 的 `versionRange` 必须 `'>=0.0.0-0'` 或显式 rc 范围；
- fabric 的 bridge/runtime 是模块实例级单例——bootstrap 与插件必须解析到**同一物理副本**的 cordis-fabric，否则 handler 永不触发（症状：绑定成功但零调用）。

3. **dsh-plugin-demo**（原 dsh-fabric-sidebar，tier 3 渲染树注入）：对 cc-tui 的 `Chat` 屏幕组件（模块级函数，运行时不可达）做 around 变换，注入一个实时工作区侧栏（class 组件规避跨副本 hooks dispatcher 问题；宿主元素用 `ink-box`/`ink-text` 字符串）。tmux 200 列真机验证：侧栏渲染在 TUI 内并实时列目录；后重命名为 `examples/plugin-demo/`，快捷键改为经 cc-tui 的 Ink 解析输入上下文（`StdinContext.internal_eventEmitter`）消费，diff 页通过 `sidebar/diff` forge 事件展示绿色 + / 红色 - numstat；webui 端增加 client relay（`client.js` bundle，`/sidebar/dsh-plugin-demo/forge-snapshot` relay 将宿主 forge 快照重放为浏览器树同构 `sidebar/*` 事件），并改造 vendored dsh-better-sidebar 的 Explorer/Git 面板订阅这些事件——不新建 demo tab，直接复用原生 explorer 与 git 变更列表。附加发现：`getFabric` 用 strict `ctx.get` 在并行 boot 下会误判未挂载（提供方 fiber 尚未 ACTIVE），需要非 strict 回退——可作为给 fabric 作者的反馈点。

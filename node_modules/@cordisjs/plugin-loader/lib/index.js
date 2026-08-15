var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { Inject, Service as Service2 } from "cordis";
import { defineProperty, isNullable as isNullable2 } from "cosmokit";

// src/internal.ts
import { createRequire } from "node:module";
var ModulePhase = /* @__PURE__ */ ((ModulePhase2) => {
  ModulePhase2[ModulePhase2["Source"] = 1] = "Source";
  ModulePhase2[ModulePhase2["Evaluation"] = 2] = "Evaluation";
  return ModulePhase2;
})(ModulePhase || {});
var ModuleLoader;
((ModuleLoader2) => {
  let _cachedLoader;
  function requireInternal(id) {
    const require2 = createRequire(import.meta.url);
    if (process.execArgv.includes("--expose-internals")) {
      try {
        return require2(id);
      } catch {
      }
    }
    try {
      return require2("node-addon-require-builtin").requireBuiltin(id);
    } catch {
    }
  }
  __name(requireInternal, "requireInternal");
  function fromInternal() {
    if (_cachedLoader) return _cachedLoader;
    const [major] = process.versions.node.split(".").map(Number);
    if (major >= 24) {
      const raw = requireInternal("internal/modules/esm/loader")?.getOrInitializeCascadedLoader();
      if (raw) return _cachedLoader = Object.assign(raw, { version: "v2" });
    } else if (major >= 22) {
      const raw = requireInternal("internal/modules/esm/loader")?.getOrInitializeCascadedLoader();
      if (raw) return _cachedLoader = Object.assign(raw, { version: "v1" });
    }
  }
  ModuleLoader2.fromInternal = fromInternal;
  __name(fromInternal, "fromInternal");
})(ModuleLoader || (ModuleLoader = {}));

// src/config/entry.ts
import { deepEqual, isNullable } from "cosmokit";

// src/config/group.ts
import { Service } from "cordis";
var EntryGroup = class {
  constructor(ctx, tree) {
    this.ctx = ctx;
    this.tree = tree;
    const entry = ctx.fiber.entry;
    if (entry) entry.subgroup = this;
  }
  ctx;
  tree;
  static {
    __name(this, "EntryGroup");
  }
  static key = /* @__PURE__ */ Symbol.for("cordis.group");
  data = [];
  get context() {
    return this.ctx;
  }
  async create(options) {
    const id = this.tree.ensureId(options);
    const entry = this.tree.store[id] ??= new Entry(this.ctx.loader);
    entry.parent = this;
    await entry.update(options, true, true);
    return entry.id;
  }
  unlink(options) {
    const config = this.data;
    const index = config.indexOf(options);
    if (index >= 0) config.splice(index, 1);
  }
  remove(id, isDispose = false) {
    const entry = this.tree.store[id];
    if (!entry) return;
    entry.fiber?.dispose();
    if (!isDispose) {
      this.unlink(entry.options);
    }
    delete this.tree.store[id];
    this.context.emit("loader/partial-dispose", entry, entry.options, false);
  }
  async update(config) {
    const oldConfig = this.data;
    this.data = config;
    const oldMap = Object.fromEntries(oldConfig.map((options) => [options.id, options]));
    const newMap = Object.fromEntries(config.map((options) => [options.id ?? /* @__PURE__ */ Symbol("anonymous"), options]));
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap });
    await Promise.all(ids.map(async (id) => {
      if (newMap[id]) {
        await this.create(newMap[id]).catch((error) => {
          this.ctx.logger.error(error);
        });
      } else {
        this.remove(id);
      }
    }));
  }
  stop() {
    for (const options of this.data) {
      this.remove(options.id, true);
    }
  }
};
var Group = class extends EntryGroup {
  constructor(ctx, config) {
    super(ctx, ctx.fiber.entry.parent.tree);
    this.ctx = ctx;
    this.config = config;
    ctx.on("internal/update", (config2) => {
      this.update(config2);
    });
  }
  ctx;
  config;
  static {
    __name(this, "Group");
  }
  static initial = [];
  static [EntryGroup.key] = true;
  async *[Service.init]() {
    yield () => this.stop();
    await this.update(this.config);
  }
};

// src/config/tree.ts
import { composeError } from "cordis";
import { isNonNullable } from "cosmokit";
var EntryTree = class _EntryTree {
  static {
    __name(this, "EntryTree");
  }
  static sep = ":";
  ctx;
  enableLogs;
  root;
  store = /* @__PURE__ */ Object.create(null);
  constructor(ctx) {
    this.ctx = ctx.extend({ baseUrl: ctx.baseUrl });
    this.root = new EntryGroup(this.ctx, this);
    const entry = this.ctx.fiber.entry;
    if (entry) entry.subtree = this;
  }
  get context() {
    return this.ctx;
  }
  *entries() {
    for (const entry of Object.values(this.store)) {
      yield entry;
      if (!entry.subtree) continue;
      yield* entry.subtree.entries();
    }
  }
  getTasks() {
    return [...this.entries()].map((entry) => entry._initTask || entry.fiber?.inertia).filter(isNonNullable);
  }
  async await() {
    while (true) {
      const tasks = this.getTasks();
      if (!tasks.length) return;
      await Promise.allSettled(tasks);
    }
  }
  ensureId(options) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(16).slice(2, 10);
      } while (this.store[options.id]);
    }
    return options.id;
  }
  resolve(id) {
    const parts = id.split(_EntryTree.sep);
    let tree = this;
    const final = parts.pop();
    for (const part of parts) {
      tree = tree.store[part]?.subtree;
      if (!tree) throw new Error(`cannot resolve entry ${id}`);
    }
    const entry = tree.store[final];
    if (!entry) throw new Error(`cannot resolve entry ${id}`);
    return entry;
  }
  resolveGroup(id) {
    if (!id) return this.root;
    const entry = this.resolve(id);
    if (!entry.subgroup) throw new Error(`entry ${id} is not a group`);
    return entry.subgroup;
  }
  async create(options, parent = null, position = Infinity) {
    const group = this.resolveGroup(parent);
    group.data.splice(position, 0, options);
    group.tree.write();
    return group.create(options);
  }
  remove(id) {
    const entry = this.resolve(id);
    entry.parent.remove(id);
    entry.parent.tree.write();
  }
  async update(id, options, parent, position) {
    const entry = this.resolve(id);
    const source = entry.parent;
    if (parent !== void 0) {
      const target = this.resolveGroup(parent);
      source.unlink(entry.options);
      target.data.splice(position ?? Infinity, 0, entry.options);
      target.tree.write();
      entry.parent = target;
    }
    source.tree.write();
    return entry.update(options, false, true);
  }
  import(name, getOuterStack) {
    if (name.startsWith("cordis:")) {
      return this.ctx.loader.builtins[name.slice(7)];
    }
    return composeError(async (info) => {
      info.offset += 3;
      if (this.ctx.loader.internal) {
        return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
      } else if (name.startsWith(".")) {
        return await import(
          /* @vite-ignore */
          new URL(name, this.ctx.baseUrl).href
        );
      } else {
        return await import(
          /* @vite-ignore */
          name
        );
      }
    }, getOuterStack);
  }
};

// src/config/utils.ts
import { valueMap } from "cosmokit";
var evaluate = new Function("ctx", "expr", `
  with (ctx) {
    return eval(expr)
  }
`);
function interpolate(ctx, value) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr);
  } else if (!value || typeof value !== "object") {
    return value;
  } else if (Array.isArray(value)) {
    return value.map((item) => interpolate(ctx, item));
  } else {
    return valueMap(value, (item) => interpolate(ctx, item));
  }
}
__name(interpolate, "interpolate");
function isJsExpr(value) {
  return value instanceof Object && "__jsExpr" in value;
}
__name(isJsExpr, "isJsExpr");

// src/config/entry.ts
function takeEntries(object, keys) {
  const result = [];
  for (const key of keys) {
    if (!(key in object)) continue;
    result.push([key, object[key]]);
    delete object[key];
  }
  return result;
}
__name(takeEntries, "takeEntries");
function sortKeys(object, prepend = ["id", "name"], append = ["config"]) {
  const part1 = takeEntries(object, prepend);
  const part2 = takeEntries(object, append);
  const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b));
  return Object.assign(object, Object.fromEntries([...part1, ...rest, ...part2]));
}
__name(sortKeys, "sortKeys");
var Entry = class _Entry {
  constructor(loader) {
    this.loader = loader;
    this.ctx = loader.ctx.extend({ [_Entry.key]: this });
    this.context.emit("loader/entry-init", this);
  }
  loader;
  static {
    __name(this, "Entry");
  }
  static key = /* @__PURE__ */ Symbol.for("cordis.entry");
  ctx;
  fiber;
  parent;
  // safety: call `entry.update()` immediately after creating an entry
  options = {};
  subgroup;
  subtree;
  _initTask;
  get context() {
    return this.ctx;
  }
  get id() {
    let id = this.options.id;
    if (this.parent.tree.ctx.fiber.entry) {
      id = this.parent.tree.ctx.fiber.entry.id + EntryTree.sep + id;
    }
    return id;
  }
  get disabled() {
    if (this.options.group) return false;
    let entry = this;
    do {
      if (entry.options.disabled) return true;
      entry = entry.parent.ctx.fiber.entry;
    } while (entry);
    return false;
  }
  evaluate(expr) {
    return evaluate(this.ctx, expr);
  }
  _resolveConfig(plugin) {
    if (plugin[EntryGroup.key]) return this.options.config;
    return interpolate(this.ctx, this.options.config);
  }
  _patchContext(diff) {
    this.context.waterfall("loader/patch-context", this, () => {
      Object.setPrototypeOf(this.ctx, this.parent.ctx);
      if (this.fiber?.uid && (diff.includes("config") || this.options.group)) {
        this.fiber.update(this._resolveConfig(this.fiber.runtime.callback), true);
      }
    });
  }
  async refresh() {
    if (this.fiber) return;
    if (this.disabled) return;
    await this.init();
  }
  async update(options, create = false, force = false) {
    const legacy = { ...this.options };
    if (create) {
      this.options = options;
    } else {
      for (const [key, value] of Object.entries(options)) {
        if (isNullable(value)) {
          delete this.options[key];
        } else {
          this.options[key] = value;
        }
      }
    }
    sortKeys(this.options);
    if (this.disabled) {
      this.fiber?.dispose();
      return;
    }
    if (this.fiber?.uid) {
      const diff = Object.keys({ ...this.options, ...legacy }).filter((key) => !deepEqual(this.options[key], legacy[key]));
      if (!diff.length && !force) return;
      this.context.emit("loader/partial-dispose", this, legacy, true);
      this._patchContext(diff);
    } else {
      await this.init();
    }
  }
  getOuterStack = /* @__PURE__ */ __name(() => {
    let entry = this;
    const result = [];
    do {
      result.push(`    at ${entry.parent.tree.ctx.baseUrl}#${entry.options.id}`);
      entry = entry.parent.ctx.fiber.entry;
    } while (entry);
    return result;
  }, "getOuterStack");
  async init() {
    try {
      await (this._initTask ??= this._init());
    } finally {
      this._initTask = void 0;
    }
    this.fiber?.await().finally(() => {
      if (this.loader.getTasks().length) return;
      this.ctx.reflect.notify(["loader"]);
    });
  }
  async _init() {
    let exports;
    try {
      exports = await this.parent.tree.import(this.options.name, this.getOuterStack);
    } catch (error) {
      this.ctx.logger.error(error);
      return;
    } finally {
      this._initTask = void 0;
    }
    const plugin = this.loader.unwrapExports(exports);
    this._patchContext([]);
    this.loader.showLog(this, "apply");
    this.fiber = this.ctx.registry.plugin(plugin, this._resolveConfig(plugin), this.getOuterStack);
  }
};

// src/config/isolate.ts
import { Context as Context3 } from "cordis";
function swap(target, source) {
  for (const key of Reflect.ownKeys(target)) {
    Reflect.deleteProperty(target, key);
  }
  for (const key of Reflect.ownKeys(source || {})) {
    Reflect.defineProperty(target, key, Reflect.getOwnPropertyDescriptor(source, key));
  }
}
__name(swap, "swap");
var Realm = class {
  static {
    __name(this, "Realm");
  }
  store = /* @__PURE__ */ Object.create(null);
  access(key, create = false) {
    if (create) {
      return this.store[key] ??= /* @__PURE__ */ Symbol(`${key}${this.suffix}`);
    } else {
      return this.store[key] ?? /* @__PURE__ */ Symbol(`${key}${this.suffix}`);
    }
  }
  delete(key) {
    delete this.store[key];
  }
  get size() {
    return Object.keys(this.store).length;
  }
};
var LocalRealm = class extends Realm {
  constructor(entry) {
    super();
    this.entry = entry;
  }
  entry;
  static {
    __name(this, "LocalRealm");
  }
  get suffix() {
    return "#" + this.entry.options.id;
  }
};
var GlobalRealm = class extends Realm {
  constructor(label) {
    super();
    this.label = label;
  }
  label;
  static {
    __name(this, "GlobalRealm");
  }
  get suffix() {
    return "@" + this.label;
  }
};
function isolate(ctx) {
  const realms = /* @__PURE__ */ Object.create(null);
  const delims = /* @__PURE__ */ Object.create(null);
  function access(entry, name, create = false) {
    let realm;
    const label = entry.options.isolate?.[name];
    if (!label) return;
    if (label === true) {
      realm = entry.realm ??= new LocalRealm(entry);
    } else if (create) {
      realm = realms[label] ??= new GlobalRealm(label);
    } else {
      realm = realms[label];
    }
    return realm?.access(name, create);
  }
  __name(access, "access");
  ctx.on("loader/entry-init", (entry) => {
    entry.ctx[Context3.intercept] = Object.create(entry.ctx[Context3.intercept]);
    entry.ctx[Context3.isolate] = Object.create(entry.ctx[Context3.isolate]);
  });
  ctx.on("loader/patch-context", (entry, next) => {
    const newMap = Object.create(entry.parent.ctx[Context3.isolate]);
    for (const name of Object.keys(entry.options.isolate ?? {})) {
      newMap[name] = access(entry, name, true);
    }
    const diff = /* @__PURE__ */ Object.create(null);
    const oldMap = entry.ctx[Context3.isolate];
    for (const name in { ...newMap, ...delims }) {
      if (newMap[name] === oldMap[name]) continue;
      const delim = delims[name] ??= /* @__PURE__ */ Symbol(`delim:${name}`);
      entry.ctx[delim] = /* @__PURE__ */ Symbol(`${name}#${entry.id}`);
      for (const symbol of [oldMap[name], newMap[name]]) {
        const impl = symbol && entry.ctx.reflect.store[symbol];
        if (!impl) continue;
        if (!impl.fiber) {
          entry.ctx.logger.warn(new Error(`expected service ${name} to be implemented`));
          continue;
        }
        diff[name] = [oldMap[name], newMap[name], entry.ctx[delim], impl.fiber.ctx[delim]];
        if (entry.ctx[delim] !== impl.fiber.ctx[delim]) break;
      }
    }
    Object.setPrototypeOf(entry.ctx[Context3.isolate], entry.parent.ctx[Context3.isolate]);
    Object.setPrototypeOf(entry.ctx[Context3.intercept], entry.parent.ctx[Context3.intercept]);
    swap(entry.ctx[Context3.isolate], newMap);
    swap(entry.ctx[Context3.intercept], entry.options.intercept);
    next();
    for (const [symbol1, symbol2, flag1, flag2] of Object.values(diff)) {
      if (flag1 === flag2 && entry.ctx.reflect.store[symbol1] && !entry.ctx.reflect.store[symbol2]) {
        entry.ctx.reflect.store[symbol2] = entry.ctx.reflect.store[symbol1];
        delete entry.ctx.reflect.store[symbol1];
      }
    }
    ctx.reflect.notify(Object.keys(diff), (ctx2, name) => {
      const [symbol1, symbol2, flag1, flag2] = diff[name];
      const symbol3 = ctx2[Context3.isolate][name];
      const flag3 = ctx2[delims[name]];
      return (symbol1 === symbol3 || symbol2 === symbol3) && flag1 === flag3 !== (flag1 === flag2);
    });
    for (const name in delims) {
      if (!Reflect.ownKeys(newMap).includes(name)) {
        delete entry.ctx[delims[name]];
      }
    }
  });
  ctx.on("loader/partial-dispose", (entry, legacy, active) => {
    for (const [name, label] of Object.entries(legacy.isolate ?? {})) {
      if (label === true) continue;
      if (active && entry.options.isolate?.[name] === label) continue;
      const realm = realms[label];
      if (!realm) continue;
      for (const entry2 of ctx.loader.entries()) {
        if (entry2.options.isolate?.[name] === realm.label) return;
      }
      realm.delete(name);
      if (!realm.size) {
        delete realms[realm.label];
      }
    }
  });
}
__name(isolate, "isolate");

// src/index.ts
var Loader = class extends EntryTree {
  constructor(ctx, config = {}) {
    super(ctx);
    this.config = config;
    if (config.baseUrl) {
      this.ctx.baseUrl = config.baseUrl;
    }
    const self = this;
    defineProperty(this, Service2.tracker, {
      associate: "loader",
      property: "ctx",
      noShadow: true
    });
    ctx.reflect.provide("loader", this, this[Service2.check]);
    ctx.on("internal/update", function(config2, noSave, next) {
      if (!this.entry || noSave || this.parent.fiber?.entry === this.entry) return next();
      const unparse = this.runtime?.Config?.["simplify"];
      this.entry.options.config = unparse ? unparse(config2) : config2;
      this.entry.parent.tree.write();
      return next();
    }, { global: true, prepend: true });
    ctx.on("internal/update", function(config2, _, next) {
      if (!this.entry || this.parent.fiber?.entry === this.entry) return next();
      self.showLog(this.entry, "reload");
      return next();
    }, { global: true });
    ctx.on("internal/plugin", (fiber) => {
      if (fiber.parent[Entry.key] && !fiber.entry) {
        fiber.entry = fiber.parent[Entry.key];
        Inject.resolve(fiber.entry.options.inject, fiber.inject);
      }
      if (fiber.uid) return;
      if (!fiber.entry) return;
      if (fiber.parent.fiber?.entry === fiber.entry) return;
      if (!ctx.registry.has(fiber.runtime.callback)) return;
      if (!fiber.entry.parent.tree.ctx.fiber.uid) return;
      this.showLog(fiber.entry, "unload");
      if (fiber.entry.disabled) return;
      fiber.entry.options.disabled = true;
      fiber.entry.parent.tree.write();
    });
    ctx.plugin(isolate);
  }
  config;
  static {
    __name(this, "Loader");
  }
  envData = process.env.CORDIS_SHARED ? JSON.parse(process.env.CORDIS_SHARED) : { startTime: Date.now() };
  name = "loader";
  internal = ModuleLoader.fromInternal();
  builtins = /* @__PURE__ */ Object.create(null);
  write() {
  }
  [Service2.check]() {
    const config = Service2.prototype[Service2.resolveConfig].call(this);
    if (config.await && this.getTasks().length) return false;
    return true;
  }
  showLog(entry, type) {
    if (entry.options.group || !entry.parent.tree.enableLogs) return;
    this.ctx.root.logger?.("loader").info("%s plugin %C", type, entry.options.name);
  }
  locate(fiber = this.ctx.fiber) {
    while (1) {
      if (fiber.entry) return fiber.entry.id;
      const next = fiber.parent.fiber;
      if (fiber === next) return;
      fiber = next;
    }
  }
  exit() {
  }
  unwrapExports(exports) {
    if (isNullable2(exports)) return exports;
    exports = exports.default ?? exports;
    if (!exports.__esModule) return exports;
    return exports.default ?? exports;
  }
};
var index_default = Loader;
export {
  Entry,
  EntryGroup,
  EntryTree,
  GlobalRealm,
  Group,
  Loader,
  LocalRealm,
  ModuleLoader,
  ModulePhase,
  Realm,
  index_default as default,
  evaluate,
  interpolate,
  isJsExpr
};

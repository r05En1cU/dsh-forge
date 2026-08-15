window.__ModuleLoader__.load({ id: "dsh-plugin-demo", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// examples/plugin-demo/src/client.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var name = "dsh-plugin-demo-client";
var inject = ["betterSidebar"];
function makeForgeEvent(point, payload) {
  return { point, args: [], payload };
}
function startForgeRelay(ctx) {
  const poll = async () => {
    try {
      const res = await fetch("/sidebar/dsh-plugin-demo/forge-snapshot", { cache: "no-store" });
      if (!res.ok) return;
      const snapshot = await res.json();
      ctx.emit("sidebar/files", makeForgeEvent("sidebar/files", { entries: snapshot.files ?? [] }));
      ctx.emit("sidebar/diff", makeForgeEvent("sidebar/diff", { entries: snapshot.diff ?? [] }));
      ctx.emit("sidebar/page", makeForgeEvent("sidebar/page", { page: snapshot.page ?? "files" }));
      ctx.emit("sidebar/visible", makeForgeEvent("sidebar/visible", { visible: snapshot.visible ?? true }));
    } catch {
    }
  };
  void poll();
  const timer = setInterval(poll, 1500);
  return () => clearInterval(timer);
}
function apply(ctx) {
  const stopRelay = startForgeRelay(ctx);
  ctx.effect(() => () => {
    stopRelay?.();
  }, "plugin-demo:webui-forge-relay");
}
return module.exports; } });

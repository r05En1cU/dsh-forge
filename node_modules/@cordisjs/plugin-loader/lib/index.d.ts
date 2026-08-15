import { Context, Service } from 'cordis';
import { Dict } from 'cosmokit';
import { ModuleLoader } from './internal.ts';
import { Entry, EntryOptions } from './config/entry.ts';
import { EntryTree } from './config/tree.ts';
export * from './config/entry.ts';
export * from './config/group.ts';
export * from './config/isolate.ts';
export * from './config/tree.ts';
export * from './config/utils.ts';
export * from './internal.ts';
declare module 'cordis' {
    interface Events {
        'exit'(signal: NodeJS.Signals): Promise<void>;
        'loader/config-update'(): void;
        'loader/entry-init'(entry: Entry): void;
        'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void;
        'loader/patch-context'(entry: Entry, next: () => void): void;
    }
    interface Context {
        loader: Loader;
    }
    interface EnvData {
        startTime?: number;
    }
    interface Fiber {
        entry?: Entry;
    }
}
export declare namespace Loader {
    interface Config {
        baseUrl?: string;
    }
    interface Intercept {
        await?: boolean;
    }
}
export declare class Loader extends EntryTree {
    config: Loader.Config;
    [Service.config]: Loader.Intercept;
    envData: any;
    name: string;
    internal: ModuleLoader | undefined;
    builtins: Dict<any>;
    constructor(ctx: Context, config?: Loader.Config);
    write(): void;
    [Service.check](): boolean;
    showLog(entry: Entry, type: string): void;
    locate(fiber?: import("cordis").Fiber): string | undefined;
    exit(): void;
    unwrapExports(exports: any): any;
}
export default Loader;

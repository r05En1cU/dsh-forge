import { Context } from 'cordis';
import { Dict } from 'cosmokit';
import { Entry, EntryOptions } from './entry.ts';
import { EntryGroup } from './group.ts';
export declare abstract class EntryTree {
    static readonly sep = ":";
    ctx: Context;
    enableLogs?: boolean;
    root: EntryGroup;
    store: Dict<Entry>;
    constructor(ctx: Context);
    get context(): Context;
    entries(): Generator<Entry, void, void>;
    getTasks(): Promise<void>[];
    await(): Promise<void>;
    ensureId(options: Partial<EntryOptions>): string;
    resolve(id: string): Entry;
    resolveGroup(id: string | null): EntryGroup;
    create(options: Omit<EntryOptions, 'id'>, parent?: string | null, position?: number): Promise<string>;
    remove(id: string): void;
    update(id: string, options: Omit<EntryOptions, 'id' | 'name'>, parent?: string | null, position?: number): Promise<void>;
    import(name: string, getOuterStack?: () => string[]): any;
    abstract write(): void;
}

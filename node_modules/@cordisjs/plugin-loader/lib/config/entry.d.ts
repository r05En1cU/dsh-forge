import { Context, Fiber, Inject } from 'cordis';
import { Loader } from '../index.ts';
import { EntryGroup } from './group.ts';
import { EntryTree } from './tree.ts';
export interface EntryOptions {
    id: string;
    name: string;
    config?: any;
    group?: boolean | null;
    disabled?: boolean | null;
    inject?: Inject | null;
}
export declare class Entry {
    loader: Loader;
    static readonly key: unique symbol;
    ctx: Context;
    fiber?: Fiber;
    parent: EntryGroup;
    options: EntryOptions;
    subgroup?: EntryGroup;
    subtree?: EntryTree;
    _initTask?: Promise<void>;
    constructor(loader: Loader);
    get context(): Context;
    get id(): string;
    get disabled(): boolean;
    evaluate(expr: string): any;
    _resolveConfig(plugin: any): [any, any?];
    private _patchContext;
    refresh(): Promise<void>;
    update(options: Partial<EntryOptions>, create?: boolean, force?: boolean): Promise<void>;
    getOuterStack: () => string[];
    init(): Promise<void>;
    private _init;
}

import { Context } from 'cordis';
import { Dict } from 'cosmokit';
import { Entry } from './entry.ts';
declare module './entry.ts' {
    interface EntryOptions {
        intercept?: Dict | null;
        isolate?: Dict<true | string> | null;
    }
    interface Entry {
        realm: LocalRealm;
    }
}
export declare abstract class Realm {
    protected store: Dict<symbol>;
    abstract get suffix(): string;
    access(key: string, create?: boolean): symbol;
    delete(key: string): void;
    get size(): number;
}
export declare class LocalRealm extends Realm {
    private entry;
    constructor(entry: Entry);
    get suffix(): string;
}
export declare class GlobalRealm extends Realm {
    label: string;
    constructor(label: string);
    get suffix(): string;
}
export default function isolate(ctx: Context): void;

export declare const evaluate: ((ctx: object, expr: string) => any);
export declare function interpolate(ctx: object, value: any): any;
export declare function isJsExpr(value: any): value is JsExpr;
export interface JsExpr {
    __jsExpr: string;
}

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-plugin-demo'

export interface DemoFileEntry {
  path: string
  name: string
  dir: boolean
}

export interface DemoDiffEntry {
  add: number
  del: number
  path: string
}

export interface DemoForgeEvent<T = unknown> {
  point: string
  args: unknown[]
  payload?: Record<string, unknown>
  result?: T
}

export function listFiles(cwd: string): DemoFileEntry[]
export function gitNumstat(cwd: string): DemoDiffEntry[]
export function makeForgeEvent<T>(point: string, payload: Record<string, unknown>, result: T, args?: unknown[]): DemoForgeEvent<T>
export function parseHotkey(spec: string): { ctrl: boolean; key: string } | null
export function hotkeyLabel(spec: string): string
export function normalizeHotkeys(keys?: Record<string, string>): { toggle: string; cycle: string; refresh: string }
export function matchHotkey(event: { input?: string; key?: { ctrl?: boolean } }, spec: string): boolean
export function createWebuiComponent(): (props: any) => unknown
export function apply(ctx: Context, config?: { keys?: Record<string, string> }): Promise<void>
declare const _default: { name: typeof name; apply: typeof apply }
export default _default

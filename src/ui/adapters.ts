import type { SurfaceAdapter } from './service.ts'
import type { VNodeChild } from './vnode.ts'
import { Fragment, h, isVNode, resolveVNode } from './vnode.ts'

export type ReactCreateElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown

/** Convert a renderer-independent vnode into a React/Ink/RN element. */
export function toReactElement(node: VNodeChild, createElement: ReactCreateElement): unknown {
  const resolved = resolveVNode(node)
  if (Array.isArray(resolved)) return resolved.map((child) => toReactElement(child, createElement))
  if (!isVNode(resolved)) return resolved
  if (resolved.type === Fragment) {
    return createElement(Fragment as unknown, resolved.props, ...resolved.children.map((child) => toReactElement(child, createElement)))
  }
  if (typeof resolved.type === 'function') {
    return toReactElement(resolved.type(resolved.props, resolved.children), createElement)
  }
  return createElement(resolved.type, resolved.props, ...resolved.children.map((child) => toReactElement(child, createElement)))
}

/** Minimal text projection used by the built-in TUI adapter. */
export function toTextLines(node: VNodeChild): string[] {
  const resolved = resolveVNode(node)
  if (Array.isArray(resolved)) return resolved.flatMap((child) => toTextLines(child))
  if (!isVNode(resolved)) return resolved === null || resolved === undefined ? [] : [String(resolved)]

  const text = (value: unknown) => String(value ?? '')
  const label = () => text(resolved.props?.label ?? resolved.props?.value ?? resolved.children.map(text).join(''))

  switch (resolved.type) {
    case 'text':
      return [label()]
    case 'button':
      return [`[${label()}]`]
    case 'list': {
      const items = resolved.props?.items
      if (!Array.isArray(items)) return []
      return items.flatMap((item) => toTextLines(item as VNodeChild))
    }
    case 'view':
    case 'box':
    case 'column':
    case 'row': {
      const lines = resolved.children.flatMap((child) => toTextLines(child))
      if (resolved.props?.title) lines.unshift(text(resolved.props.title))
      return lines
    }
    default:
      return resolved.children.flatMap((child) => toTextLines(child))
  }
}

export interface WebuiSlotsAdapterOptions {
  /** Cordis service name carrying the slot registry. Default: 'slots'. */
  service?: string
  /** React/Ink/RN element factory. Defaults to a tuple factory for tests. */
  createElement?: ReactCreateElement
}

/**
 * WebUI adapter: registers each component into the host's slot registry
 * (`ctx.slots` in official DSH) as a real React component whose body is the
 * unified vnode renderer converted through `createElement`.
 */
export function webuiSlotsAdapter(options: WebuiSlotsAdapterOptions = {}): SurfaceAdapter {
  const service = options.service ?? 'slots'
  const createElement = options.createElement ?? ((type, props, ...children) => [type, props, children])
  return {
    layer: 'webui',
    service,
    mount(_ctx, desc, slot, surface: { register(registration: unknown): unknown }) {
      const renderer = desc.render
      const component = (props?: Record<string, unknown>) => toReactElement(renderer(h, props), createElement)
      const registration = surface.register({
        name: slot?.id ?? desc.id,
        title: desc.title,
        ...desc.options,
        component,
      })
      if (typeof registration === 'function') return registration as () => void
      if (registration && typeof (registration as { dispose?: unknown }).dispose === 'function') {
        return () => ((registration as { dispose(): void }).dispose())
      }
      return undefined
    },
  }
}

export interface TuiPanelAdapterOptions {
  service?: string
}

/**
 * TUI adapter: projects the unified vnode to text lines and registers a panel
 * on the community TuiRegistry-shaped surface (`ctx.tui`).
 */
export function tuiPanelAdapter(options: TuiPanelAdapterOptions = {}): SurfaceAdapter {
  const service = options.service ?? 'tui'
  return {
    layer: 'tui',
    service,
    mount(_ctx, desc, _slot, surface: { registerPanel(registration: unknown): unknown }) {
      const renderer = desc.render
      const registration = surface.registerPanel({
        id: desc.id,
        title: desc.title,
        ...desc.options,
        lines: () => toTextLines(renderer(h)),
      })
      if (typeof registration === 'function') return registration as () => void
      if (registration && typeof (registration as { dispose?: unknown }).dispose === 'function') {
        return () => ((registration as { dispose(): void }).dispose())
      }
      return undefined
    },
  }
}

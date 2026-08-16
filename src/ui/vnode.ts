/**
 * Renderer-independent vnode model. JSX cannot be shared across React / Ink /
 * React Native runtimes, so components return this tree through the `h`
 * factory; each UI adapter maps it to its native element type.
 */
export type VNodeComponent = (props: Record<string, unknown> | null, children: readonly VNodeChild[]) => VNodeChild
export type VNodeType = string | symbol | VNodeComponent

export interface VNode {
  type: VNodeType
  props: Record<string, unknown> | null
  children: readonly VNodeChild[]
  key?: unknown
}

export type VNodeChild = VNode | string | number | boolean | null | undefined | readonly VNodeChild[]

export const Fragment = Symbol.for('dsh-neoforge.ui.fragment')

export function h(type: VNodeType, props?: Record<string, unknown> | null, ...children: VNodeChild[]): VNode {
  const normalizedProps = props ?? null
  let key: unknown
  let rest = normalizedProps
  if (normalizedProps && 'key' in normalizedProps) {
    const { key: extracted, ...remaining } = normalizedProps
    key = extracted
    rest = remaining
  }
  return { type, props: rest, children: flatten(children), key }
}

export function isVNode(value: unknown): value is VNode {
  return !!value && typeof value === 'object' && 'type' in value && 'children' in value
}

function flatten(children: readonly VNodeChild[]): VNodeChild[] {
  const out: VNodeChild[] = []
  const walk = (value: VNodeChild) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
    } else if (value !== null && value !== undefined && value !== false) {
      out.push(value)
    }
  }
  for (const child of children) walk(child)
  return out
}

/** Resolve function components and top-level fragments until concrete vnodes or primitives remain. */
export function resolveVNode(node: VNodeChild): VNodeChild {
  let current = node
  let guard = 0
  while (guard++ < 100) {
    if (Array.isArray(current)) {
      current = current.map((item) => resolveVNode(item))
      continue
    }
    if (!isVNode(current) || typeof current.type !== 'function') break
    current = current.type(current.props, current.children)
  }
  return current
}

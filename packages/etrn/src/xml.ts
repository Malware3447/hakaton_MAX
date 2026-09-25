// Маленький писатель XML: титулы — это атрибуты и порядок элементов, большего не нужно.
// Порядок элементов строго по XSD ФНС: libxml2 проверяет последовательность.

export type Attrs = Record<string, string | number | null | undefined>
export interface Node {
  name: string
  attrs: Attrs
  children: (Node | string)[]
}

export const el = (name: string, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): Node => ({
  name,
  attrs,
  children: children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false),
})

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function render(n: Node, ind: string): string {
  const attrs = Object.entries(n.attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
    .join('')
  if (!n.children.length) return `${ind}<${n.name}${attrs}/>`
  if (n.children.length === 1 && typeof n.children[0] === 'string') return `${ind}<${n.name}${attrs}>${escText(n.children[0])}</${n.name}>`
  const inner = n.children.map((c) => (typeof c === 'string' ? ind + '  ' + escText(c) : render(c, ind + '  '))).join('\n')
  return `${ind}<${n.name}${attrs}>\n${inner}\n${ind}</${n.name}>`
}

/** Документ целиком с объявлением windows-1251 — так требует формат ФНС. */
export const toXml = (root: Node) => `<?xml version="1.0" encoding="windows-1251"?>\n${render(root, '')}\n`

// Best-effort mapping between markdown source offsets and the rendered
// preview DOM. Exact for plain-text selections; when inline formatting makes
// the rendered text differ from the source (e.g. **bold**), falls back to
// comparing with emphasis/code characters stripped. Cross-block ranges that
// can't be located simply yield null (the comment still shows, unanchored).

export function offsetOfLine(source: string, line: number): number {
  let off = 0
  for (let l = 1; l < line; l++) {
    const nl = source.indexOf('\n', off)
    if (nl < 0) return off
    off = nl + 1
  }
  return off
}

export function lineOfOffset(source: string, offset: number): number {
  let line = 1
  const end = Math.min(offset, source.length)
  for (let i = 0; i < end; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

/** Source with markdown inline markers removed + a map back to raw offsets. */
function stripIndex(source: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '*' || ch === '_' || ch === '`' || ch === '~') continue
    map.push(i)
    text += ch
  }
  return { text, map }
}

/** Locate rendered-selection text in the markdown source, preferring matches at/after hintLine. */
export function findSourceRange(
  source: string,
  selText: string,
  hintLine: number,
): { from: number; to: number } | null {
  if (!selText.trim()) return null
  const hint = offsetOfLine(source, hintLine)
  let from = source.indexOf(selText, hint)
  if (from < 0) from = source.indexOf(selText)
  if (from >= 0) return { from, to: from + selText.length }
  const { text, map } = stripIndex(source)
  let sHint = 0
  while (sHint < map.length && (map[sHint] ?? Infinity) < hint) sHint++
  let i = text.indexOf(selText, sHint)
  if (i < 0) i = text.indexOf(selText)
  const start = map[i]
  const last = map[i + selText.length - 1]
  if (i < 0 || start === undefined || last === undefined) return null
  return { from: start, to: last + 1 }
}

function findTextInScope(scope: Element, target: string): Range | null {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  let full = ''
  const starts: number[] = []
  for (const n of nodes) {
    starts.push(full.length)
    full += n.data
  }
  const idx = full.indexOf(target)
  if (idx < 0) return null
  const range = document.createRange()
  if (!setPoint(range, nodes, starts, idx, true)) return null
  if (!setPoint(range, nodes, starts, idx + target.length, false)) return null
  return range
}

function setPoint(range: Range, nodes: Text[], starts: number[], pos: number, isStart: boolean): boolean {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    const start = starts[i]
    if (node === undefined || start === undefined) continue
    if (start <= pos && pos <= start + node.data.length) {
      if (isStart) range.setStart(node, pos - start)
      else range.setEnd(node, pos - start)
      return true
    }
  }
  return false
}

/** Locate a source range inside the rendered preview, scoped via data-line blocks. */
export function findDomRange(root: HTMLElement, source: string, from: number, to: number): Range | null {
  const raw = source.slice(from, to)
  if (!raw.trim()) return null
  const line = lineOfOffset(source, from)
  // Innermost rendered block starting at-or-before the anchor's source line.
  let block: Element | null = null
  let bestLine = -1
  for (const el of Array.from(root.querySelectorAll('[data-line]'))) {
    const l = Number(el.getAttribute('data-line'))
    if (!Number.isNaN(l) && l <= line && l >= bestLine) {
      bestLine = l
      block = el
    }
  }
  const stripped = raw.replace(/[*_`~]/g, '')
  const targets = stripped === raw ? [raw] : [raw, stripped]
  for (const t of targets) {
    if (!t.trim()) continue
    if (block) {
      const r = findTextInScope(block, t)
      if (r) return r
    }
    const r = findTextInScope(root, t)
    if (r) return r
  }
  return null
}

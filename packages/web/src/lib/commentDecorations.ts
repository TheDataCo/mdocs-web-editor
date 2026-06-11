import { type CommentValue, DOC_COMMENTS_FIELD } from '@mdocs/core'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import { decodeAnchor } from './anchors'

// Highlights for open, anchored comments. Decorations map through edits
// automatically; we push a fresh set whenever the comments map changes.
export const setCommentMarks = StateEffect.define<DecorationSet>()

export const commentHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) if (e.is(setCommentMarks)) deco = e.value
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const mark = Decoration.mark({ class: 'cm-comment-mark' })

export function computeCommentMarks(doc: Y.Doc): DecorationSet {
  const ymap = doc.getMap<CommentValue>(DOC_COMMENTS_FIELD)
  const ranges: [number, number][] = []
  for (const c of ymap.values()) {
    if (c.status !== 'open' || !c.anchorStart || !c.anchorEnd) continue
    const s = Y.createAbsolutePositionFromRelativePosition(decodeAnchor(c.anchorStart), doc)
    const e = Y.createAbsolutePositionFromRelativePosition(decodeAnchor(c.anchorEnd), doc)
    if (s && e && e.index > s.index) ranges.push([s.index, e.index])
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const builder = new RangeSetBuilder<Decoration>()
  for (const [from, to] of ranges) builder.add(from, to, mark)
  return builder.finish()
}

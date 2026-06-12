import { useEffect, useState } from 'react'

// Compact looping "work with your agent" demo for the sign-in brand panel —
// a slimmed port of datacoweb's ProductDemo delegate scene: the CLI pulls,
// drafts, pushes, and leaves a comment signed as the owner's agent.

const T = {
  pull: 300,
  pullOut: 1850,
  draft: 2600,
  push: 3500,
  pushOut: 5550,
  comment: 6300,
  commentOut: 9400,
  card: 9800,
  total: 12800,
}

const EVENTS: { kind: 'cmd' | 'out' | 'muted'; at: number; text: string }[] = [
  { kind: 'cmd', at: T.pull, text: 'mdocs pull 9d2f71c4 launch-plan.md' },
  { kind: 'out', at: T.pullOut, text: 'Pulled "Q3 Launch Plan" → launch-plan.md (version 12)' },
  { kind: 'muted', at: T.draft, text: '… drafting the pricing FAQ' },
  { kind: 'cmd', at: T.push, text: 'mdocs push launch-plan.md -m "Draft pricing FAQ"' },
  { kind: 'out', at: T.pushOut, text: 'Pushed launch-plan.md (version 13)' },
  { kind: 'cmd', at: T.comment, text: 'mdocs comments add 9d2f71c4 "Review the refund window." --as Claude' },
  { kind: 'out', at: T.commentOut, text: "Added comment 51c9a2e7 as Claude (you@acme.dev's agent)" },
]

const HOLD = 2800
const CPS = 30

const typed = (text: string, t: number, start: number) =>
  t <= start ? '' : text.slice(0, Math.max(0, Math.floor(((t - start) / 1000) * CPS)))

function useTimeline(total: number): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setT(total)
      return
    }
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(now - last, 120)
      last = now
      setT((prev) => (prev + dt >= total + HOLD ? 0 : prev + dt))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [total])
  return t
}

export function AgentDemo() {
  const t = useTimeline(T.total)
  const visible = EVENTS.filter((e) => t >= e.at)
  const last = visible[visible.length - 1]

  return (
    <div className="auth-demo" aria-hidden="true">
      <div className="demo-term">
        <div className="demo-term-bar">
          <span className="demo-dot" />
          <span className="demo-dot" />
          <span className="demo-dot" />
          <span className="demo-term-label">claude — ~/launch</span>
        </div>
        <div className="demo-term-body">
          <div>
            {visible.map((e, i) =>
              e.kind === 'cmd' ? (
                <p key={e.at} className="demo-line cmd">
                  <span className="demo-prompt">$ </span>
                  {typed(e.text, t, e.at)}
                  {i === visible.length - 1 && <span className="demo-cursor" />}
                </p>
              ) : (
                <p key={e.at} className={`demo-line ${e.kind}`}>
                  {e.text}
                </p>
              ),
            )}
            {(!last || last.kind !== 'cmd') && (
              <p className="demo-line cmd">
                <span className="demo-prompt">$ </span>
                <span className="demo-cursor" />
              </p>
            )}
          </div>
        </div>
      </div>
      {t >= T.card && (
        <div className="demo-card">
          <div className="demo-card-head">
            <span className="demo-card-author">Claude (you@acme.dev's agent)</span>
            <span className="demo-card-time">just now · CLI</span>
          </div>
          <div className="demo-card-body">Review the refund window before we ship.</div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef } from 'react'

// Ported from datacoweb: a subtle grayscale "data flowing" animation — rows of
// monospace tokens streaming horizontally at varying speeds. White glyphs;
// meant to sit on a dark surface (the sign-in brand panel).
export function DataFlow({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const GLYPHS = '0123456789{}[]<>/.:'
    const FONT_SIZE = 14
    const ROW_GAP = 26

    interface Token {
      char: string
      bright: boolean
    }
    interface Row {
      y: number
      x: number
      speed: number
      tokens: Token[]
      alpha: number
    }

    let rows: Row[] = []
    let width = 0
    let height = 0
    let raf = 0

    const randToken = (): Token => ({
      char: GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? '0',
      bright: Math.random() > 0.85,
    })

    const buildRows = () => {
      rows = []
      const count = Math.floor(height / ROW_GAP)
      for (let i = 0; i < count; i++) {
        const tokenCount = Math.ceil(width / (FONT_SIZE * 0.7)) + 20
        rows.push({
          y: i * ROW_GAP + ROW_GAP,
          x: -Math.random() * width,
          speed: 0.15 + Math.random() * 0.7,
          alpha: 0.2 + Math.random() * 0.5,
          tokens: Array.from({ length: tokenCount }, randToken),
        })
      }
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = `${FONT_SIZE}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.textBaseline = 'middle'
      buildRows()
    }

    const drawFrame = () => {
      ctx.clearRect(0, 0, width, height)
      const charW = FONT_SIZE * 0.7
      for (const row of rows) {
        let drawX = row.x
        for (const token of row.tokens) {
          if (drawX > -charW && drawX < width) {
            ctx.fillStyle = token.bright
              ? `rgba(255,255,255,${row.alpha})`
              : `rgba(160,160,160,${row.alpha * 0.6})`
            ctx.fillText(token.char, drawX, row.y)
          }
          drawX += charW
        }
      }
    }

    const draw = () => {
      const charW = FONT_SIZE * 0.7
      for (const row of rows) {
        row.x += row.speed
        if (row.x > 0) row.x -= charW // keep the row scrolling seamlessly
        // Occasionally mutate a token so the stream feels alive.
        if (Math.random() > 0.7) {
          row.tokens[Math.floor(Math.random() * row.tokens.length)] = randToken()
        }
      }
      drawFrame()
      raf = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize)

    if (reduceMotion) {
      drawFrame() // one static frame instead of animating
    } else {
      raf = requestAnimationFrame(draw)
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{
        // Fade the stream out toward the top and bottom edges.
        maskImage: 'linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)',
      }}
    />
  )
}

import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { approveCliAuth } from '../api'
import { Wordmark } from '../components/Wordmark'

// Browser side of `mdocs auth login`: the user confirms the code their CLI shows.
export function CliAuthPage() {
  const [params] = useSearchParams()
  const [code, setCode] = useState(params.get('code') ?? '')
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle')

  async function onApprove() {
    setState('working')
    setState((await approveCliAuth(code.trim())) ? 'done' : 'error')
  }

  return (
    <div className="cli-auth">
      <div className="cli-auth-card">
        <Wordmark />
        <h2>Authorize the mdocs CLI</h2>
        {state === 'done' ? (
          <p className="muted">Approved ✓ — you can return to your terminal.</p>
        ) : (
          <>
            <p className="muted">Confirm the code shown in your terminal to grant the CLI access to your account.</p>
            <input
              className="search"
              value={code}
              placeholder="WXYZ-1234"
              onChange={(e) => setCode(e.target.value)}
            />
            {state === 'error' && <p className="error">That code is invalid or expired. Re-run `mdocs auth login`.</p>}
            <button className="btn primary" onClick={onApprove} disabled={!code.trim() || state === 'working'}>
              {state === 'working' ? 'Authorizing…' : 'Authorize'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { type ActivityItem, getActivity, getPlan, type PlanInfo } from '../api'
import { BILLING_ON } from '../config'
import { Wordmark } from '../components/Wordmark'
import { UserMenu } from '../components/UserMenu'

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="muted">
          {used}
          {limit != null ? ` / ${limit}` : ' · unlimited'}
        </span>
      </div>
      {limit != null && (
        <div className="meter-bar">
          <div className="meter-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

export function AccountPage() {
  const [plan, setPlan] = useState<PlanInfo | null>(null)
  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [params] = useSearchParams()
  const upgradeHint = params.get('upgrade') // e.g. 'workspaces' (deep-link from a gated action)

  useEffect(() => {
    getPlan().then(setPlan, () => {})
    getActivity().then(setActivity, () => setActivity([]))
  }, [])

  return (
    <>
      <div className="topbar">
        <Wordmark />
        <span className="spacer" />
        <UserMenu />
      </div>
      <div className="account-wrap">
        <section className="account-section">
          <div className="account-head">
            <h2>Plan & usage</h2>
            {BILLING_ON && plan?.planName !== 'Pro' && (
              <Link className="btn primary" to="/pricing">
                Upgrade
              </Link>
            )}
          </div>
          {plan ? (
            <>
              <p className="plan-line">
                You're on <strong>{plan.planName}</strong>.
              </p>
              {upgradeHint === 'workspaces' && !plan.entitlements.teamWorkspaces && (
                <div className="upgrade-note">
                  You've reached your workspace limit on {plan.planName}. Upgrade to create unlimited team
                  workspaces and invite collaborators.
                </div>
              )}
              {upgradeHint === 'trash' && plan.planName !== 'Pro' && (
                <div className="upgrade-note">
                  {plan.planName} keeps deleted docs and workspaces for 15 days. Upgrade to Pro to restore
                  anything from the last 90 days.
                </div>
              )}
              <Meter label="Documents" used={plan.usage.docs} limit={plan.entitlements.maxDocs} />
              <Meter
                label="Workspaces"
                used={plan.usage.workspaces}
                limit={plan.entitlements.teamWorkspaces ? null : 1}
              />
              <div className="plan-attr">
                <span>Collaborators per document</span>
                <span className="muted">
                  {plan.entitlements.maxCollaboratorsPerDoc == null
                    ? 'unlimited'
                    : `up to ${plan.entitlements.maxCollaboratorsPerDoc}`}
                </span>
              </div>
              {plan.entitlements.teamWorkspaces && (
                <div className="plan-attr">
                  <span>Members per workspace</span>
                  <span className="muted">
                    {plan.entitlements.maxMembersPerWorkspace == null
                      ? 'unlimited'
                      : `up to ${plan.entitlements.maxMembersPerWorkspace}`}
                  </span>
                </div>
              )}
              <div className="plan-attr">
                <span>Deleted items recoverable for</span>
                <span className="muted">{plan.entitlements.trashRetentionDays} days</span>
              </div>
              <Meter label="API calls this month" used={plan.usage.apiCalls} limit={plan.entitlements.apiCallsPerMonth} />
            </>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </section>

        <section className="account-section">
          <h2>Activity</h2>
          <p className="muted">Recent CLI &amp; agent API requests.</p>
          {activity === null && <p className="muted">Loading…</p>}
          {activity?.length === 0 && <p className="muted">No API activity yet.</p>}
          {activity && activity.length > 0 && (
            <table className="activity">
              <tbody>
                {activity.map((a, i) => (
                  <tr key={i}>
                    <td className="act-method">{a.method}</td>
                    <td className="act-path">{a.path}</td>
                    <td className={`act-status ${a.status >= 400 ? 'err' : ''}`}>{a.status}</td>
                    <td className="muted act-time">{new Date(a.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  )
}

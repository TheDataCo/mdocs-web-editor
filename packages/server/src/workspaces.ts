import { sql } from './db/index.js'

export interface WorkspaceRow {
  id: string
  type: 'personal' | 'team'
  name: string
  role: string // the requesting user's role in it
}

/** Every user has exactly one personal workspace; create it on demand. */
export async function ensurePersonalWorkspace(userId: string): Promise<string> {
  const [existing] = await sql<{ id: string }[]>`
    select id from workspaces where type = 'personal' and owner_id = ${userId} limit 1
  `
  if (existing) return existing.id

  return sql.begin(async (tx) => {
    const [ws] = await tx<{ id: string }[]>`
      insert into workspaces (type, name, owner_id) values ('personal', 'Personal', ${userId})
      returning id
    `
    await tx`
      insert into workspace_members (workspace_id, user_id, role) values (${ws!.id}, ${userId}, 'owner')
      on conflict do nothing
    `
    return ws!.id
  })
}

/** Claim any pending invitations for this user's email → join those workspaces. */
export async function claimInvitations(userId: string): Promise<void> {
  const invites = await sql<{ id: string; workspace_id: string; role: string }[]>`
    select i.id, i.workspace_id, i.role from workspace_invitations i
    join users u on u.id = ${userId}
    where lower(i.email) = lower(u.email) and i.accepted_at is null
  `
  for (const inv of invites) {
    await sql.begin(async (tx) => {
      await tx`
        insert into workspace_members (workspace_id, user_id, role)
        values (${inv.workspace_id}, ${userId}, ${inv.role})
        on conflict (workspace_id, user_id) do nothing
      `
      await tx`update workspace_invitations set accepted_at = now() where id = ${inv.id}`
    })
  }
}

export async function listWorkspaces(userId: string): Promise<WorkspaceRow[]> {
  return sql<WorkspaceRow[]>`
    select w.id, w.type, w.name, m.role
    from workspaces w
    join workspace_members m on m.workspace_id = w.id and m.user_id = ${userId}
    order by (w.type = 'personal') desc, w.name asc
  `
}

export async function createTeamWorkspace(userId: string, name: string): Promise<WorkspaceRow> {
  return sql.begin(async (tx) => {
    const [ws] = await tx<{ id: string }[]>`
      insert into workspaces (type, name, owner_id) values ('team', ${name}, ${userId})
      returning id
    `
    await tx`
      insert into workspace_members (workspace_id, user_id, role) values (${ws!.id}, ${userId}, 'owner')
    `
    return { id: ws!.id, type: 'team', name, role: 'owner' }
  })
}

export async function isMember(userId: string, workspaceId: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    select exists(
      select 1 from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}
    ) as exists
  `
  return row?.exists ?? false
}

export async function memberRole(userId: string, workspaceId: string): Promise<string | null> {
  const [row] = await sql<{ role: string }[]>`
    select role from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}
  `
  return row?.role ?? null
}

export async function listMembers(workspaceId: string) {
  return sql<{ user_id: string; email: string; name: string | null; role: string }[]>`
    select m.user_id, u.email, u.name, m.role
    from workspace_members m join users u on u.id = m.user_id
    where m.workspace_id = ${workspaceId}
    order by m.created_at asc
  `
}

/** Invite by email. If the user already exists, add them directly; else queue an invitation. */
export async function inviteToWorkspace(workspaceId: string, email: string, role: string, invitedBy: string) {
  const [user] = await sql<{ id: string }[]>`select id from users where lower(email) = lower(${email})`
  if (user) {
    await sql`
      insert into workspace_members (workspace_id, user_id, role)
      values (${workspaceId}, ${user.id}, ${role})
      on conflict (workspace_id, user_id) do update set role = excluded.role
    `
    return { status: 'added' as const }
  }
  await sql`
    insert into workspace_invitations (workspace_id, email, role, invited_by)
    values (${workspaceId}, ${email}, ${role}, ${invitedBy})
  `
  return { status: 'invited' as const }
}

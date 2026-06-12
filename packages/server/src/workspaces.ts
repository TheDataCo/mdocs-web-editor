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
    select id from workspaces
    where type = 'personal' and owner_id = ${userId} and deleted_at is null
    limit 1
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
    where w.deleted_at is null
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

export async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  await sql`update workspaces set name = ${name}, updated_at = now() where id = ${workspaceId}`
}

export async function workspaceOwnerId(workspaceId: string): Promise<string | null> {
  const [row] = await sql<{ owner_id: string }[]>`select owner_id from workspaces where id = ${workspaceId}`
  return row?.owner_id ?? null
}

/** Seats taken in a workspace: current members + invitations not yet claimed. */
export async function countWorkspaceSeats(workspaceId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select (select count(*)::int from workspace_members where workspace_id = ${workspaceId})
         + (select count(*)::int from workspace_invitations
            where workspace_id = ${workspaceId} and accepted_at is null) as n
  `
  return row?.n ?? 0
}

/** Is this email already a member of (or invited to) the workspace? Re-invites
 * to change a role shouldn't count against the seat cap. */
export async function hasWorkspaceSeat(workspaceId: string, email: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    select exists(
      select 1 from workspace_members m join users u on u.id = m.user_id
      where m.workspace_id = ${workspaceId} and lower(u.email) = lower(${email})
      union
      select 1 from workspace_invitations
      where workspace_id = ${workspaceId} and lower(email) = lower(${email}) and accepted_at is null
    ) as ok
  `
  return row?.ok ?? false
}

export async function workspaceType(workspaceId: string): Promise<string | null> {
  const [row] = await sql<{ type: string }[]>`
    select type from workspaces where id = ${workspaceId} and deleted_at is null
  `
  return row?.type ?? null
}

/** Soft-delete a workspace and everything in it (docs stay recoverable). now()
 * is constant within the transaction, so the docs share the workspace's exact
 * deleted_at — that's how restoreWorkspace knows which docs went down with it. */
export async function softDeleteWorkspace(workspaceId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update docs set deleted_at = now(), updated_at = now()
      where workspace_id = ${workspaceId} and deleted_at is null
    `
    await tx`update workspaces set deleted_at = now(), updated_at = now() where id = ${workspaceId}`
  })
}

export interface TrashedWorkspaceRow {
  id: string
  name: string
  deleted_at: string
  doc_count: number
}

/** Deleted workspaces this user owns, within their plan's retention window. */
export async function listTrashedWorkspaces(userId: string, days: number): Promise<TrashedWorkspaceRow[]> {
  return sql<TrashedWorkspaceRow[]>`
    select w.id, w.name, w.deleted_at,
      (select count(*)::int from docs d
       where d.workspace_id = w.id and d.deleted_at = w.deleted_at) as doc_count
    from workspaces w
    join workspace_members m on m.workspace_id = w.id and m.user_id = ${userId} and m.role = 'owner'
    where w.deleted_at is not null
      and w.deleted_at > now() - make_interval(days => ${days})
    order by w.deleted_at desc
  `
}

/** Restore a workspace and the docs that were deleted with it. */
export async function restoreWorkspace(workspaceId: string, days: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [ws] = await tx<{ deleted_at: string }[]>`
      select deleted_at from workspaces
      where id = ${workspaceId} and deleted_at is not null
        and deleted_at > now() - make_interval(days => ${days})
      for update
    `
    if (!ws) return false
    await tx`
      update docs set deleted_at = null, updated_at = now()
      where workspace_id = ${workspaceId} and deleted_at = ${ws.deleted_at}
    `
    await tx`update workspaces set deleted_at = null, updated_at = now() where id = ${workspaceId}`
    return true
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

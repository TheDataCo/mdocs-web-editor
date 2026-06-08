import { sql } from './db/index.js'

export interface DocRow {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export async function listDocs(): Promise<DocRow[]> {
  return sql<DocRow[]>`
    select id, title, created_at, updated_at
    from docs
    where deleted_at is null
    order by updated_at desc
  `
}

export async function getDoc(id: string): Promise<DocRow | undefined> {
  const [row] = await sql<DocRow[]>`
    select id, title, created_at, updated_at
    from docs
    where id = ${id} and deleted_at is null
  `
  return row
}

export async function createDoc(title: string): Promise<DocRow> {
  const [row] = await sql<DocRow[]>`
    insert into docs (title)
    values (${title})
    returning id, title, created_at, updated_at
  `
  return row!
}

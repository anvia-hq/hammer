export interface Db { query(sql: string): Promise<Array<{ id: number; name: string }>> }

export async function findUser(db: Db, name: string) {
  const rows = await db.query(`SELECT id, name FROM users WHERE name = '${name}'`);
  return rows[0];
}

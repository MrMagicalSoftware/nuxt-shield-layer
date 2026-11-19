import type { ShieldStore } from './types.mjs'

/** Basta il metodo query di un pool di mysql2/promise. */
export interface MysqlQueryable {
  query(sql: string, values?: unknown[]): Promise<unknown>
}

/** Istruzioni CREATE TABLE IF NOT EXISTS delle tabelle usate. */
export declare const SHIELD_MYSQL_TABLES: string[]

/** Archivio su MySQL / MariaDB (tabelle shield_ban, shield_fidato, shield_paese). */
export declare function createMysqlShieldStore(
  pool: MysqlQueryable | (() => MysqlQueryable | Promise<MysqlQueryable>),
  options?: { createTables?: boolean },
): ShieldStore

import 'dotenv/config';
import pg, { type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:8,idleTimeoutMillis:30_000,connectionTimeoutMillis:15_000,ssl:process.env.DATABASE_URL?.includes('sslmode=')?undefined:process.env.NODE_ENV==='production'?{rejectUnauthorized:true}:undefined});
pool.on('error',()=>console.error('Database connection interrupted; pool will reconnect.'));
export async function query<T=any>(sql:string,params:any[]=[]):Promise<T[]>{return (await pool.query(sql,params)).rows;}
export async function one<T=any>(sql:string,params:any[]=[]):Promise<T|undefined>{return (await query<T>(sql,params))[0];}
export async function transaction<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function migrate(){const sql=await readFile(fileURLToPath(new URL('./schema.sql',import.meta.url)),'utf8');await transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(73422311)');await c.query(sql);});}

import {AppError} from './security'
import {sql,type Kysely} from 'kysely'
import {z} from 'zod'
import type {Schema} from './db'
import {authorize,type Principal} from './auth'
import {audit} from './agents'

export type ArtifactCommentUpdate={revision:number;comment:string|null}
export function artifactCommentInput(value:unknown):ArtifactCommentUpdate{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalidComment()
 const input=value as Record<string,unknown>
 if(Object.keys(input).some(key=>key!=='revision'&&key!=='comment')||!Number.isSafeInteger(input.revision)||Number(input.revision)<1||Number(input.revision)>2147483647||input.comment!==null&&(typeof input.comment!=='string'||input.comment.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.comment)))throw invalidComment()
 return {revision:Number(input.revision),comment:typeof input.comment==='string'?input.comment.trim()||null:null}
}
function invalidComment(){return new AppError('INVALID_COMMENT','Use plain text up to 2000 characters and the current comment revision.',422)}
type CommentDto={id:string;comment:string|null;comment_revision:number;commented_at:Date|null}
function identifier(value:string){if(!z.uuid().safeParse(value).success)throw new AppError('INVALID_ID','Use a valid snapshot identifier.');return value}
export class ArtifactCommentServices{
 constructor(readonly db:Kysely<Schema>){}
 async get(principal:Principal,artifactId:string){
  authorize(principal,'read');identifier(artifactId)
  const row=(await sql<CommentDto>`SELECT id,comment,comment_revision,commented_at FROM artifacts WHERE id=${artifactId}::uuid`.execute(this.db)).rows[0]
  if(!row)throw new AppError('NOT_FOUND','Backup not found.',404);return row
 }
 async update(principal:Principal,artifactId:string,value:unknown){
  authorize(principal,'configure');identifier(artifactId);const input=artifactCommentInput(value)
  return this.db.transaction().execute(async trx=>{
   // The CAS updates metadata only, including retained tombstones; it never touches stored bytes.
   const changed=(await sql<CommentDto>`UPDATE artifacts SET comment=${input.comment},comment_revision=comment_revision+1,commented_at=clock_timestamp() WHERE id=${artifactId}::uuid AND comment_revision=${input.revision} AND comment IS DISTINCT FROM ${input.comment} RETURNING id,comment,comment_revision,commented_at`.execute(trx)).rows[0]
   if(changed){await audit(trx,principal.actor,'backup.comment.updated',artifactId);return changed}
   const current=(await sql<CommentDto>`SELECT id,comment,comment_revision,commented_at FROM artifacts WHERE id=${artifactId}::uuid`.execute(trx)).rows[0]
   if(!current)throw new AppError('NOT_FOUND','Backup not found.',404)
   if(current.comment_revision!==input.revision)throw new AppError('REVISION_CONFLICT','This note changed. Reload it before saving your draft.',409)
   return current
  })
 }
}

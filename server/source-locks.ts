import type {Services} from './services'
import type {SourceLockContext,SourceLockHooks} from './engines/types'
import {AppError} from './security'
import type {Kysely} from 'kysely'
import type {Schema} from './db'
import {resourceKey,type Resource} from './resources'

export async function sourceBlocked(db:Kysely<Schema>,source:Resource):Promise<boolean> {
  const query=db.selectFrom('source_blocks').select('run_id')
  // A Mongo fsync journal covers every database; endpoint aliases are not trustworthy identities.
  return Boolean(await (source.kind==='mongodb'?query.where('resource_key','like','mongodb:%'):query.where('resource_key','=',resourceKey(source))).executeTakeFirst())
}

/** A crashed process leaves this journal intact: fsync locks can outlive the worker. */
export function createSourceLockHooks(services:Services,runId:string,executionToken:string):SourceLockHooks {
  const owned=(context:SourceLockContext)=>services.db.selectFrom('source_blocks').selectAll()
    .where('resource_key','=',context.resourceKey).where('server_identity','=',context.serverIdentity)
    .where('run_id','=',runId).where('execution_token','=',executionToken).where('owner_token','=',context.ownerToken)
  return {
    async beforeAcquire(context){
      await services.db.transaction().execute(async trx=>{
        const run=await trx.selectFrom('runs').select(['status','cancel_requested','execution_token'])
          .where('id','=',runId).forUpdate().executeTakeFirst()
        if(!run||run.execution_token!==executionToken||run.status!=='running'||run.cancel_requested)throw new AppError('OWNERSHIP_LOST','Source lock acquisition requires current execution ownership.')
        // Both the configured endpoint and process identity exclude concurrent aliases.
        const inserted=await trx.insertInto('source_blocks').values({resource_key:context.resourceKey,server_identity:context.serverIdentity,run_id:runId,execution_token:executionToken,owner_token:context.ownerToken,state:'acquiring',reason_code:null,updated_at:new Date()}).onConflict(conflict=>conflict.doNothing()).returning('resource_key').executeTakeFirst()
        if(!inserted)throw new AppError('SOURCE_BLOCKED','A previous source lock requires operator reconciliation before another backup.',409)
        await trx.insertInto('events').values({run_id:runId,phase:'source-lock',message:'Source lock acquisition journaled. A worker interruption requires source lock reconciliation.'}).execute()
      })
    },
    async afterRelease(context){
      await services.db.transaction().execute(async trx=>{
        const row=await trx.selectFrom('source_blocks').selectAll().where('resource_key','=',context.resourceKey).forUpdate().executeTakeFirst()
        if(!row||row.run_id!==runId||row.execution_token!==executionToken||row.owner_token!==context.ownerToken||row.server_identity!==context.serverIdentity||row.state==='uncertain')throw new AppError('SOURCE_LOCK_UNCERTAIN','Source lock journal ownership requires operator reconciliation.')
        await trx.deleteFrom('source_blocks').where('resource_key','=',context.resourceKey).where('owner_token','=',context.ownerToken).execute()
        await trx.insertInto('events').values({run_id:runId,phase:'source-unlocked',message:'The operation’s acknowledged source lock was released and its journal cleared.'}).execute()
      })
    },
    async onUncertain(context,reasonCode){
      const row=await owned(context).executeTakeFirst()
      if(!row)throw new AppError('SOURCE_LOCK_UNCERTAIN','The source lock journal could not be reconciled.')
      // Only internal reason codes are persisted; no driver response or credential data.
      const code=/^[A-Z0-9_]{1,80}$/.test(reasonCode)?reasonCode:'SOURCE_LOCK_OUTCOME_UNKNOWN'
      await services.db.updateTable('source_blocks').set({state:'uncertain',reason_code:code,updated_at:new Date()})
        .where('resource_key','=',context.resourceKey).where('owner_token','=',context.ownerToken).where('execution_token','=',executionToken).execute()
    }
  }
}

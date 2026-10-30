import type {Services} from '../services'
import {AppError} from '../security'

export function runControl(services:Services,runId:string,token:string,signal:AbortSignal){
  const check=async()=>{
    if(signal.aborted)throw new AppError('CANCELLED','Operation cancelled.')
    const row=await services.db.selectFrom('runs').select(['status','cancel_requested','execution_token']).where('id','=',runId).executeTakeFirst()
    if(!row||row.execution_token!==token||!['running','cancelling'].includes(row.status))throw new AppError('OWNERSHIP_LOST','Execution ownership was lost.')
    if(row.cancel_requested||row.status==='cancelling')throw new AppError('CANCELLED','Operation cancelled.')
  }
  const phase=async(value:string,message:string)=>{
    await check()
    await services.db.transaction().execute(async trx=>{
      const changed=await trx.updateTable('runs').set({phase:value}).where('id','=',runId).where('execution_token','=',token).where('status','=','running').where('cancel_requested','=',false).executeTakeFirst()
      if(!changed.numUpdatedRows)throw new AppError('OWNERSHIP_LOST','Execution ownership was lost.')
      await trx.insertInto('events').values({run_id:runId,phase:value,message}).execute()
    })
    await check()
  }
  return {check,phase}
}

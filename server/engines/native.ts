import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {DatabaseConfig,DbSecret} from '../services'
import {AppError} from '../security'
import {runTool,toolEnv} from '../process'
import {DatabaseSession,nativeCredentials,nativeVersion,digest} from './database'
import type {AdapterOptions,Engine,EngineAdapter,EnginePhase,Manifest} from './types'

export class NativeAdapter extends DatabaseSession implements EngineAdapter {
  readonly archiveExtension:string
  private credentials:DbSecret
  constructor(engine:Engine,options:AdapterOptions){
    super(engine,options.config as DatabaseConfig,options.secret as DbSecret,options.signal)
    this.archiveExtension=engine==='postgres'?'.dump':'.sql';this.credentials=options.secret as DbSecret
  }
  async backup(file:string,dir:string,signal:AbortSignal,phase:EnginePhase){
    const tool=await nativeVersion(this.engine,signal)
    const credentials=await nativeCredentials(this.engine,this.config,this.credentials,dir)
    if(this.engine!=='postgres'&&!this.config.allowGlobalReadLock)throw new AppError('SOURCE_LOCK_OPT_IN','MySQL/MariaDB capture requires explicit permission to hold a global source read lock during backup.')
    await this.sourceMetadataVisibility()
    await phase('manifest','Capturing the source schema, data digests and sequence state.')
    const snapshot=await this.beginSnapshot()
    let manifest:Manifest
    try{
      manifest=await this.manifest()
      await phase('dumping',this.engine==='postgres'?'Creating a PostgreSQL archive from the exported source snapshot.':'Creating an SQL archive while the explicit source read lock keeps data and validation aligned.')
      if(this.engine==='postgres'){
        await runTool('pg_dump',[...credentials.args,'--format=custom','--no-owner','--no-acl','--no-tablespaces','--snapshot',snapshot!,'--file',file],{signal,env:credentials.env})
        const after=await this.manifest()
        if(digest(manifest.sequences)!==digest(after.sequences))throw new AppError('SOURCE_CHANGED','Sequence state changed during the dump. Retry while source writes are quiescent.')
      }else{
        const flags=['--single-transaction','--skip-lock-tables','--skip-add-locks','--skip-add-drop-table','--skip-triggers','--skip-routines','--skip-events','--hex-blob','--quick','--default-character-set=utf8mb4']
        if(this.engine==='mysql')flags.push('--no-tablespaces','--set-gtid-purged=OFF','--column-statistics=0')
        await runTool(tool.binary,[...credentials.args,...flags,this.config.database],{signal,env:credentials.env,stdoutFile:file})
      }
    }finally{await this.finishSnapshot()}
    return {manifest,toolVersion:tool.version}
  }
  async restore(file:string,dir:string,signal:AbortSignal){
    const credentials=await nativeCredentials(this.engine,this.config,this.credentials,dir)
    const binary=this.engine==='postgres'?'pg_restore':this.engine==='mariadb'?'mariadb':'mysql'
    const toolVersion=await runTool(binary,['--version'],{env:toolEnv(),signal,capture:true,timeoutMs:10000})
    if(this.engine==='postgres'&&!/\b17\./.test(toolVersion))throw new AppError('UNSUPPORTED_TOOL','PostgreSQL 17 restore tools are required.')
    if(this.engine==='mariadb'&&(!/mariadb/i.test(toolVersion)||!/(?:Distrib |from |Ver )11\./i.test(toolVersion)))throw new AppError('UNSUPPORTED_TOOL','MariaDB 11 restore tools are required.')
    if(this.engine==='mysql'&&(!/\b8\./.test(toolVersion)||/mariadb/i.test(toolVersion)))throw new AppError('UNSUPPORTED_TOOL','MySQL 8 restore tools are required.')
    if(this.engine==='postgres'){
      const listing=await runTool('pg_restore',['--list',file],{env:toolEnv(),signal,capture:true,captureLimitBytes:2*1024*1024})
      const filtered=listing.split('\n').filter(line=>!/^\d+;\s+\d+\s+\d+\s+(?:SCHEMA - public(?:\s|$)|(?:COMMENT|ACL) - SCHEMA public(?:\s|$))/.test(line)).join('\n')+'\n'
      const toc=join(dir,'restore.list');await writeFile(toc,filtered,{mode:0o600,flag:'wx'})
      await runTool(binary,[...credentials.args,'--no-owner','--no-privileges','--no-tablespaces','--exit-on-error','--single-transaction','--use-list',toc,file],{signal,env:credentials.env})
    }else{
      await runTool(binary,[...credentials.args,'--binary-mode','--default-character-set=utf8mb4','--skip-reconnect',this.config.database],{signal,env:credentials.env,stdinFile:file})
    }
    return {toolVersion}
  }
}

export const createNativeAdapter=(engine:Engine,options:AdapterOptions)=>new NativeAdapter(engine,options)

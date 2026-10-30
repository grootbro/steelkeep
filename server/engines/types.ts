export type Engine='postgres'|'mysql'|'mariadb'|'mongodb'|'sqlite'|'redis'|'clickhouse'|'mssql'
export type Identity={engine:Engine;database:string;serverVersion:string;binding?:string}
export type Manifest=Identity&{format:1;objects:Record<string,unknown>;data:Record<string,unknown>;sequences:Record<string,unknown>}
export type EnginePhase=(phase:string,message:string)=>Promise<void>
export type ValidationComparison={passed:boolean;checks:{schema:boolean;data:boolean;sequences:boolean};tableCount:number;method:string;note:string}
export type SourceLockContext={resourceKey:string;serverIdentity:string;ownerToken:string}
export type SourceLockHooks={
  beforeAcquire(context:SourceLockContext):Promise<void>
  afterRelease(context:SourceLockContext):Promise<void>
  onUncertain(context:SourceLockContext,reasonCode:string):Promise<void>
}
export type AdapterOptions={config:Record<string,unknown>;secret:Record<string,unknown>;signal:AbortSignal;lockHooks?:SourceLockHooks;checkpoint?:()=>Promise<void>}
export interface EngineAdapter {
  readonly engine:Engine
  readonly archiveExtension:string
  readonly failureSignal:AbortSignal
  connect():Promise<Identity>
  identity():Promise<Identity>
  empty():Promise<boolean>
  restrictedRestoreRole():Promise<void>
  manifest():Promise<Manifest>
  backup(file:string,dir:string,signal:AbortSignal,phase:EnginePhase):Promise<{manifest:Manifest;toolVersion:string}>
  restore(file:string,dir:string,signal:AbortSignal,expected:Manifest):Promise<{toolVersion:string}>
  compare?(expected:Manifest,actual:Manifest):ValidationComparison
  close():Promise<void>
}

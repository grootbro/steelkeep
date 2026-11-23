import type {Kysely} from 'kysely'
import type {Schema} from './db'
import {createEngineAdapter} from './engines'
import type {AdapterOptions,Engine} from './engines/types'
import type {SourceKind} from '../shared/connections'
import {GoogleDriveAdapter} from './google-drive/source'
import {driveClient,type StoredConnection} from './storage'

export function createBackupAdapter(kind:SourceKind,options:AdapterOptions,db:Kysely<Schema>){
 if(kind==='google_drive')return new GoogleDriveAdapter(options,driveClient(db,{id:'',kind,config:options.config,secret:''} satisfies StoredConnection,options.signal))
 return createEngineAdapter(kind as Engine,options)
}

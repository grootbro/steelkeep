import {AppError} from '../security'
import type {Engine,EngineAdapter,AdapterOptions} from './types'
import {createNativeAdapter} from './native'
import {createMongoAdapter} from './mongodb'
import {createSQLiteAdapter} from './sqlite'
import {createRedisAdapter} from './redis'
import {createClickHouseAdapter} from './clickhouse'
import {createMssqlAdapter} from './mssql'

export const engineKinds:Engine[]=['postgres','mysql','mariadb','mongodb','sqlite','redis','clickhouse','mssql']

export function createEngineAdapter(engine:Engine,options:AdapterOptions):EngineAdapter {
  switch(engine){
    case 'postgres':case 'mysql':case 'mariadb':return createNativeAdapter(engine,options)
    case 'mongodb':return createMongoAdapter(options)
    case 'sqlite':return createSQLiteAdapter(options)
    case 'redis':return createRedisAdapter(options)
    case 'clickhouse':return createClickHouseAdapter(options)
    case 'mssql':return createMssqlAdapter(options)
    default:throw new AppError('INVALID_ENGINE','This database engine is not supported.')
  }
}

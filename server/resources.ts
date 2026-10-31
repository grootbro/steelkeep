import {AppError} from './security'

export type Resource={kind:string;config:Record<string,unknown>}

/** Deliberately conservative across host aliases; canonical local paths are stored at admission. */
export function resourceKey({kind,config}:Resource):string {
  if(kind==='s3')throw new AppError('INVALID_RESOURCE','Storage is not a database restore target.')
  if(kind==='sqlite'){
    if(typeof config.path!=='string'||!config.path.startsWith('/'))throw new AppError('INVALID_RESOURCE','SQLite requires a canonical absolute file path.')
    return `sqlite:${config.path}`
  }
  if(kind==='redis'){
    if(!Number.isInteger(config.dbIndex)||Number(config.dbIndex)<0||Number(config.dbIndex)>15)throw new AppError('INVALID_RESOURCE','Redis requires a logical database index from 0 to 15.')
    return `redis:${config.dbIndex}`
  }
  if(typeof config.database!=='string'||!config.database)throw new AppError('INVALID_RESOURCE','The database resource name is missing.')
  return `${kind==='mariadb'?'mysql':kind}:${config.database.toLowerCase()}`
}

export function sameResource(a:Resource,b:Resource):boolean {return resourceKey(a)===resourceKey(b)}

export function sourceAdmissionKey(resource:Resource):string {
  // shortcut: serialize independent Mongo servers too, until verified physical identity is available at admission.
  return resource.kind==='mongodb'?'mongodb:all-sources':resourceKey(resource)
}

export function sourceBlockMatches(resource:Resource,key:string):boolean {
  return resource.kind==='mongodb'?key.startsWith('mongodb:'):key===resourceKey(resource)
}

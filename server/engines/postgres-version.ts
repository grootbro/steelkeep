import {AppError} from '../security'

export type PostgresMajor=17|18
export function postgresMajor(version:string):PostgresMajor{
 const match=/^(17|18)(?:\.\d+)+(?:\s|$)/.exec(version)
 if(!match)throw new AppError('UNSUPPORTED_VERSION','This PostgreSQL profile supports server versions 17 and 18 only.')
 return Number(match[1]) as PostgresMajor
}
export function postgresTools(serverVersion:string){
 const major=postgresMajor(serverVersion)
 // Separate names preserve the existing PostgreSQL 17 PATH and dependency closure.
 return {major,dump:major===18?'pg_dump18':'pg_dump',restore:major===18?'pg_restore18':'pg_restore'} as const
}
export function assertPostgresTool(version:string,major:PostgresMajor,operation:'dump'|'restore'){
 if(!new RegExp(`^pg_${operation} \\(PostgreSQL\\) ${major}\\.\\d+(?:\\s|$)`).test(version.trim()))throw new AppError('UNSUPPORTED_TOOL',`PostgreSQL ${major} ${operation} client tools are required for this server major.`)
}
export function assertPostgresRestoreVersion(sourceVersion:string,targetVersion:string){
 if(postgresMajor(sourceVersion)!==postgresMajor(targetVersion))throw new AppError('VERSION_MISMATCH','PostgreSQL source and target must use the same supported major version (17 or 18). Cross-major recovery requires a separately qualified migration profile.')
}

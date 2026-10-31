import {t} from 'elysia'
import {jobResponse,artifactResponse} from './contracts'

const optionalId=t.Optional(t.String({format:'uuid'}))
const oneOf=<const T extends readonly [string,...string[]]>(values:T)=>{
  const schema=t.UnionEnum(values)
  // Elysia supplies the first enum member as a default; omitted filters must stay absent.
  delete schema.default
  return t.Optional(schema)
}
const common={limit:t.Optional(t.Numeric({minimum:1,maximum:100})),cursor:t.Optional(t.String({minLength:1,maxLength:4096})),order:oneOf(['newest','oldest']),id:optionalId,sourceId:optionalId,storageId:optionalId,search:t.Optional(t.String({maxLength:100})),from:t.Optional(t.String({format:'date-time'})),until:t.Optional(t.String({format:'date-time'}))}
export const jobHistoryQuery=t.Object({...common,targetId:optionalId,planId:optionalId,type:oneOf(['backup','restore']),status:oneOf(['queued','running','cancelling','succeeded','failed','cancelled','interrupted'])},{additionalProperties:false})
export const snapshotHistoryQuery=t.Object({...common,engine:oneOf(['postgres','mysql','mariadb','mongodb','sqlite','redis','clickhouse','mssql']),availability:oneOf(['present','missing','changed','unknown']),deletionState:oneOf(['active','queued','deleting','held','deleted'])},{additionalProperties:false})
const page={nextCursor:t.Nullable(t.String()),limit:t.Integer(),order:t.Union([t.Literal('newest'),t.Literal('oldest')])}
export const jobHistoryResponse=t.Object({...page,items:t.Array(t.Intersect([jobResponse,t.Object({source_name:t.String(),storage_name:t.String(),target_name:t.Nullable(t.String())})]))})
export const snapshotHistoryResponse=t.Object({...page,items:t.Array(t.Intersect([artifactResponse,t.Object({source_name:t.String(),storage_name:t.String()})]))})

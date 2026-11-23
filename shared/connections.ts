import {engineProfiles} from './engines'

export const sourceKinds=[...engineProfiles.map(profile=>profile.kind),'google_drive'] as const
export type SourceKind=typeof sourceKinds[number]
export const storageKinds=['s3','google_drive_storage'] as const
export function isStorageKind(kind:string){return kind==='s3'||kind==='google_drive_storage'}
export function isSourceKind(kind:string):kind is SourceKind{return sourceKinds.some(value=>value===kind)}

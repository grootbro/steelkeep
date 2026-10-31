import type {Connection} from './state'
export type ConnectionRole='source'|'storage'|'target'
export type ConnectionOrder='newest'|'oldest'|'name_asc'|'name_desc'
export type BrowsedConnection=Connection&{role:ConnectionRole;created_at:string}
export type ConnectionPage={items:BrowsedConnection[];nextCursor:string|null;total:number;limit:number;order:ConnectionOrder}
export type ConnectionSummary={connection:Connection;role:ConnectionRole;scope:'all-recorded-history';plans:{total:number;enabled:number};jobs:{total:number;backup:number;restore:number;queued:number;running:number;cancelling:number;succeeded:number;failed:number;cancelled:number;interrupted:number};snapshots:{total:number;retained:number;deleted:number;locked:number;retainedBytes:string;scope:'metadata-records';physicalUsage:'not-measured'};holds:{sourceBlocked:boolean;targetBlocked:boolean}}

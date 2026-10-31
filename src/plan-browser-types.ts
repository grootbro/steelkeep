import type {DatabaseKind} from '../shared/engines'
import type {Plan} from './state'

export type PlanOrder='newest'|'oldest'|'name_asc'|'name_desc'|'next_due'
export type BrowsedPlan=Plan&{source_name:string;storage_name:string;source_kind:DatabaseKind}
export type PlanPage={items:BrowsedPlan[];nextCursor:string|null;total:number;limit:number;order:PlanOrder;summary:{scope:'all-recorded-plans';total:number;enabled:number;paused:number;scheduled:number;manual:number}}

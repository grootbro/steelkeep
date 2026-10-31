import {t} from 'elysia'
const uuid=t.String({format:'uuid'})
export const artifactDeletionReviewInput=t.Object({artifactIds:t.Array(uuid,{minItems:1,maxItems:100,uniqueItems:true})},{additionalProperties:false})
export const artifactDeletionRequestInput=t.Object({reviewId:uuid,idempotencyKey:t.String({minLength:16,maxLength:160,pattern:'^[^\\r\\n\\u0000]+$'}),confirmDeletion:t.Literal(true)},{additionalProperties:false})
const item=t.Object({id:uuid,sourceName:t.String(),storageName:t.String(),size:t.String(),createdAt:t.String(),deletionState:t.String(),eligible:t.Boolean(),reason:t.Nullable(t.UnionEnum(['locked','restore_review','restore_active','restore_uncertain','source_uncertain','target_uncertain','deletion_reserved','deleted','ownership_uncertain']))})
export const artifactDeletionReviewResponse=t.Object({reviewId:uuid,expiresAt:t.String(),artifactIds:t.Array(uuid),eligibleCount:t.Integer(),blockedCount:t.Integer(),bytes:t.String(),items:t.Array(item),confirmation:t.Literal('permanently-delete-reviewed-snapshots')})
export const artifactDeletionAcceptedResponse=t.Object({reviewId:uuid,idempotencyKey:t.String(),queued:t.Integer(),jobIds:t.Array(uuid),artifactIds:t.Array(uuid)})
export const artifactDeletionReviewDetailResponse=t.Object({review:artifactDeletionReviewResponse,result:t.Nullable(artifactDeletionAcceptedResponse)})

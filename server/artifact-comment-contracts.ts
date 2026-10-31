import {t} from 'elysia'
import {dateResponse} from './contracts'

export const artifactCommentUpdate=t.Object({revision:t.Integer({minimum:1,maximum:2147483647}),comment:t.Nullable(t.String({maxLength:2000}))},{additionalProperties:false})
export const artifactCommentFields={comment:t.Nullable(t.String()),comment_revision:t.Integer({minimum:1}),commented_at:dateResponse}
export const artifactCommentResponse=t.Object({id:t.String({format:'uuid'}),...artifactCommentFields})

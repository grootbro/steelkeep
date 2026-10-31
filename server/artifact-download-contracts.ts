import {t} from 'elysia'
export const artifactDownloadResponse=t.Object({id:t.String({format:'uuid'}),filename:t.String(),size:t.String(),sha256:t.String(),path:t.String(),verification:t.Literal('sha256-before-completion')})

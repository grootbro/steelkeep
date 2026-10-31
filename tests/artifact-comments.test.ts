import {test,expect} from 'bun:test'
import {artifactCommentInput} from '../server/artifact-comments'

test('snapshot notes are plain text, trim outer whitespace and clear without markup processing',()=>{
 expect(artifactCommentInput({revision:1,comment:'  Before upgrade\nSecond line  '})).toEqual({revision:1,comment:'Before upgrade\nSecond line'})
 expect(artifactCommentInput({revision:2,comment:'\n\t '})).toEqual({revision:2,comment:null})
 expect(artifactCommentInput({revision:3,comment:null})).toEqual({revision:3,comment:null})
 expect(artifactCommentInput({revision:1,comment:'<script>alert("literal text")</script>'}).comment).toBe('<script>alert("literal text")</script>')
 expect(artifactCommentInput({revision:1,comment:'x'.repeat(2000)}).comment?.length).toBe(2000)
})
test('note validation rejects invalid revisions, control characters and oversized or extra fields',()=>{
 for(const input of [null,[],{}, {revision:0,comment:'text'},{revision:-1,comment:'text'},{revision:1.5,comment:'text'},{revision:Number.MAX_SAFE_INTEGER+1,comment:'text'},{revision:1},{revision:1,comment:123},{revision:1,comment:'x'.repeat(2001)},{revision:1,comment:'NUL\0text'},{revision:1,comment:'\u001b[31m'},{revision:1,comment:'text',deletion_state:'active'}])expect(()=>artifactCommentInput(input)).toThrow()
})

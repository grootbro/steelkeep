import {test,expect} from 'bun:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('owner setup helper refuses unsafe link origins before reading any installation key',async()=>{
 for(const origin of ['http://example.test','https://user:pass@example.test','https://example.test/path','https://example.test/?query=1','https://example.test/#fragment']){
  const child=Bun.spawn([process.execPath,'scripts/setup-owner.ts'],{cwd:process.cwd(),env:{...process.env,STEELKEEP_SETUP_ORIGIN:origin,STEELKEEP_TOKEN_FILE:'/nonexistent-steelkeep-test-key'},stdout:'pipe',stderr:'pipe'})
  const [out,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  expect(exit).not.toBe(0);expect(out).toBe('');expect(error).toContain('Use your installation HTTPS origin')
 }
})

test('owner setup helper prints only a short-lived capability and handles an existing owner without exposing the installation key',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'steelkeep-setup-cli-')),path=join(directory,'token'),key='synthetic-installation-key-for-cli-only',code='ss_'+'a'.repeat(64)
 let mode:'issue'|'existing'|'redirect'='issue',authorized=false
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
  authorized=request.method==='POST'&&new URL(request.url).pathname==='/api/v1/auth/setup-link'&&request.headers.get('authorization')==='Bearer '+key
  if(mode==='existing')return Response.json({error:{code:'SETUP_COMPLETE'}},{status:409})
  if(mode==='redirect')return Response.redirect('http://synthetic.invalid/not-followed',302)
  return Response.json({code,expiresAt:new Date(Date.now()+300000).toISOString()},{status:201})
 }})
 try{
  await writeFile(path,key,{mode:0o600})
  for(const current of ['issue','existing','redirect'] as const){
   mode=current;authorized=false
   const child=Bun.spawn([process.execPath,'scripts/setup-owner.ts'],{cwd:process.cwd(),env:{...process.env,STEELKEEP_SETUP_ORIGIN:`http://127.0.0.1:${server.port}`,STEELKEEP_TOKEN_FILE:path},stdout:'pipe',stderr:'pipe'})
   const [out,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
   expect(authorized).toBe(true);expect(out+error).not.toContain(key)
   if(current==='issue'){expect(exit).toBe(0);expect(out).toContain(`/#setup=${code}`);expect(out).toContain('five minutes')}
   else{expect(exit).not.toBe(0);expect(out).toBe('');expect(error).toContain(current==='existing'?'An owner account already exists':'Could not reach this installation')}
  }
 }finally{server.stop(true);await rm(directory,{recursive:true,force:true})}
})

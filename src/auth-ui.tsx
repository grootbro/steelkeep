import {useEffect,useId,useState,type FormEvent,type ReactNode} from 'react'
import {Eye,EyeOff,LoaderCircle,LockKeyhole,Monitor,ShieldCheck} from 'lucide-react'
import {useQuery} from '@tanstack/react-query'
import {api,ApiError,queryClient} from './state'
import {Brand,BrandMark} from './brand'

export type OwnerUser={id:string;name:string;email:string}
export type AuthStatus={setupRequired:boolean;authenticated:boolean;user:OwnerUser|null;bootstrapAuthorized:boolean}
export const authQuery={queryKey:['auth-status'],queryFn:()=>api<AuthStatus>('/auth/status'),retry:false as const}

function destination(){
  const current=new URL(window.location.href),next=current.searchParams.get('next')
  const candidate=next??current.pathname
  if(!candidate.startsWith('/')||candidate.startsWith('//')||candidate.includes('\\'))return '/'
  const url=new URL(candidate,window.location.origin)
  if(url.origin!==window.location.origin||!['/','/overview','/connections','/plans','/backups','/jobs','/settings'].includes(url.pathname))return '/'
  return url.pathname+url.search+url.hash
}
function enterWorkspace(){queryClient.clear();window.location.assign(destination())}
export function returnToSignIn(passwordChanged=false){queryClient.clear();window.location.assign(passwordChanged?'/?signedOut=password-changed':window.location.pathname)}

function PasswordField({label,name,autoComplete,minLength,help,disabled=false}:{label:string;name:string;autoComplete:'current-password'|'new-password';minLength?:number;help?:string;disabled?:boolean}){
  const [visible,setVisible]=useState(false),id=useId(),hint=useId()
  return <label className="password-label" htmlFor={id}>{label}<span className="password-control"><input id={id} name={name} type={visible?'text':'password'} autoComplete={autoComplete} required minLength={minLength} maxLength={128} disabled={disabled} aria-describedby={help?hint:undefined}/><button type="button" className="password-visibility" onClick={()=>setVisible(value=>!value)} aria-label={`${visible?'Hide':'Show'} ${label.toLowerCase()}`} aria-pressed={visible} disabled={disabled}>{visible?<EyeOff size={18}/>:<Eye size={18}/>}</button></span>{help&&<small id={hint}>{help}</small>}</label>
}
function useAppearance(){
  const [preference,setPreference]=useState('system'),[systemDark,setSystemDark]=useState(false)
  useEffect(()=>{const media=window.matchMedia('(prefers-color-scheme:dark)'),update=()=>setSystemDark(media.matches);update();media.addEventListener('change',update);try{const value=localStorage.getItem('steelkeep-auth-theme');if(value==='light'||value==='dark'||value==='system')setPreference(value)}catch{}return()=>media.removeEventListener('change',update)},[])
  function change(value:string){setPreference(value);try{localStorage.setItem('steelkeep-auth-theme',value)}catch{}}
  return {theme:preference==='system'?(systemDark?'dark':'light'):preference,preference,change}
}
function AuthShell({children}:{children:ReactNode}){
  const appearance=useAppearance()
  return <main className="auth-screen" data-theme={appearance.theme}><div className="auth-appearance"><Monitor size={15}/><select aria-label="Color theme" value={appearance.preference} onChange={event=>appearance.change(event.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div><div className="auth-stage">{children}<p className="auth-footnote"><LockKeyhole size={13}/>Your installation. Your data.</p></div></main>
}
export function AuthLoading(){return <AuthShell><section className="auth-card auth-loading" aria-busy="true"><Brand size={38}/><p><LoaderCircle size={17} className="spin"/>Connecting to your installation…</p></section></AuthShell>}
export function AuthUnavailable({message,onRetry}:{message:string;onRetry:()=>void}){return <AuthShell><section className="auth-card"><Brand size={38}/><h1>Could not connect</h1><p className="auth-description">Your installation is unavailable. Try again in a moment.</p><p className="auth-error" role="alert">{message}</p><button className="auth-submit" onClick={onRetry}>Try again</button></section></AuthShell>}
export function AuthScreen({status}:{status:AuthStatus}){
  const setup=status.setupRequired,[busy,setBusy]=useState(false),[error,setError]=useState(''),[complete,setComplete]=useState(false)
  const [passwordChanged,setPasswordChanged]=useState(false)
  useEffect(()=>{setPasswordChanged(new URLSearchParams(window.location.search).get('signedOut')==='password-changed')},[])
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    const form=event.currentTarget,fields=new FormData(form),password=String(fields.get('password')??'')
    if(setup&&password!==fields.get('confirmPassword')){setError('The passwords do not match.');form.querySelector<HTMLInputElement>('[name="confirmPassword"]')?.focus();return}
    setBusy(true);setError('')
    try{
      const body=setup?{name:String(fields.get('name')).trim(),email:String(fields.get('email')).trim(),password}:{email:String(fields.get('email')).trim(),password}
      if(setup&&!status.bootstrapAuthorized){
        const key=String(fields.get('installationKey')??'').trim()
        const response=await fetch('/api/v1/auth/setup',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body)})
        if(!response.ok){const result:unknown=await response.json().catch(()=>null);const detail=result&&typeof result==='object'&&'error'in result?result.error:undefined;const code=detail&&typeof detail==='object'&&'code'in detail?String(detail.code):undefined;const message=detail&&typeof detail==='object'&&'message'in detail?String(detail.message):'Could not create your account. Try again.';throw new ApiError(message,response.status,code)}
      }else await api(setup?'/auth/setup':'/auth/login',body)
      form.reset();enterWorkspace()
    }catch(err){
      if(err instanceof ApiError&&err.code==='SETUP_COMPLETE'){setComplete(true);setError('This installation already has an owner. Sign in with your email and password.')}
      else setError(err instanceof ApiError&&err.status===429?'Too many attempts. Please wait a moment before trying again.':err instanceof ApiError&&err.code==='INVALID_CREDENTIALS'?'Email or password is incorrect.':err instanceof Error?err.message:'Could not reach your installation. Try again.')
    }finally{setBusy(false)}
  }
  return <AuthShell><section className="auth-card"><div className="auth-mark"><BrandMark size={56}/></div><Brand mark={false}/><h1>{setup?'Create your owner account':'Welcome back'}</h1><p className="auth-description">{setup?'Set up the account you’ll use to manage backups and recovery.':'Sign in to your backup workspace.'}</p>{passwordChanged&&!setup&&<p role="status" className="auth-success">Password updated. Sign in with your new password.</p>}<form onSubmit={submit} aria-busy={busy}>
    {setup&&<label>Your name<input name="name" autoComplete="name" autoFocus required maxLength={80} disabled={busy||complete}/></label>}
    <label>Email<input type="email" name="email" autoComplete="username" autoFocus={!setup} required maxLength={254} inputMode="email" autoCapitalize="none" spellCheck={false} disabled={busy||complete}/></label>
    <PasswordField label="Password" name="password" autoComplete={setup?'new-password':'current-password'} minLength={setup?12:undefined} help={setup?'Use at least 12 characters.':undefined} disabled={busy||complete}/>
    {setup&&<PasswordField label="Confirm password" name="confirmPassword" autoComplete="new-password" minLength={12} disabled={busy||complete}/>}
    {setup&&!status.bootstrapAuthorized&&<div className="auth-bootstrap"><label>Installation setup key<input type="password" name="installationKey" autoComplete="off" required maxLength={256} disabled={busy||complete}/></label><p>This key is needed once to claim your installation. Find it in <code>.steelkeep/token</code> on the server. Your email and password are used for future sign-ins.</p></div>}
    {error&&<p className="auth-error" role="alert">{error}</p>}
    {complete?<button type="button" className="auth-submit" onClick={()=>{queryClient.clear();window.location.reload()}}>Go to sign in</button>:<button type="submit" className="auth-submit" disabled={busy}>{busy&&<LoaderCircle size={17} className="spin"/>}{busy?(setup?'Creating account…':'Signing in…'):setup?'Create account':'Sign in'}</button>}
  </form>{setup&&status.bootstrapAuthorized&&<p className="auth-authorized"><ShieldCheck size={14}/>Installation ownership verified</p>}</section></AuthShell>
}
export function useAuthStatus(){return useQuery(authQuery)}
export function AccountSettings({user}:{user:OwnerUser}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  async function changePassword(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    const form=event.currentTarget,fields=new FormData(form),password=String(fields.get('newPassword'))
    if(password!==fields.get('confirmPassword')){setError('The new passwords do not match.');return}
    setBusy(true);setError('')
    try{await api('/auth/password',{currentPassword:String(fields.get('currentPassword')),newPassword:password});form.reset();returnToSignIn(true)}catch(err){setError(err instanceof Error?err.message:'Could not update the password.')}finally{setBusy(false)}
  }
  return <section className="panel account-panel"><div className="panel-heading"><div><h2>Your account</h2><p>Owner access to this installation</p></div><ShieldCheck size={20}/></div><div className="account-content"><div className="account-identity"><span className="account-avatar" aria-hidden="true">{user.name.slice(0,1).toUpperCase()}</span><div><strong>{user.name}</strong><span>{user.email}</span></div></div><div className="account-security"><div><h3>Password & sessions</h3><p>Changing your password signs out every browser session. API and agent tokens are managed separately.</p></div><button className="secondary" aria-expanded={open} onClick={()=>{setOpen(value=>!value);setError('')}} disabled={busy}>{open?'Cancel':'Change password'}</button></div>{open&&<form className="account-password-form" onSubmit={changePassword} aria-busy={busy}><PasswordField label="Current password" name="currentPassword" autoComplete="current-password" disabled={busy}/><PasswordField label="New password" name="newPassword" autoComplete="new-password" minLength={12} help="At least 12 characters." disabled={busy}/><PasswordField label="Confirm new password" name="confirmPassword" autoComplete="new-password" minLength={12} disabled={busy}/>{error&&<p role="alert" className="form-error">{error}</p>}<button className="primary" disabled={busy}>{busy&&<LoaderCircle size={15} className="spin"/>}{busy?'Updating…':'Update password & sign out'}</button></form>}</div></section>
}

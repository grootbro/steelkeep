import {useEffect,useId,useState,type FormEvent,type ReactNode} from 'react'
import {Eye,EyeOff,LoaderCircle,LockKeyhole,ShieldCheck} from 'lucide-react'
import {useQuery} from '@tanstack/react-query'
import {api,ApiError,queryClient} from './state'
import {Brand} from './brand'
import {useAppearance,ThemeButton} from './appearance'
import {authDestination} from './auth-destination'

export type OwnerUser={id:string;name:string;email:string}
export type AuthStatus={setupRequired:boolean;authenticated:boolean;user:OwnerUser|null;bootstrapAuthorized:boolean}
export const authQuery={queryKey:['auth-status'],queryFn:()=>api<AuthStatus>('/auth/status'),retry:false as const}

function enterWorkspace(){queryClient.clear();window.location.assign(authDestination(window.location.href))}
export function returnToSignIn(passwordChanged=false){queryClient.clear();window.location.assign(passwordChanged?'/?signedOut=password-changed':window.location.pathname)}

function PasswordField({label,name,autoComplete,minLength,help,disabled=false}:{label:string;name:string;autoComplete:'current-password'|'new-password';minLength?:number;help?:string;disabled?:boolean}){
  const [visible,setVisible]=useState(false),id=useId(),hint=useId()
  return <label className="password-label" htmlFor={id}>{label}<span className="password-control"><input id={id} name={name} type={visible?'text':'password'} autoComplete={autoComplete} required minLength={minLength} maxLength={128} disabled={disabled} aria-describedby={help?hint:undefined}/><button type="button" className="password-visibility" onClick={()=>setVisible(value=>!value)} aria-label={`${visible?'Hide':'Show'} ${label.toLowerCase()}`} aria-pressed={visible} disabled={disabled}>{visible?<EyeOff size={18}/>:<Eye size={18}/>}</button></span>{help&&<small id={hint}>{help}</small>}</label>
}
function AuthShell({children}:{children:ReactNode}){
  const appearance=useAppearance()
  return <main className="auth-screen" data-theme={appearance.theme}><ThemeButton appearance={appearance} className="auth-theme-toggle"/><div className="auth-stage">{children}<p className="auth-footnote"><LockKeyhole size={13}/>Your installation. Your data.</p></div></main>
}
export function AuthLoading(){return <AuthShell><section className="auth-card auth-loading" aria-busy="true"><Brand size={38}/><p><LoaderCircle size={17} className="spin"/>Connecting to your installation…</p></section></AuthShell>}
export function AuthUnavailable({message,onRetry}:{message:string;onRetry:()=>void}){return <AuthShell><section className="auth-card"><Brand size={38}/><h1>Could not connect</h1><p className="auth-description">Your installation is unavailable. Try again in a moment.</p><p className="auth-error" role="alert">{message}</p><button className="auth-submit" onClick={onRetry}>Try again</button></section></AuthShell>}
export function AuthScreen({status}:{status:AuthStatus}){
  const [current,setCurrent]=useState(status)
  const [mode,setMode]=useState<'claim'|'setup'|'signin'>(status.setupRequired?(status.bootstrapAuthorized?'setup':'claim'):'signin')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[passwordChanged,setPasswordChanged]=useState(false)
  const [openingSetup,setOpeningSetup]=useState(false)
  const setup=mode==='setup',claim=mode==='claim'
  useEffect(()=>{setPasswordChanged(new URLSearchParams(window.location.search).get('signedOut')==='password-changed')},[])
  useEffect(()=>{
    if(!window.location.hash.startsWith('#setup='))return
    const code=window.location.hash.slice(7)
    window.history.replaceState(null,'',window.location.pathname+window.location.search)
    setOpeningSetup(true);setBusy(true);setError('')
    void(async()=>{
      try{
        await api('/auth/setup-link/claim',{code})
        const verified=await api<AuthStatus>('/auth/status');setCurrent(verified)
        if(verified.setupRequired&&verified.bootstrapAuthorized)setMode('setup')
        else{setMode('signin');setError('This installation already has an owner. Sign in with your email and password.')}
      }catch{
        setError('This setup link is invalid, expired or already used. Run “bun run setup:owner” on your server for a new link.')
        try{const latest=await api<AuthStatus>('/auth/status');setCurrent(latest);setMode(latest.setupRequired?'claim':'signin');if(!latest.setupRequired)setError('This installation already has an owner. Sign in with your email and password.')}catch{}
      }finally{setOpeningSetup(false);setBusy(false)}
    })()
  },[])
  function switchMode(next:'claim'|'setup'|'signin'){setError('');setMode(next)}
  async function claimInstallation(form:HTMLFormElement){
    const key=String(new FormData(form).get('installationKey')??'').trim()
    try{
      const response=await fetch('/api/v1/session',{method:'POST',headers:{Authorization:'Bearer '+key}})
      if(!response.ok){
        if(response.status===401||response.status===403)throw new Error('This setup key is invalid. Check the key and try again.')
        throw new Error(response.status===429?'Too many attempts. Please wait a moment before trying again.':'Could not verify the setup key. Try again.')
      }
      const verified=await api<AuthStatus>('/auth/status')
      if(!verified.bootstrapAuthorized){
        await api('/auth/logout',{})
        throw new Error('This key cannot authorize installation setup. Use the installation setup key.')
      }
      setCurrent(verified)
      if(verified.setupRequired)setMode('setup')
      else{setMode('signin');setError('This installation already has an owner. Sign in with your email and password.')}
    }finally{form.reset()}
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    const form=event.currentTarget
    if(claim){setBusy(true);setError('');try{await claimInstallation(form)}catch(err){setError(err instanceof Error?err.message:'Could not verify your installation. Try again.')}finally{setBusy(false)};return}
    const fields=new FormData(form),password=String(fields.get('password')??'')
    if(setup&&password!==fields.get('confirmPassword')){setError('The passwords do not match.');form.querySelector<HTMLInputElement>('[name="confirmPassword"]')?.focus();return}
    setBusy(true);setError('')
    try{
      const body=setup?{name:String(fields.get('name')).trim(),email:String(fields.get('email')).trim(),password}:{email:String(fields.get('email')).trim(),password}
      await api(setup?'/auth/setup':'/auth/login',body)
      form.reset();enterWorkspace()
    }catch(err){
      if(err instanceof ApiError&&err.code==='SETUP_COMPLETE'){
        try{setCurrent(await api<AuthStatus>('/auth/status'))}catch{setCurrent(previous=>({...previous,setupRequired:false}))}
        setMode('signin');setError('This installation already has an owner. Sign in with your email and password.')
      }else setError(err instanceof ApiError&&err.status===429?'Too many attempts. Please wait a moment before trying again.':err instanceof ApiError&&err.code==='INVALID_CREDENTIALS'?'Email or password is incorrect.':err instanceof Error?err.message:'Could not reach your installation. Try again.')
    }finally{setBusy(false)}
  }
  if(openingSetup)return <AuthLoading/>
  return <AuthShell><section className="auth-card"><Brand size={40}/><h1>{claim?'Set up your installation':setup?'Create your owner account':'Welcome back'}</h1><p className="auth-description">{claim?'Open the setup link from your server to get started.':setup?'Your account for backups and recovery.':'Sign in to your backup workspace.'}</p>{passwordChanged&&mode==='signin'&&<p role="status" className="auth-success">Password updated. Sign in with your new password.</p>}{claim&&<p className="auth-setup-command">On your server: <code>bun run setup:owner</code></p>}<form key={mode} onSubmit={submit} aria-busy={busy}>
    {claim?<><label>Setup key<input type="password" name="installationKey" autoComplete="off" autoFocus required maxLength={256} disabled={busy}/></label><details className="auth-key-help"><summary>Where to find the key?</summary><p>Find <code>.steelkeep/token</code> on your installation’s server. This key is only needed for the first setup.</p></details></>:<>
      {setup&&<label>Your name<input name="name" autoComplete="name" autoFocus required maxLength={80} disabled={busy}/></label>}
      <label>Email<input type="email" name="email" autoComplete="username" autoFocus={!setup} required maxLength={254} inputMode="email" autoCapitalize="none" spellCheck={false} disabled={busy}/></label>
      <PasswordField label="Password" name="password" autoComplete={setup?'new-password':'current-password'} minLength={setup?12:undefined} help={setup?'Use at least 12 characters.':undefined} disabled={busy}/>
      {setup&&<PasswordField label="Confirm password" name="confirmPassword" autoComplete="new-password" minLength={12} disabled={busy}/>}
    </>}
    {error&&<p className="auth-error" role="alert">{error}</p>}
    <button type="submit" className="auth-submit" disabled={busy}>{busy&&<LoaderCircle size={17} className="spin"/>}{busy?(claim?'Verifying…':setup?'Creating account…':'Signing in…'):claim?'Continue':setup?'Create account':'Sign in'}</button>
  </form>{mode==='signin'?current.setupRequired&&<p className="auth-switch"><button type="button" disabled={busy} onClick={()=>switchMode(current.bootstrapAuthorized?'setup':'claim')}>Set up installation</button></p>:<p className="auth-switch">Already have an account? <button type="button" disabled={busy} onClick={()=>switchMode('signin')}>Sign in</button></p>}</section></AuthShell>
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

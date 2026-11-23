import {useSyncExternalStore} from 'react'
import {Moon,Sun} from 'lucide-react'

export type Theme='light'|'dark'
export const defaultTheme:Theme='dark'
const themeEvent='steelkeep:appearance-change'
export function readTheme(storage:Pick<Storage,'getItem'>):Theme{
  try{for(const key of ['steelkeep-theme','steelkeep-auth-theme']){const saved=storage.getItem(key);if(saved==='light'||saved==='dark')return saved}}catch{}
  return defaultTheme
}
// Runs before stylesheet requests and body parsing; keep storage access isolated for locked-down browsers.
export const appearanceBootstrapScript="(()=>{let theme='dark';try{for(const key of ['steelkeep-theme','steelkeep-auth-theme']){const saved=localStorage.getItem(key);if(saved==='light'||saved==='dark'){theme=saved;break}}}catch{}document.documentElement.setAttribute('data-theme',theme)})()"
export const appearanceCriticalStyle='html{background:#181c23;color-scheme:dark}html[data-theme=light]{background:#f8fafc;color-scheme:light}body{margin:0;background:inherit}.appearance-to-dark{display:none}html[data-theme=light] .appearance-to-dark{display:block}html[data-theme=light] .appearance-to-light{display:none}'
function currentTheme():Theme{
  if(typeof document==='undefined')return defaultTheme
  const theme=document.documentElement.getAttribute('data-theme')
  if(theme==='light'||theme==='dark')return theme
  try{return readTheme(window.localStorage)}catch{return defaultTheme}
}
function applyTheme(theme:Theme){document.documentElement.setAttribute('data-theme',theme)}
function subscribeTheme(changed:()=>void){
  const sync=()=>{try{applyTheme(readTheme(window.localStorage))}catch{applyTheme(defaultTheme)}changed()}
  const storage=(event:StorageEvent)=>{if(event.key===null||event.key==='steelkeep-theme'||event.key==='steelkeep-auth-theme')sync()}
  window.addEventListener('storage',storage);window.addEventListener(themeEvent,changed)
  applyTheme(currentTheme());changed()
  return ()=>{window.removeEventListener('storage',storage);window.removeEventListener(themeEvent,changed)}
}
function toggleTheme(){
  const next=currentTheme()==='dark'?'light':'dark'
  applyTheme(next);try{window.localStorage.setItem('steelkeep-theme',next)}catch{}
  window.dispatchEvent(new Event(themeEvent))
}
export function useAppearance(){
  const theme=useSyncExternalStore(subscribeTheme,currentTheme,()=>defaultTheme)
  return {theme,toggle:toggleTheme}
}
export function ThemeButton({appearance,className}:{appearance:ReturnType<typeof useAppearance>;className:string}){
  return <button type="button" className={className} aria-label={`Switch to ${appearance.theme==='light'?'dark':'light'} theme`} onClick={appearance.toggle}><Moon size={18} className="appearance-to-dark" aria-hidden="true"/><Sun size={18} className="appearance-to-light" aria-hidden="true"/></button>
}

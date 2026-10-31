import {useEffect,useState} from 'react'
import {Moon,Sun} from 'lucide-react'

export type Theme='light'|'dark'
export function readTheme(storage:Pick<Storage,'getItem'>):Theme{
  try{const saved=storage.getItem('steelkeep-theme')??storage.getItem('steelkeep-auth-theme');if(saved==='light'||saved==='dark')return saved}catch{}
  return 'light'
}
export function useAppearance(){
  const [theme,setTheme]=useState<Theme>('light')
  useEffect(()=>{try{setTheme(readTheme(window.localStorage))}catch{}},[])
  function toggle(){setTheme(previous=>{const next=previous==='light'?'dark':'light';try{window.localStorage.setItem('steelkeep-theme',next)}catch{}return next})}
  return {theme,toggle}
}
export function ThemeButton({appearance,className}:{appearance:ReturnType<typeof useAppearance>;className:string}){
  return <button type="button" className={className} aria-label={`Switch to ${appearance.theme==='light'?'dark':'light'} theme`} onClick={appearance.toggle}>{appearance.theme==='light'?<Moon size={18}/>:<Sun size={18}/>}</button>
}

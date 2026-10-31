import {createRootRoute,HeadContent,Outlet,Scripts} from '@tanstack/react-router'
import type {ErrorComponentProps} from '@tanstack/react-router'
import type {ReactNode} from 'react'
import {QueryClientProvider} from '@tanstack/react-query'
import {DbProvider} from '@tanstack/react-db'
import {queryClient,dbClient} from '../state'
import {Brand} from '../brand'
import '../style.css'
export const Route=createRootRoute({
  head:()=>({meta:[{charSet:'utf-8'},{name:'viewport',content:'width=device-width, initial-scale=1'},{title:'steelkeep — Backup & recovery'}],links:[{rel:'icon',type:'image/svg+xml',href:'/brandassets/mark.svg'}]}),
  shellComponent:Document,
  component:()=> <QueryClientProvider client={queryClient}><DbProvider client={dbClient}><Outlet/></DbProvider></QueryClientProvider>,
  errorComponent:WorkspaceError
})
function Document({children}:{children:ReactNode}){return <html lang="en"><head><HeadContent/></head><body>{children}<Scripts/></body></html>}
function WorkspaceError({reset}:ErrorComponentProps){return <main className="login-screen"><section className="login" role="alert"><div className="brand"><Brand size={34}/></div><h1>Could not display the workspace</h1><p>Existing operations may still be running. Reconnect and check their status before starting another backup or restore.</p><button className="primary" onClick={reset}>Try again</button></section></main>}

import {createRootRoute,HeadContent,Outlet,Scripts} from '@tanstack/react-router'
import type {ErrorComponentProps} from '@tanstack/react-router'
import type {ReactNode} from 'react'
import {QueryClientProvider} from '@tanstack/react-query'
import {DbProvider} from '@tanstack/react-db'
import {queryClient,dbClient} from '../state'
import {AuthUnavailable} from '../auth-ui'
import {appearanceBootstrapScript,appearanceCriticalStyle} from '../appearance'
import '../style.css'
export const Route=createRootRoute({
  head:()=>({meta:[{charSet:'utf-8'},{name:'viewport',content:'width=device-width, initial-scale=1'},{title:'steelkeep — Backup & recovery'}],links:[{rel:'icon',type:'image/png',href:'/brandassets/mark.png'}]}),
  shellComponent:Document,
  component:()=> <QueryClientProvider client={queryClient}><DbProvider client={dbClient}><Outlet/></DbProvider></QueryClientProvider>,
  errorComponent:WorkspaceError
})
function Document({children}:{children:ReactNode}){return <html lang="en" data-theme="dark" suppressHydrationWarning><head><style dangerouslySetInnerHTML={{__html:appearanceCriticalStyle}}/><script dangerouslySetInnerHTML={{__html:appearanceBootstrapScript}}/><HeadContent/></head><body>{children}<Scripts/></body></html>}
function WorkspaceError({reset}:ErrorComponentProps){return <AuthUnavailable title="Could not display the workspace" description="Existing operations may still be running." message="Reconnect and check their status before starting another backup or restore." onRetry={reset}/>}

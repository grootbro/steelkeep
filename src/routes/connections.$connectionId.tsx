import {createFileRoute} from '@tanstack/react-router'
import {Workspace} from '../workspace'

export const Route=createFileRoute('/connections/$connectionId')({
  component:()=>{const {connectionId}=Route.useParams();return <Workspace section="connections" connectionId={connectionId}/>}
})

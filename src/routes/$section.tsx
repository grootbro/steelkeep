import {createFileRoute} from '@tanstack/react-router'
import {Workspace} from '../workspace'
export const Route=createFileRoute('/$section')({component:()=>{const {section}=Route.useParams();return <Workspace section={section}/>}})

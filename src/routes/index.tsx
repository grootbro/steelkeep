import {createFileRoute} from '@tanstack/react-router'
import {Workspace} from '../workspace'
export const Route=createFileRoute('/')({component:()=> <Workspace section="overview"/>})

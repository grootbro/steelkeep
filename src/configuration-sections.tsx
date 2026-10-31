import {useId,type KeyboardEvent,type ReactNode} from 'react'
import './workspace-sections.css'

type ConfigurationSection={id:string;label:string;content:ReactNode}

/** Mounted panels preserve form drafts when moving between configuration sections. */
export function ConfigurationSections({sections,selected,onSelect}:{sections:ConfigurationSection[];selected:string;onSelect:(id:string)=>void}){
  const id=useId(),current=sections.find(section=>section.id===selected)??sections[0]
  function navigate(event:KeyboardEvent<HTMLDivElement>){
    if(!current||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault()
    const index=sections.indexOf(current),next=event.key==='Home'?0:event.key==='End'?sections.length-1:(index+(event.key==='ArrowRight'?1:-1)+sections.length)%sections.length,target=sections[next]
    onSelect(target.id);document.getElementById(`${id}-${target.id}-tab`)?.focus()
  }
  return <section className="configuration-sections"><div className="configuration-tabs" role="tablist" aria-label="Configuration sections" onKeyDown={navigate}>{sections.map(section=><button type="button" role="tab" key={section.id} id={`${id}-${section.id}-tab`} aria-controls={`${id}-${section.id}-panel`} aria-selected={current?.id===section.id} tabIndex={current?.id===section.id?0:-1} onClick={()=>onSelect(section.id)}>{section.label}</button>)}</div>{sections.map(section=><div role="tabpanel" tabIndex={0} id={`${id}-${section.id}-panel`} aria-labelledby={`${id}-${section.id}-tab`} hidden={section.id!==current?.id} key={section.id}><div className="settings-stack">{section.content}</div></div>)}</section>
}

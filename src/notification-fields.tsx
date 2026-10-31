import {useId} from 'react'
export type NotificationField={name:string;label:string;secret?:boolean;required?:boolean;type?:'email'|'url'|'text'|'number';min?:number;max?:number;placeholder?:string;hint?:string;maxLength?:number}

/** Password inputs are never initialized from stored credentials or redacted placeholders. */
export function NotificationFields({fields,values,configuredSecrets,onChange,editing,disabled=false}:{fields:readonly NotificationField[];values:Readonly<Record<string,string>>;configuredSecrets:readonly string[];onChange:(name:string,value:string)=>void;editing:boolean;disabled?:boolean}){
  const id=useId()
  return <div className="notification-config-fields">{fields.map(field=><label key={field.name} htmlFor={`${id}-${field.name}`}><span>{field.label}{field.secret&&editing&&configuredSecrets.includes(field.name)&&<small>Saved securely</small>}</span><input id={`${id}-${field.name}`} name={field.name} type={field.secret?'password':field.type??'text'} value={values[field.name]??''} required={field.required&&!(editing&&field.secret&&configuredSecrets.includes(field.name))} disabled={disabled} autoComplete={field.secret?'new-password':'off'} spellCheck={false} min={field.min} max={field.max} step={field.type==='number'?1:undefined} maxLength={field.maxLength??2048} placeholder={field.secret&&editing&&configuredSecrets.includes(field.name)?'Leave blank to keep the saved value':field.placeholder} onChange={event=>onChange(field.name,event.target.value)}/>{field.hint&&<small className="form-hint">{field.hint}</small>}</label>)}</div>
}

import {useId} from 'react'

export function BrandMark({size=32}:{size?:number}){
  const gradient=useId()
  return <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true"><defs><linearGradient id={gradient} x1="7" y1="4" x2="42" y2="45" gradientUnits="userSpaceOnUse"><stop stopColor="#818CF8"/><stop offset=".52" stopColor="#6366F1"/><stop offset="1" stopColor="#4338CA"/></linearGradient></defs><path d="M7 13v23c0 5 7.6 9 17 9s17-4 17-9V13" fill={`url(#${gradient})`}/><ellipse cx="24" cy="13" rx="17" ry="9" fill="#6366F1" stroke="#A5B4FC" strokeWidth="1.5"/><path d="M7 24c0 5 7.6 9 17 9s17-4 17-9M7 35c0 5 7.6 9 17 9s17-4 17-9" stroke="#C7D2FE" strokeWidth="1.5"/><ellipse cx="24" cy="13" rx="11" ry="5" stroke="#C7D2FE" strokeOpacity=".45"/><path d="m16 11 8 6 9-8M13 15l20-2M24 5v16" stroke="#E0E7FF" strokeOpacity=".32"/><circle cx="13" cy="25" r="1.5" fill="#E0F2FE"/><circle cx="18" cy="27" r="1.5" fill="#E0F2FE"/><circle cx="13" cy="36" r="1.5" fill="#E0F2FE"/><circle cx="18" cy="38" r="1.5" fill="#E0F2FE"/></svg>
}
export function Brand({size=32,mark=true}:{size?:number;mark?:boolean}){
  return <span className="brand-lockup" role="img" aria-label="steelkeep">{mark&&<BrandMark size={size}/>}<span className="brand-wordmark" aria-hidden="true"><span>steel</span><span>keep</span></span></span>
}

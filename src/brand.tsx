export function BrandMark({size=32}:{size?:number}){
  // Frame the supplied artwork's transparent padding without redrawing its pixels.
  return <svg width={size} height={size} viewBox="180 150 900 980" aria-hidden="true"><image href="/brandassets/mark.png" width="1254" height="1254"/></svg>
}
export function Brand({size=32,mark=true}:{size?:number;mark?:boolean}){
  const width=mark?size*4.65:'5em',height=mark?size*1.35:'1.2em'
  return <span className="brand-lockup" role="img" aria-label="steelkeep"><span className={mark?'brand-artwork':'brand-wordmark'} aria-hidden="true"><svg className="brand-original brand-original-light" width={width} height={height} viewBox={mark?'80 80 2020 585':'635 239 1460 335'}><image href="/brandassets/lockup-light.png" width="2172" height="724"/></svg><svg className="brand-original brand-original-dark" width={width} height={height} viewBox={mark?'150 240 1420 410':'545 345 1015 235'}><image href="/brandassets/lockup-dark.png" width="1672" height="941"/></svg></span></span>
}

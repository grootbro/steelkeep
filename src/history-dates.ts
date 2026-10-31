/** Local calendar days include DST transitions; PostgreSQL's end boundary retains all six fractional digits. */
export function historyDateBoundary(value:string,edge:'from'|'until'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('Choose a valid history date.')
  const date=new Date(value+'T00:00:00')
  const [year,month,day]=value.split('-').map(Number)
  if(year<1||year>9999||date.getFullYear()!==year||date.getMonth()+1!==month||date.getDate()!==day)throw new Error('Choose a valid history date.')
  if(edge==='from')return date.toISOString()
  date.setDate(date.getDate()+1)
  return new Date(date.getTime()-1000).toISOString().replace(/\.\d{3}Z$/,'.999999Z')
}

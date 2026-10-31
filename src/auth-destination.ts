export function authDestination(currentUrl:string){
  const current=new URL(currentUrl),candidate=current.searchParams.get('next')??current.pathname
  if(!candidate.startsWith('/')||candidate.startsWith('//')||candidate.includes('\\'))return '/'
  const url=new URL(candidate,current.origin)
  const section=['/','/overview','/connections','/plans','/backups','/jobs','/settings'].includes(url.pathname)
  const connection=/^\/connections\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.pathname)
  return url.origin===current.origin&&(section||connection)?url.pathname+url.search+url.hash:'/'
}

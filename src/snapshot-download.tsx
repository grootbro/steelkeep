import {Download} from 'lucide-react'
import type {Artifact} from './state'

/** Native authenticated transfer: the archive never enters browser JavaScript memory. */
export function SnapshotDownload({artifact,scopes,available}:{artifact:Pick<Artifact,'id'|'deletion_state'>;scopes:readonly string[];available:boolean}){
  if(!available||!scopes.includes('backup:download')||artifact.deletion_state!=='active')return null
  return <a className="secondary small snapshot-download-action" href={`/api/v1/backups/${encodeURIComponent(artifact.id)}/download`} target="_blank" rel="noopener noreferrer" aria-label={`Download archive for snapshot ${artifact.id}`} title="Download archive containing database contents. Discard failed or incomplete transfers."><Download size={14}/><span>Download</span></a>
}

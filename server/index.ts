import pino from 'pino'
import { connectDb } from './db'
import { Services } from './services'
import { createApp } from './app'

const log=pino({name:'steelkeep-api'})
const {db}=connectDb()
const app=createApp(new Services(db)).listen({hostname:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??4311)})
log.info({port:app.server?.port},'Steelkeep API ready')
let closing=false
async function shutdown(){if(closing)return;closing=true;await app.stop();await db.destroy()}
process.on('SIGTERM',()=>void shutdown())
process.on('SIGINT',()=>void shutdown())

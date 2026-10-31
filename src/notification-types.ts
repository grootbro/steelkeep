export type NotificationKind='email'|'slack'|'discord'|'discord_webhook'|'teams'|'telegram'|'pushover'|'gotify'|'webhook'
export type NotificationChannel={id:string;name:string;kind:NotificationKind;enabled:boolean;revision:number;events:{success:boolean;failure:boolean};config:Record<string,unknown>;secretFields:string[];destination:string|null;createdAt:string;updatedAt:string}
export type NotificationDelivery={id:string;channelId:string;channelName:string;kind:NotificationKind;runId:string|null;event:'success'|'failure'|'test';status:'queued'|'sending'|'retry_wait'|'succeeded'|'failed'|'uncertain'|'cancelled';attempt:number;maxAttempts:number;nextAttemptAt:string|null;errorCode:string|null;errorMessage:string|null;createdAt:string;finishedAt:string|null}

export type NotificationDeliveryDetail={delivery:NotificationDelivery;attempts:{attempt:number;status:string;startedAt:string;finishedAt:string|null;errorCode:string|null;errorMessage:string|null}[]}

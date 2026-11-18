import {readFile} from 'node:fs/promises';
import {callModel,resolveProvider,type ProviderSpec,type PromptInput} from './providers.js';
export interface FallbackConfig {primary:ProviderSpec;fallbackProfileIds?:string[];maxAttemptsPerModel?:number}
export interface AttemptResult {output:string;profileUsed:string;attempts:number}
export function canFallback(e:unknown):boolean {
 const msg=e instanceof Error?e.message:String(e);
 return /HTTP (408|409|425|429|500|502|503|504)\b|fetch failed|timeout|timed out|ETIMEDOUT|ECONNRESET|Provider returned no text/i.test(msg);
}
export async function profileCandidates(config:FallbackConfig):Promise<ProviderSpec[]> {
 const fallback=config.fallbackProfileIds||[];
 if(!Array.isArray(fallback)||fallback.length>8||fallback.some(x=>!/^[-\w]{1,48}$/.test(x)))throw new Error('Invalid fallback profile list');
 return [config.primary,...fallback.filter(id=>id!==config.primary.profileId).map(profileId=>({profileId}))];
}
export async function callWithFallback(req:PromptInput,config:FallbackConfig,call=callModel):Promise<AttemptResult>{
 let count=0,last:unknown;
 for(const spec of await profileCandidates(config)) {
  const model=await resolveProvider(spec);const tries=Math.max(1,Math.min(3,config.maxAttemptsPerModel||1));
  for(let i=0;i<tries;i++){
   count++;
   try{return {output:await call(model,req),profileUsed:spec.profileId||model.model,attempts:count}}
   catch(e){last=e;if(!canFallback(e))throw e;if(i+1<tries)await new Promise(r=>setTimeout(r,Math.min(2500,500*(i+1))))}
  }
 }
 throw new Error(`All ${count} model attempts failed: ${last instanceof Error?last.message:String(last)}`);
}

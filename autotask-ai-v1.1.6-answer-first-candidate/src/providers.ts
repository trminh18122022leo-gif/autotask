/** BYOK provider adapter: OpenAI-compatible, native Gemini and native Anthropic. */
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
export type ProviderKind = 'openai-compatible'|'gemini'|'anthropic';
export interface ProviderSpec {kind?: ProviderKind; model?: string; endpoint?:string; profileId?:string; allowVision?:boolean}
export interface ProfileRecord {kind:ProviderKind; model:string; endpoint:string; provider:string}
export interface ResolvedProvider extends ProfileRecord {apiKey:string; profileId?: string}
export function safeEndpoint(raw:string):URL {
 const u=new URL(raw);
 if(u.protocol!=='https:' || u.username || u.password || !u.hostname)throw new Error('Only credential-free HTTPS endpoints are allowed');
 if(u.port && u.port !== '443')throw new Error('Only standard HTTPS port 443 is allowed');
 return u;
}
export async function resolveProvider(spec:ProviderSpec):Promise<ResolvedProvider> {
 let p:ProfileRecord;
 let apiKey:string;
 if(spec.profileId || (!spec.model && !process.env.AUTOTASK_AI_API_KEY)) {
  const db=JSON.parse(await readFile(resolve('.private','model-profiles.json'),'utf8')) as {default?:string;profiles:Record<string,ProfileRecord>};
  const id=spec.profileId || db.default;
  if(!id || !db.profiles[id])throw new Error('Model profile not found. Run npm run models.');
  p=db.profiles[id];
  apiKey=execFileSync(process.env.AUTOTASK_PYTHON||'python',['desktop/secrets.py',id],{cwd:process.cwd(),encoding:'utf8',timeout:8000,windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 } else {
  if(!spec.model)throw new Error('Specify provider.model or provider.profileId');
  p={kind:(spec.kind==='gemini'||spec.kind==='anthropic')?spec.kind:'openai-compatible',model:spec.model,
    endpoint:spec.endpoint||(spec.kind==='gemini'?'https://generativelanguage.googleapis.com/v1beta':spec.kind==='anthropic'?'https://api.anthropic.com/v1/messages':'https://api.openai.com/v1/chat/completions'),provider:'env'};
  apiKey=process.env.AUTOTASK_AI_API_KEY||'';
 }
 if(!apiKey)throw new Error('No API key found; configure a model profile or set AUTOTASK_AI_API_KEY');
 safeEndpoint(p.endpoint);
 if(!p.model || p.model.length>100)throw new Error('Invalid model');
 return {...p,apiKey,profileId: spec.profileId};
}
export interface PromptInput {system:string; text:string; imageBase64?:string; maxTokens?:number}
export async function callModel(provider:ResolvedProvider,req:PromptInput):Promise<string> {
 const {kind,endpoint,model,apiKey}=provider;
 let url=endpoint,headers:Record<string,string>={'Content-Type':'application/json'},body:any;
 if(kind==='gemini') {
  url=`${endpoint.replace(/\/$/,'')}/models/${encodeURIComponent(model)}:generateContent`;
  headers['x-goog-api-key']=apiKey;
  const parts:any[]=[{text:`SYSTEM:\n${req.system}\n\nUSER:\n${req.text}`}];
  if(req.imageBase64)parts.push({inline_data:{mime_type:'image/png',data:req.imageBase64}});
  body={contents:[{role:'user',parts}],generationConfig:{maxOutputTokens:req.maxTokens||1800}};
 } else if(kind==='anthropic') {
  headers['x-api-key']=apiKey;headers['anthropic-version']='2023-06-01';
  const content:any[]=[{type:'text',text:req.text}];
  if(req.imageBase64)content.push({type:'image',source:{type:'base64',media_type:'image/png',data:req.imageBase64}});
  body={model,max_tokens:req.maxTokens||1800,system:req.system,messages:[{role:'user',content}]};
 } else {
  headers.Authorization=`Bearer ${apiKey}`;
  const content:any[]=[{type:'text',text:req.text}];
  if(req.imageBase64)content.push({type:'image_url',image_url:{url:`data:image/png;base64,${req.imageBase64}`}});
  body={model,messages:[{role:'system',content:req.system},{role:'user',content}]};
 }
 const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(90000)});
 if(!response.ok)throw new Error(`AI API request failed: HTTP ${response.status}`);
 const obj:any=await response.json();
 const result=kind==='gemini'?obj.candidates?.[0]?.content?.parts?.filter((p:any)=>p.text).map((p:any)=>p.text).join(''):
  kind==='anthropic'?obj.content?.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(''):
  typeof obj.choices?.[0]?.message?.content==='string'?obj.choices[0].message.content:
  obj.choices?.[0]?.message?.content?.filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('');
 if(!result || typeof result!=='string')throw new Error('Provider returned no text');
 return result;
}

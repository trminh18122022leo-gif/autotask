/** BYOK provider adapter: OpenAI-compatible, native Gemini and native Anthropic. */
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {redactSecrets} from './security/redact.js';
export type ProviderKind = 'openai-compatible'|'gemini'|'anthropic';
export interface ProviderSpec {kind?: ProviderKind; model?: string; endpoint?:string; profileId?:string; keySlot?:string; allowVision?:boolean}
export interface ProfileRecord {kind:ProviderKind; model:string; endpoint:string; provider:string}
export interface ResolvedProvider extends ProfileRecord {apiKey:string; profileId?: string; keySlot?: string}
export function safeEndpoint(raw:string):URL {
 const u=new URL(raw);
 if(u.protocol!=='https:' || u.username || u.password || !u.hostname)throw new Error('Only credential-free HTTPS endpoints are allowed');
 if(u.port && u.port !== '443')throw new Error('Only standard HTTPS port 443 is allowed');
 return u;
}
export async function resolveProvider(spec:ProviderSpec):Promise<ResolvedProvider> {
 let p:ProfileRecord;
 let apiKey:string;
 let resolvedProfileId:string|undefined=spec.profileId;
 let resolvedKeySlot:string|undefined;
 if(spec.profileId || (!spec.model && !process.env.AUTOTASK_AI_API_KEY)) {
  const db=JSON.parse(await readFile(resolve('.private','model-profiles.json'),'utf8')) as {default?:string;profiles:Record<string,ProfileRecord>};
  const id=spec.profileId || db.default;
  if(!id || !db.profiles[id])throw new Error('Model profile not found. Run npm run models.');
  p=db.profiles[id];
  resolvedProfileId=id;
  const keyringId=(spec.keySlot && /^[a-zA-Z0-9_-]{1,64}$/.test(spec.keySlot)) ? spec.keySlot : id;
  resolvedKeySlot=keyringId;
  apiKey=execFileSync(process.env.AUTOTASK_PYTHON||'python',['desktop/secrets.py',keyringId],{cwd:process.cwd(),encoding:'utf8',timeout:8000,windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 } else {
  if(!spec.model)throw new Error('Specify provider.model or provider.profileId');
  p={kind:(spec.kind==='gemini'||spec.kind==='anthropic')?spec.kind:'openai-compatible',model:spec.model,
    endpoint:spec.endpoint||(spec.kind==='gemini'?'https://generativelanguage.googleapis.com/v1beta':spec.kind==='anthropic'?'https://api.anthropic.com/v1/messages':'https://api.openai.com/v1/chat/completions'),provider:'env'};
  apiKey=process.env.AUTOTASK_AI_API_KEY||'';
 }
 if(!apiKey)throw new Error('No API key found; configure a model profile or set AUTOTASK_AI_API_KEY');
 safeEndpoint(p.endpoint);
 if(!p.model || p.model.length>100)throw new Error('Invalid model');
 return {...p,apiKey,profileId: resolvedProfileId, ...(resolvedKeySlot?{keySlot:resolvedKeySlot}:{})};
}
export interface PromptInput {
 system: string;
 text: string;
 imageBase64?: string;
 maxTokens?: number;
 responseMimeType?: 'application/json' | 'text/plain';
 temperature?: number;
 timeoutMs?: number;
}
export type RateLimitScope = 'PER_MINUTE' | 'DAILY' | 'OVERLOAD' | 'NOT_FOUND' | 'AUTH';
export type RateLimitSubScope = 'RPM' | 'TPM' | 'RPD' | 'TPD';
export interface ParsedProviderErrorInfo {
 status: number;
 rateLimitScope?: RateLimitScope;
 rateLimitSubScope?: RateLimitSubScope;
 retryAfterMs?: number;
 retryAfterText?: string;
 quotaId?: string;
 quotaMetric?: string;
 quotaLimitValue?: string;
 reasonSnippet: string;
}

export interface CallUsageMetrics {
 profileId?: string;
 keySlot?: string;
 provider: string;
 model: string;
 promptTokens: number;
 outputTokens: number;
 totalTokens: number;
 latencyMs: number;
 timestamp: number;
 remainingRequests?: number;
 remainingTokens?: number;
 resetRequestsMs?: number;
 resetTokensMs?: number;
}

let usageTelemetryListener: ((metrics: CallUsageMetrics) => void) | null = null;
export function setUsageTelemetryListener(listener: ((metrics: CallUsageMetrics) => void) | null): void {
 usageTelemetryListener = listener;
}

function parseRateLimitDurationMs(raw: string | null): number | undefined {
 if (!raw) return undefined;
 const s = raw.trim();
 if (!s) return undefined;
 const num = Number(s);
 if (Number.isFinite(num) && num >= 0) return Math.round(num * 1000);
 let total = 0;
 let matched = false;
 for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
  matched = true;
  const val = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'h') total += val * 3600000;
  else if (unit === 'm') total += val * 60000;
  else if (unit === 's') total += val * 1000;
  else total += val;
 }
 return matched ? Math.round(total) : undefined;
}

/** Extracts milliseconds from durations like "42.5s", "3h54m40s", or HTTP Retry-After headers */
export function parseRetryDelayMs(rawHeader: string | null, rawBodyText: string, parsedJson?: any): number | undefined {
 if(rawHeader){
  const secs=Number(rawHeader);
  if(Number.isFinite(secs) && secs>0) return Math.round(secs*1000);
 }
 if(parsedJson?.error?.details && Array.isArray(parsedJson.error.details)){
  for(const d of parsedJson.error.details){
   if(typeof d?.retryDelay==='string'){
    const m=d.retryDelay.match(/([\d.]+)s/);
    if(m) return Math.round(Number(m[1])*1000);
   }
  }
 }
 const hms=rawBodyText.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
 if(hms){
  const totalSec=(Number(hms[1]||0)*3600)+(Number(hms[2]||0)*60)+Number(hms[3]||0);
  if(Number.isFinite(totalSec) && totalSec>0) return Math.round(totalSec*1000);
 }
 return undefined;
}

/** Unified HTTP error parser for Gemini/OpenAI/Anthropic responses (extracts retry delay, quota violations, and scope). */
export function parseProviderHttpError(
 status: number,
 rawText: string,
 retryAfterHeader: string | null = null,
 extraSecrets: string[] = []
): ParsedProviderErrorInfo {
 let parsedErr: any;
 try { parsedErr = JSON.parse(rawText); } catch {}
 const retryAfterMs = parseRetryDelayMs(retryAfterHeader, rawText, parsedErr);
 const details: any[] = Array.isArray(parsedErr?.error?.details) ? parsedErr.error.details : [];
 let quotaId: string | undefined;
 let quotaMetric: string | undefined;
 let quotaLimitValue: string | undefined;
 let retryAfterText: string | undefined;

 for (const d of details) {
  if (Array.isArray(d?.violations) && d.violations.length > 0) {
   const v = d.violations[0];
   quotaId = v.quotaId || quotaId;
   quotaMetric = v.quotaMetric || quotaMetric;
   if (v.quotaValue !== undefined) quotaLimitValue = String(v.quotaValue);
  }
  if (typeof d?.retryDelay === 'string') {
   retryAfterText = d.retryDelay;
  }
 }

 const rawMessage = String(parsedErr?.error?.message || rawText || '').replace(/\s+/g, ' ').trim();
 const reasonSnippet = redactSecrets(rawMessage, extraSecrets).slice(0, 180);
 if (!retryAfterText) {
  const retryMatch = reasonSnippet.match(/retry in\s+([^\s.,]+)/i);
  if (retryMatch) retryAfterText = retryMatch[1];
 }

 const quotaStr = `${JSON.stringify(details)} ${quotaId || ''} ${quotaMetric || ''} ${rawMessage}`;
 let rateLimitScope: RateLimitScope | undefined;
 let rateLimitSubScope: RateLimitSubScope | undefined;
 if (status === 401 || status === 403) rateLimitScope = 'AUTH';
 else if (status === 404) rateLimitScope = 'NOT_FOUND';
 else if (status === 500 || status === 502 || status === 503 || status === 504) rateLimitScope = 'OVERLOAD';
 else if (status === 429) {
  const isDaily = /PerDay|per\s*day|\bRPD\b|\bTPD\b|requestsperday/i.test(quotaStr) || (retryAfterMs !== undefined && retryAfterMs > 300000);
  const isToken = /TokensPerMinute|TokensPerDay|InputTokens|OutputTokens|\bTPM\b|\bTPD\b|tokens?\s*per\s*(?:minute|day)/i.test(quotaStr);
  rateLimitScope = isDaily ? 'DAILY' : 'PER_MINUTE';
  rateLimitSubScope = isDaily ? (isToken ? 'TPD' : 'RPD') : (isToken ? 'TPM' : 'RPM');
 }

 return {
  status,
  rateLimitScope,
  rateLimitSubScope,
  retryAfterMs,
  retryAfterText,
  quotaId,
  quotaMetric,
  quotaLimitValue,
  reasonSnippet
 };
}

export async function callModel(provider:ResolvedProvider,req:PromptInput):Promise<string> {
 const {kind,endpoint,model,apiKey}=provider;
 const startMs = Date.now();
 let url=endpoint,headers:Record<string,string>={'Content-Type':'application/json'},body:any;
 if(kind==='gemini') {
  url=`${endpoint.replace(/\/$/,'')}/models/${encodeURIComponent(model)}:generateContent`;
  headers['x-goog-api-key']=apiKey;
  const isGemmaModel = model.toLowerCase().startsWith('gemma-');
  const userText = isGemmaModel && req.system ? `SYSTEM:\n${req.system}\n\nUSER:\n${req.text}` : req.text;
  const parts:any[]=[{text:userText}];
  if(req.imageBase64)parts.push({inline_data:{mime_type:'image/png',data:req.imageBase64}});
  const generationConfig: Record<string, any> = {maxOutputTokens:req.maxTokens||1800};
  if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
   generationConfig.temperature = req.temperature;
  }
  if (req.responseMimeType === 'application/json' && !isGemmaModel) {
   generationConfig.responseMimeType = 'application/json';
  }
  body={contents:[{role:'user',parts}],generationConfig};
  if (!isGemmaModel && req.system) {
   body.systemInstruction = {parts:[{text:req.system}]};
  }
 } else if(kind==='anthropic') {
  headers['x-api-key']=apiKey;headers['anthropic-version']='2023-06-01';
  const content:any[]=[{type:'text',text:req.text}];
  if(req.imageBase64)content.push({type:'image',source:{type:'base64',media_type:'image/png',data:req.imageBase64}});
  body={model,max_tokens:req.maxTokens||1800,system:req.system,messages:[{role:'user',content}]};
  if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
   body.temperature = req.temperature;
  }
 } else {
  headers.Authorization=`Bearer ${apiKey}`;
  const content:any[]=[{type:'text',text:req.text}];
  if(req.imageBase64)content.push({type:'image_url',image_url:{url:`data:image/png;base64,${req.imageBase64}`}});
  body={model,messages:[{role:'system',content:req.system},{role:'user',content}]};
  if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
   body.temperature = req.temperature;
  }
 }
 const reqTimeoutMs = (typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs) && req.timeoutMs >= 5000) ? req.timeoutMs : 50000;
 const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(reqTimeoutMs)});
 if(!response.ok){
  const rawText=await response.text().catch(()=>'');
  const parsed=parseProviderHttpError(response.status,rawText,response.headers?.get?.('retry-after')??null,apiKey?[apiKey]:[]);
  const scopeTag=parsed.rateLimitScope?` [${parsed.rateLimitScope}${parsed.rateLimitSubScope ? `:${parsed.rateLimitSubScope}` : ''}]`:'';
  const err=new Error(`AI API request failed: HTTP ${response.status}${scopeTag}${parsed.reasonSnippet?`: ${parsed.reasonSnippet}`:''}`) as Error&{
   status?:number;httpStatus?:number;retryAfterMs?:number;rateLimitScope?:string;rateLimitSubScope?:string;quotaLimitValue?:string;
  };
  err.status=response.status;
  err.httpStatus=response.status;
  if(parsed.retryAfterMs!==undefined)err.retryAfterMs=parsed.retryAfterMs;
  if(parsed.rateLimitScope)err.rateLimitScope=parsed.rateLimitScope;
  if(parsed.rateLimitSubScope)err.rateLimitSubScope=parsed.rateLimitSubScope;
  if(parsed.quotaLimitValue)err.quotaLimitValue=parsed.quotaLimitValue;
  throw err;
 }
 const obj:any=await response.json();
 const latencyMs = Math.max(1, Date.now() - startMs);
 const geminiParts=obj.candidates?.[0]?.content?.parts||[];
 const geminiNonThought=geminiParts.filter((p:any)=>p.text && !p.thought).map((p:any)=>p.text).join('');
 const geminiFallback=geminiParts.filter((p:any)=>p.text).map((p:any)=>p.text).join('');
 const result=kind==='gemini'?(geminiNonThought||geminiFallback):
  kind==='anthropic'?obj.content?.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(''):
  typeof obj.choices?.[0]?.message?.content==='string'?obj.choices[0].message.content:
  obj.choices?.[0]?.message?.content?.filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('');
 if(!result || typeof result!=='string')throw new Error('Provider returned no text');

 if (usageTelemetryListener) {
  const estPrompt = Math.ceil(((req.system?.length || 0) + (req.text?.length || 0)) / 4) + (req.imageBase64 ? 258 : 0);
  const estOutput = Math.ceil(result.length / 4);
  let promptTokens = estPrompt;
  let outputTokens = estOutput;
  let totalTokens = estPrompt + estOutput;
  if (kind === 'gemini' && obj.usageMetadata) {
   promptTokens = Number(obj.usageMetadata.promptTokenCount ?? estPrompt) || estPrompt;
   const cand = Number(obj.usageMetadata.candidatesTokenCount ?? estOutput) || 0;
   const thoughts = Number(obj.usageMetadata.thoughtsTokenCount ?? 0) || 0;
   outputTokens = (cand + thoughts) || estOutput;
   totalTokens = Number(obj.usageMetadata.totalTokenCount ?? (promptTokens + outputTokens)) || (promptTokens + outputTokens);
  } else if (kind === 'anthropic' && obj.usage) {
   promptTokens = Number(obj.usage.input_tokens ?? estPrompt) || estPrompt;
   outputTokens = Number(obj.usage.output_tokens ?? estOutput) || estOutput;
   totalTokens = promptTokens + outputTokens;
  } else if (obj.usage) {
   promptTokens = Number(obj.usage.prompt_tokens ?? estPrompt) || estPrompt;
   outputTokens = Number(obj.usage.completion_tokens ?? estOutput) || estOutput;
   totalTokens = Number(obj.usage.total_tokens ?? (promptTokens + outputTokens)) || (promptTokens + outputTokens);
  }
  const hdrGet = (k: string) => response.headers?.get?.(k) ?? null;
  const remReqNum = Number(hdrGet('x-ratelimit-remaining-requests'));
  const remTokNum = Number(hdrGet('x-ratelimit-remaining-tokens'));
  try {
   usageTelemetryListener({
    profileId: provider.profileId,
    keySlot: provider.keySlot,
    provider: provider.provider,
    model,
    promptTokens,
    outputTokens,
    totalTokens,
    latencyMs,
    timestamp: Date.now(),
    remainingRequests: Number.isFinite(remReqNum) ? remReqNum : undefined,
    remainingTokens: Number.isFinite(remTokNum) ? remTokNum : undefined,
    resetRequestsMs: parseRateLimitDurationMs(hdrGet('x-ratelimit-reset-requests')),
    resetTokensMs: parseRateLimitDurationMs(hdrGet('x-ratelimit-reset-tokens'))
   });
  } catch {}
 }
 return result;
}

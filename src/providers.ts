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
export function isOpenAiReasoningModel(model: string): boolean {
 return /^(?:o1|o3|o4|gpt-5)(?:[-.]|$)/i.test(model.trim());
}

export interface PromptInput {
 system: string;
 text: string;
 imageBase64?: string;
 audioBase64?: string;
 audioMimeType?: string;
 maxTokens?: number;
 responseMimeType?: 'application/json' | 'text/plain';
 temperature?: number;
 timeoutMs?: number;
 reasoningEffort?: 'low' | 'medium' | 'high';
 thinkingBudget?: number;
}
export type RateLimitScope = 'PER_MINUTE' | 'DAILY' | 'OVERLOAD' | 'NOT_FOUND' | 'AUTH';
export type RateLimitSubScope = 'RPM' | 'TPM' | 'RPD' | 'TPD';
export interface ProviderViolationInfo {
 quotaId?: string;
 quotaMetric?: string;
 quotaValue?: string;
 rateLimitScope?: RateLimitScope;
 rateLimitSubScope?: RateLimitSubScope;
}

export interface RateLimitHeaderInfo {
 limitRequests?: number;
 limitTokens?: number;
 limitRequestsDaily?: number;
 remainingRequests?: number;
 remainingTokens?: number;
 resetRequestsMs?: number;
 resetTokensMs?: number;
}

export interface ParsedProviderErrorInfo {
 status: number;
 rateLimitScope?: RateLimitScope;
 rateLimitSubScope?: RateLimitSubScope;
 retryAfterMs?: number;
 retryAfterText?: string;
 quotaId?: string;
 quotaMetric?: string;
 quotaLimitValue?: string;
 limitRequests?: number;
 limitTokens?: number;
 limitRequestsDaily?: number;
 remainingRequests?: number;
 remainingTokens?: number;
 resetRequestsMs?: number;
 resetTokensMs?: number;
 violations?: ProviderViolationInfo[];
 isZeroQuota?: boolean;
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
 limitRequests?: number;
 limitTokens?: number;
 limitRequestsDaily?: number;
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
 // Handle RFC3339 / ISO timestamps (e.g. Anthropic anthropic-ratelimit-*-reset)
 if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
  const ts = Date.parse(s);
  if (Number.isFinite(ts)) return Math.max(0, ts - Date.now());
 }
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

function parsePositiveHeaderInt(val: string | null): number | undefined {
 if (!val) return undefined;
 const n = Number(val.trim());
 return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Extracts standardized rate-limit limits, remaining counts & reset timers from OpenAI/Groq/Anthropic/Custom HTTP headers. */
export function extractRateLimitHeaders(
 headers?: { get?: (name: string) => string | null } | null
): RateLimitHeaderInfo {
 if (!headers || typeof headers.get !== 'function') return {};
 const get = (k: string) => headers.get?.(k) ?? null;

 const limitRequests =
  parsePositiveHeaderInt(get('x-ratelimit-limit-requests')) ??
  parsePositiveHeaderInt(get('anthropic-ratelimit-requests-limit'));

 const anthropicInTok = parsePositiveHeaderInt(get('anthropic-ratelimit-input-tokens-limit'));
 const anthropicOutTok = parsePositiveHeaderInt(get('anthropic-ratelimit-output-tokens-limit'));
 const anthropicCombinedTok =
  anthropicInTok !== undefined && anthropicOutTok !== undefined
   ? anthropicInTok + anthropicOutTok
   : anthropicInTok ?? anthropicOutTok;

 const limitTokens =
  parsePositiveHeaderInt(get('x-ratelimit-limit-tokens')) ??
  parsePositiveHeaderInt(get('anthropic-ratelimit-tokens-limit')) ??
  anthropicCombinedTok;

 const limitRequestsDaily =
  parsePositiveHeaderInt(get('x-ratelimit-limit-requests-day')) ??
  parsePositiveHeaderInt(get('x-ratelimit-limit-rpd'));

 const remainingRequests =
  parsePositiveHeaderInt(get('x-ratelimit-remaining-requests')) ??
  parsePositiveHeaderInt(get('anthropic-ratelimit-requests-remaining'));

 const remainingTokens =
  parsePositiveHeaderInt(get('x-ratelimit-remaining-tokens')) ??
  parsePositiveHeaderInt(get('anthropic-ratelimit-tokens-remaining')) ??
  parsePositiveHeaderInt(get('anthropic-ratelimit-input-tokens-remaining'));

 const resetRequestsMs =
  parseRateLimitDurationMs(get('x-ratelimit-reset-requests')) ??
  parseRateLimitDurationMs(get('anthropic-ratelimit-requests-reset'));

 const resetTokensMs =
  parseRateLimitDurationMs(get('x-ratelimit-reset-tokens')) ??
  parseRateLimitDurationMs(get('anthropic-ratelimit-tokens-reset')) ??
  parseRateLimitDurationMs(get('anthropic-ratelimit-input-tokens-reset'));

 return {
  ...(limitRequests !== undefined ? { limitRequests } : {}),
  ...(limitTokens !== undefined ? { limitTokens } : {}),
  ...(limitRequestsDaily !== undefined ? { limitRequestsDaily } : {}),
  ...(remainingRequests !== undefined ? { remainingRequests } : {}),
  ...(remainingTokens !== undefined ? { remainingTokens } : {}),
  ...(resetRequestsMs !== undefined ? { resetRequestsMs } : {}),
  ...(resetTokensMs !== undefined ? { resetTokensMs } : {})
 };
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

function classifyViolation(
 quotaId?: string,
 quotaMetric?: string,
 rawText = '',
 retryAfterMs?: number,
 quotaValue?: string
): { scope?: RateLimitScope; subScope?: RateLimitSubScope } {
 const q = `${quotaId || ''} ${quotaMetric || ''} ${rawText}`;
 const isZeroQuota = quotaValue === '0' || /\blimit:\s*0\b/i.test(rawText) || /"quotaValue"\s*:\s*"?0"?/i.test(rawText);
 const isDaily = isZeroQuota || /PerDay|per\s*day|\bRPD\b|\bTPD\b|requestsperday/i.test(q) || (retryAfterMs !== undefined && retryAfterMs > 300000);
 const isToken = /TokensPerMinute|TokensPerDay|InputTokens|OutputTokens|\bTPM\b|\bTPD\b|tokens?\s*per\s*(?:minute|day)/i.test(q);
 return {
  scope: isDaily ? 'DAILY' : 'PER_MINUTE',
  subScope: isDaily ? (isToken ? 'TPD' : 'RPD') : (isToken ? 'TPM' : 'RPM')
 };
}

/** Unified HTTP error parser for Gemini/OpenAI/Anthropic responses (extracts retry delay, quota violations, rate-limit headers, and scope). */
export function parseProviderHttpError(
 status: number,
 rawText: string,
 retryAfterHeader: string | null = null,
 extraSecrets: string[] = [],
 responseHeaders?: { get?: (name: string) => string | null } | null
): ParsedProviderErrorInfo {
 let parsedErr: any;
 try { parsedErr = JSON.parse(rawText); } catch {}
 const effectiveRetryHdr = retryAfterHeader ?? responseHeaders?.get?.('retry-after') ?? null;
 const retryAfterMs = parseRetryDelayMs(effectiveRetryHdr, rawText, parsedErr);
 const details: any[] = Array.isArray(parsedErr?.error?.details) ? parsedErr.error.details : [];
 let quotaId: string | undefined;
 let quotaMetric: string | undefined;
 let quotaLimitValue: string | undefined;
 let retryAfterText: string | undefined;
 const violations: ProviderViolationInfo[] = [];

 for (const d of details) {
  if (Array.isArray(d?.violations)) {
   for (const v of d.violations) {
    const vId = typeof v?.quotaId === 'string' ? v.quotaId : undefined;
    const vMet = typeof v?.quotaMetric === 'string' ? v.quotaMetric : undefined;
    const vVal = v?.quotaValue !== undefined ? String(v.quotaValue) : undefined;
    const cls = classifyViolation(vId, vMet, '', retryAfterMs, vVal);
    violations.push({
     ...(vId ? { quotaId: vId } : {}),
     ...(vMet ? { quotaMetric: vMet } : {}),
     ...(vVal !== undefined ? { quotaValue: vVal } : {}),
     ...(status === 429 ? { rateLimitScope: cls.scope, rateLimitSubScope: cls.subScope } : {})
    });
    if (!quotaId && vId) quotaId = vId;
    if (!quotaMetric && vMet) quotaMetric = vMet;
    if (quotaLimitValue === undefined && vVal !== undefined) quotaLimitValue = vVal;
   }
  }
  if (typeof d?.retryDelay === 'string') {
   retryAfterText = d.retryDelay;
  }
 }

 const rawMessage = String(parsedErr?.error?.message || rawText || '').replace(/\s+/g, ' ').trim();
 const baseSnippet = redactSecrets(rawMessage, extraSecrets);
 const hdrInfo = extractRateLimitHeaders(responseHeaders);
 const quotaStr = `${JSON.stringify(details)} ${quotaId || ''} ${quotaMetric || ''} ${rawMessage}`;
 const isZeroQuota = status === 429 && (
  quotaLimitValue === '0' ||
  violations.some(v => v.quotaValue === '0') ||
  /\blimit:\s*0\b/i.test(rawMessage)
 );
 if (isZeroQuota && quotaLimitValue === undefined) {
  quotaLimitValue = '0';
 }
 const reasonSnippet = (
  isZeroQuota && !/\blimit:\s*0\b/i.test(baseSnippet.slice(0, 180))
   ? `[limit: 0] ${baseSnippet}`
   : baseSnippet
 ).slice(0, 180);
 if (!retryAfterText) {
  const retryMatch = baseSnippet.match(/retry in\s+([^\s.,]+)/i);
  if (retryMatch) retryAfterText = retryMatch[1];
 }
 let rateLimitScope: RateLimitScope | undefined;
 let rateLimitSubScope: RateLimitSubScope | undefined;
 if (status === 401 || status === 403) rateLimitScope = 'AUTH';
 else if (status === 404) rateLimitScope = 'NOT_FOUND';
 else if (status === 500 || status === 502 || status === 503 || status === 504) rateLimitScope = 'OVERLOAD';
 else if (status === 429) {
  const cls = classifyViolation(quotaId, quotaMetric, quotaStr, retryAfterMs, isZeroQuota ? '0' : quotaLimitValue);
  rateLimitScope = cls.scope;
  rateLimitSubScope = cls.subScope;
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
  ...(hdrInfo.limitRequests !== undefined ? { limitRequests: hdrInfo.limitRequests } : {}),
  ...(hdrInfo.limitTokens !== undefined ? { limitTokens: hdrInfo.limitTokens } : {}),
  ...(hdrInfo.limitRequestsDaily !== undefined ? { limitRequestsDaily: hdrInfo.limitRequestsDaily } : {}),
  ...(hdrInfo.remainingRequests !== undefined ? { remainingRequests: hdrInfo.remainingRequests } : {}),
  ...(hdrInfo.remainingTokens !== undefined ? { remainingTokens: hdrInfo.remainingTokens } : {}),
  ...(hdrInfo.resetRequestsMs !== undefined ? { resetRequestsMs: hdrInfo.resetRequestsMs } : {}),
  ...(hdrInfo.resetTokensMs !== undefined ? { resetTokensMs: hdrInfo.resetTokensMs } : {}),
  ...(violations.length > 0 ? { violations } : {}),
  ...(isZeroQuota ? { isZeroQuota: true } : {}),
  reasonSnippet
 };
}

export async function callModel(provider:ResolvedProvider,req:PromptInput):Promise<string> {
 const {kind,endpoint,model,apiKey}=provider;
 const startMs = Date.now();
 let url=endpoint,headers:Record<string,string>={'Content-Type':'application/json'},body:any;
 let usedThinkingConfig = false;
 if(kind==='gemini') {
  url=`${endpoint.replace(/\/$/,'')}/models/${encodeURIComponent(model)}:generateContent`;
  headers['x-goog-api-key']=apiKey;
  const isGemmaModel = model.toLowerCase().startsWith('gemma-');
  const lowerModel = model.toLowerCase();
  if (req.audioBase64 && isGemmaModel) {
   throw new Error(`Audio multimodal is not supported on Gemma text model "${model}"`);
  }
  const userText = isGemmaModel && req.system ? `SYSTEM:\n${req.system}\n\nUSER:\n${req.text}` : req.text;
  const parts:any[]=[{text:userText}];
  if(req.imageBase64)parts.push({inline_data:{mime_type:'image/png',data:req.imageBase64}});
  if(req.audioBase64)parts.push({inline_data:{mime_type:req.audioMimeType||'audio/mp3',data:req.audioBase64}});
  const generationConfig: Record<string, any> = {maxOutputTokens:req.maxTokens||1800};
  if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
   generationConfig.temperature = req.temperature;
  }
  if (req.responseMimeType === 'application/json' && !isGemmaModel) {
   generationConfig.responseMimeType = 'application/json';
  }
  if (!isGemmaModel && (/^gemini-(?:3|4)/.test(lowerModel) && !lowerModel.includes('flash-lite') || typeof req.thinkingBudget === 'number' || req.reasoningEffort === 'high' || req.reasoningEffort === 'medium' || req.reasoningEffort === 'low')) {
   if (/^gemini-2\.5-/.test(lowerModel) && (typeof req.thinkingBudget === 'number' || (!lowerModel.includes('flash-lite') && (req.reasoningEffort === 'high' || req.reasoningEffort === 'medium')))) {
    generationConfig.thinkingConfig = {
     thinkingBudget: typeof req.thinkingBudget === 'number' ? req.thinkingBudget : 4096
    };
    generationConfig.maxOutputTokens = Math.max(generationConfig.maxOutputTokens, 16384);
    usedThinkingConfig = true;
   } else if (/^gemini-(?:3|4)/.test(lowerModel) && !lowerModel.includes('flash-lite')) {
    const isFlashModel = lowerModel.includes('flash');
    const eff = req.reasoningEffort;
    if (isFlashModel) {
     // Gemini 3/4 Flash burns thinking tokens under default/HIGH; bound cleanly so JSON/short replies never come back empty
     const wantLevel = eff === 'high' ? 'MEDIUM' : 'LOW';
     generationConfig.thinkingConfig = { thinkingLevel: wantLevel };
     const minOut = eff === 'high' ? 16384 : (eff === 'medium' ? 8192 : (req.maxTokens ? Math.max(req.maxTokens, 512) : 2048));
     generationConfig.maxOutputTokens = Math.max(generationConfig.maxOutputTokens, minOut);
     usedThinkingConfig = true;
    } else if (typeof req.thinkingBudget === 'number' || eff === 'high' || eff === 'medium' || eff === 'low') {
     generationConfig.thinkingConfig = {
      thinkingLevel: eff === 'high' ? 'HIGH' : (eff === 'low' ? 'LOW' : 'MEDIUM')
     };
     generationConfig.maxOutputTokens = Math.max(generationConfig.maxOutputTokens, eff === 'high' ? 32768 : 16384);
     usedThinkingConfig = true;
    }
   }
  }
  body={contents:[{role:'user',parts}],generationConfig};
  if (!isGemmaModel && req.system) {
   body.systemInstruction = {parts:[{text:req.system}]};
  }
 } else if(kind==='anthropic') {
  if (req.audioBase64) {
   throw new Error(`Direct inline audio input is not supported on Anthropic adapter ("${model}")`);
  }
  headers['x-api-key']=apiKey;headers['anthropic-version']='2023-06-01';
  const content:any[]=[{type:'text',text:req.text}];
  if(req.imageBase64)content.push({type:'image',source:{type:'base64',media_type:'image/png',data:req.imageBase64}});
  const useAnthropicThinking = req.reasoningEffort === 'high' && /^claude-(?:3-7|sonnet-4|opus-4|4)/i.test(model);
  const maxTokens = useAnthropicThinking ? Math.max(req.maxTokens || 1800, 16384) : (req.maxTokens || 1800);
  body={model,max_tokens:maxTokens,system:req.system,messages:[{role:'user',content}]};
  if (useAnthropicThinking) {
   const budget = typeof req.thinkingBudget === 'number'
    ? Math.max(1024, Math.min(req.thinkingBudget, Math.floor(maxTokens * 0.6)))
    : 6144;
   body.thinking = { type: 'enabled', budget_tokens: budget };
   usedThinkingConfig = true;
  } else if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
   body.temperature = req.temperature;
  }
 } else {
  if (req.audioBase64) {
   throw new Error(`Direct inline audio input is only supported on native Gemini models (attempted "${model}")`);
  }
  headers.Authorization=`Bearer ${apiKey}`;
  const content:any[]=[{type:'text',text:req.text}];
  if(req.imageBase64)content.push({type:'image_url',image_url:{url:`data:image/png;base64,${req.imageBase64}`}});
  body={model,messages:[{role:'system',content:req.system},{role:'user',content}]};
  if (isOpenAiReasoningModel(model)) {
   body.max_completion_tokens = Math.max(req.maxTokens || 4096, req.reasoningEffort === 'high' ? 16384 : 4096);
   if (req.reasoningEffort) {
    body.reasoning_effort = req.reasoningEffort;
    usedThinkingConfig = true;
   }
  } else if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
   body.temperature = req.temperature;
  }
 }
 const reqTimeoutMs = (typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs) && req.timeoutMs >= 5000) ? req.timeoutMs : 50000;
 let response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(reqTimeoutMs)});
 let cachedErrorBody: string | undefined;
 if(!response.ok && response.status === 400 && usedThinkingConfig){
  const firstErrText=await response.text().catch(()=>'');
  cachedErrorBody = firstErrText;
  if(/thinkingConfig|thinkingLevel|thinkingBudget|reasoning_effort|budget_tokens|thinking|max_completion_tokens|unsupported/i.test(firstErrText)){
   if(kind==='gemini' && body.generationConfig){
    delete body.generationConfig.thinkingConfig;
   } else if(kind==='anthropic'){
    delete body.thinking;
    if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
     body.temperature = req.temperature;
    }
   } else {
    delete body.reasoning_effort;
    if (/max_completion_tokens/i.test(firstErrText)) {
     delete body.max_completion_tokens;
    }
   }
   cachedErrorBody = undefined;
   response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(reqTimeoutMs)});
  }
 }
 if(!response.ok){
  const rawText=cachedErrorBody !== undefined ? cachedErrorBody : await response.text().catch(()=>'');
  const parsed=parseProviderHttpError(response.status,rawText,response.headers?.get?.('retry-after')??null,apiKey?[apiKey]:[],response.headers);
  const scopeTag=parsed.rateLimitScope?` [${parsed.rateLimitScope}${parsed.rateLimitSubScope ? `:${parsed.rateLimitSubScope}` : ''}]`:'';
  const err=new Error(`AI API request failed: HTTP ${response.status}${scopeTag}${parsed.reasonSnippet?`: ${parsed.reasonSnippet}`:''}`) as Error&{
   status?:number;httpStatus?:number;retryAfterMs?:number;rateLimitScope?:string;rateLimitSubScope?:string;quotaLimitValue?:string;isZeroQuota?:boolean;learnedLimits?:{rpm?:number;tpm?:number;rpd?:number};
  };
  err.status=response.status;
  err.httpStatus=response.status;
  if(parsed.retryAfterMs!==undefined)err.retryAfterMs=parsed.retryAfterMs;
  if(parsed.rateLimitScope)err.rateLimitScope=parsed.rateLimitScope;
  if(parsed.rateLimitSubScope)err.rateLimitSubScope=parsed.rateLimitSubScope;
  if(parsed.quotaLimitValue!==undefined)err.quotaLimitValue=parsed.quotaLimitValue;
  if(parsed.isZeroQuota)err.isZeroQuota=true;
  const learned: {rpm?:number;tpm?:number;rpd?:number} = {};
  if(parsed.limitRequests!==undefined)learned.rpm=parsed.limitRequests;
  if(parsed.limitTokens!==undefined)learned.tpm=parsed.limitTokens;
  if(parsed.limitRequestsDaily!==undefined)learned.rpd=parsed.limitRequestsDaily;
  for(const v of parsed.violations||[]){
   const qVal=Number(v.quotaValue);
   if(Number.isFinite(qVal)&&qVal>0){
    if(v.rateLimitSubScope==='RPM')learned.rpm=qVal;
    else if(v.rateLimitSubScope==='TPM')learned.tpm=qVal;
    else if(v.rateLimitSubScope==='RPD')learned.rpd=qVal;
   }
  }
  if(Object.keys(learned).length>0)err.learnedLimits=learned;
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
  const estPrompt = Math.ceil(((req.system?.length || 0) + (req.text?.length || 0)) / 4) + (req.imageBase64 ? 258 : 0) + (req.audioBase64 ? Math.max(300, Math.ceil(req.audioBase64.length / 400)) : 0);
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
  const hdrInfo = extractRateLimitHeaders(response.headers);
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
    ...hdrInfo
   });
  } catch {}
 }
 return result;
}

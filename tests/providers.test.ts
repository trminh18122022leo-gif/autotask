import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callModel,parseProviderHttpError,type ResolvedProvider} from '../src/providers.js';

async function mockedCall(p:ResolvedProvider,expectedHeader:string,response:any){
 const previous=globalThis.fetch;
 let captured:any;
 try {
  globalThis.fetch=(async (url:RequestInfo|URL,opts?:RequestInit)=>{
   captured={url:String(url),headers:opts?.headers,body:JSON.parse(String(opts?.body))};
   return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  const result=await callModel(p,{system:'policy',text:'task',imageBase64:'ZGF0YQ=='});
  assert.equal(result,'OK');
  assert.equal((captured.headers as Record<string,string>)[expectedHeader]!==undefined,true);
  assert.equal(captured.body.model||p.model,p.model);
  assert.equal(JSON.stringify(captured.body).includes(p.apiKey),false,'API key must not be in JSON body');
  return captured;
 } finally {globalThis.fetch=previous;}
}
test('OpenAI-compatible adapter sends image without embedding key in payload',async()=>{
 const p:ResolvedProvider={kind:'openai-compatible',provider:'openai',model:'test-model',endpoint:'https://api.example.com/v1/chat/completions',apiKey:'mock-secret'};
 const sent=await mockedCall(p,'Authorization',{choices:[{message:{content:'OK'}}]});
 assert.equal(sent.body.messages[1].content[1].type,'image_url');
});
test('Gemini native adapter uses key header and inline_data',async()=>{
 const p:ResolvedProvider={kind:'gemini',provider:'gemini',model:'test-model',endpoint:'https://generativelanguage.googleapis.com/v1beta',apiKey:'mock-secret'};
 const sent=await mockedCall(p,'x-goog-api-key',{candidates:[{content:{parts:[{text:'OK'}]}}]});
 assert.equal(sent.body.contents[0].parts[1].inline_data.mime_type,'image/png');
});
test('Gemini native adapter uses key header, systemInstruction, JSON mime type for Gemini, and skips them on Gemma',async()=>{
 const previous=globalThis.fetch;
 try {
  let captured:any;
  globalThis.fetch=(async (url:RequestInfo|URL,opts?:RequestInit)=>{
   captured={url:String(url),headers:opts?.headers,body:JSON.parse(String(opts?.body))};
   return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'{"ok":true}'}]}}]}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;

  const gem:ResolvedProvider={kind:'gemini',provider:'gemini',model:'gemini-3-flash-preview',endpoint:'https://generativelanguage.googleapis.com/v1beta',apiKey:'mock-secret'};
  const r1=await callModel(gem,{system:'strict json policy',text:'solve Q1',responseMimeType:'application/json',temperature:0.2});
  assert.equal(r1,'{"ok":true}');
  assert.equal(captured.body.systemInstruction.parts[0].text,'strict json policy');
  assert.equal(captured.body.generationConfig.responseMimeType,'application/json');
  assert.equal(captured.body.generationConfig.temperature,0.2);

  const gemma:ResolvedProvider={kind:'gemini',provider:'gemini',model:'gemma-4-26b-a4b-it',endpoint:'https://generativelanguage.googleapis.com/v1beta',apiKey:'mock-secret'};
  await callModel(gemma,{system:'strict json policy',text:'solve Q1',responseMimeType:'application/json',temperature:0.2});
  assert.equal(captured.body.systemInstruction,undefined);
  assert.equal(captured.body.generationConfig.responseMimeType,undefined);
  assert.match(captured.body.contents[0].parts[0].text,/^SYSTEM:\nstrict json policy/);
 } finally {globalThis.fetch=previous;}
});
test('Anthropic native adapter uses Messages API + image content',async()=>{
 const p:ResolvedProvider={kind:'anthropic',provider:'anthropic',model:'test-model',endpoint:'https://api.anthropic.com/v1/messages',apiKey:'mock-secret'};
 const sent=await mockedCall(p,'x-api-key',{content:[{type:'text',text:'OK'}]});
 assert.equal(sent.body.messages[0].content[1].type,'image');
});

test('Deep reasoning parameters configure o3/gpt-5, Gemini thinkingConfig with HTTP 400 fallback, and Anthropic extended thinking',async()=>{
 const previous=globalThis.fetch;
 try {
  const capturedBodies:any[]=[];
  let geminiCallCount=0;
  globalThis.fetch=(async (_url:RequestInfo|URL,opts?:RequestInit)=>{
   const body=JSON.parse(String(opts?.body));
   capturedBodies.push(body);
   if (body.generationConfig?.thinkingConfig && geminiCallCount===0) {
    geminiCallCount++;
    return new Response(JSON.stringify({error:{message:'Unknown field thinkingConfig in GenerationConfig'}}),{status:400,headers:{'content-type':'application/json'}});
   }
   if (body.model==='o3' || body.model==='gpt-5') {
    return new Response(JSON.stringify({choices:[{message:{content:'O3_OK'}}]}),{status:200,headers:{'content-type':'application/json'}});
   }
   if (String(body.model||'').startsWith('claude-')) {
    return new Response(JSON.stringify({content:[{type:'thinking',thinking:'...'},{type:'text',text:'CLAUDE_OK'}]}),{status:200,headers:{'content-type':'application/json'}});
   }
   return new Response(JSON.stringify({candidates:[{content:{parts:[{thought:true,text:'hmm'},{text:'GEM_OK'}]}}]}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;

  // 1. OpenAI o3 omits temperature, sets reasoning_effort + max_completion_tokens
  const o3:ResolvedProvider={kind:'openai-compatible',provider:'openai',model:'o3',endpoint:'https://api.openai.com/v1/chat/completions',apiKey:'mock-secret'};
  const rO3=await callModel(o3,{system:'s',text:'solve',temperature:0.1,maxTokens:2048,reasoningEffort:'high'});
  assert.equal(rO3,'O3_OK');
  assert.equal(capturedBodies[0].temperature,undefined,'OpenAI reasoning models must omit temperature');
  assert.equal(capturedBodies[0].reasoning_effort,'high');
  assert.equal(capturedBodies[0].max_completion_tokens,16384);

  // 2. Gemini 2.5 Pro sets thinkingConfig.thinkingBudget (capped 4096) & recovers cleanly if endpoint returns HTTP 400
  const gem25:ResolvedProvider={kind:'gemini',provider:'gemini',model:'gemini-2.5-pro',endpoint:'https://generativelanguage.googleapis.com/v1beta',apiKey:'mock-secret'};
  const rGem=await callModel(gem25,{system:'s',text:'solve',maxTokens:8192,reasoningEffort:'high'});
  assert.equal(rGem,'GEM_OK');
  assert.equal(capturedBodies[1].generationConfig.thinkingConfig.thinkingBudget,4096);
  assert.equal(capturedBodies[1].generationConfig.maxOutputTokens,16384);
  assert.equal(capturedBodies[2].generationConfig.thinkingConfig,undefined,'Retry after HTTP 400 must strip thinkingConfig');

  // 3. Gemini 3 Pro sets thinkingLevel: HIGH + maxOutputTokens 32768; Gemini 3 Flash caps thinkingLevel to MEDIUM
  const gem3:ResolvedProvider={kind:'gemini',provider:'gemini',model:'gemini-3-pro-preview',endpoint:'https://generativelanguage.googleapis.com/v1beta',apiKey:'mock-secret'};
  const rGem3=await callModel(gem3,{system:'s',text:'solve',maxTokens:8192,reasoningEffort:'high'});
  assert.equal(rGem3,'GEM_OK');
  assert.equal(capturedBodies[3].generationConfig.thinkingConfig.thinkingLevel,'HIGH');
  assert.equal(capturedBodies[3].generationConfig.maxOutputTokens,32768);

  const gem3Flash:ResolvedProvider={kind:'gemini',provider:'gemini',model:'gemini-3-flash-preview',endpoint:'https://generativelanguage.googleapis.com/v1beta',apiKey:'mock-secret'};
  const rGem3F=await callModel(gem3Flash,{system:'s',text:'solve',maxTokens:16384,reasoningEffort:'high'});
  assert.equal(rGem3F,'GEM_OK');
  assert.equal(capturedBodies[4].generationConfig.thinkingConfig.thinkingLevel,'MEDIUM');
  assert.equal(capturedBodies[4].generationConfig.maxOutputTokens,16384);

  // 4. Anthropic Claude 4 extended thinking enables thinking object & omits temperature
  const claude4:ResolvedProvider={kind:'anthropic',provider:'anthropic',model:'claude-sonnet-4-20250514',endpoint:'https://api.anthropic.com/v1/messages',apiKey:'mock-secret'};
  const rClaude=await callModel(claude4,{system:'s',text:'solve',temperature:0.1,maxTokens:4096,reasoningEffort:'high'});
  assert.equal(rClaude,'CLAUDE_OK');
  assert.equal(capturedBodies[5].temperature,undefined,'Anthropic extended thinking must omit temperature');
  assert.deepEqual(capturedBodies[5].thinking,{type:'enabled',budget_tokens:6144});
  assert.equal(capturedBodies[5].max_tokens,16384);
 } finally {globalThis.fetch=previous;}
});

test('Zero-quota HTTP 429 (limit: 0 / quotaValue "0") classifies as DAILY with isZeroQuota=true', async () => {
 const rawBody = JSON.stringify({
  error: {
   code: 429,
   message: 'Quota exceeded for quota metric Requests, limit: 0, model: gemini-3.1-pro-preview',
   details: [
    {
     violations: [
      {
       quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
       quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
       quotaValue: '0'
      }
     ]
    }
   ]
  }
 });

 const parsed = parseProviderHttpError(429, rawBody);
 assert.equal(parsed.rateLimitScope, 'DAILY');
 assert.equal(parsed.isZeroQuota, true);
 assert.equal(parsed.quotaLimitValue, '0');

 const parsedMsgOnly = parseProviderHttpError(429, JSON.stringify({
  error: { message: 'Resource exhausted: RequestsPerMinute, limit: 0' }
 }));
 assert.equal(parsedMsgOnly.rateLimitScope, 'DAILY');
 assert.equal(parsedMsgOnly.isZeroQuota, true);
 assert.equal(parsedMsgOnly.quotaLimitValue, '0');

 const previous = globalThis.fetch;
 try {
  globalThis.fetch = (async () =>
   new Response(rawBody, { status: 429, headers: { 'content-type': 'application/json' } })
  ) as typeof fetch;
  const gem: ResolvedProvider = {
   kind: 'gemini',
   provider: 'gemini',
   model: 'gemini-3.1-pro-preview',
   endpoint: 'https://generativelanguage.googleapis.com/v1beta',
   apiKey: 'mock-secret'
  };
  await assert.rejects(
   () => callModel(gem, { system: 's', text: 'hi' }),
   (err: any) => err?.rateLimitScope === 'DAILY' && err?.isZeroQuota === true && err?.quotaLimitValue === '0'
  );
 } finally {
  globalThis.fetch = previous;
 }
});

test('Gemini 3.x Flash bounds thinkingLevel to LOW when reasoningEffort is omitted/low and preserves [limit: 0] on long 429 messages', async () => {
 const longPrefix = 'You exceeded your current quota, please check your plan and billing details. '.repeat(3);
 const parsedLong = parseProviderHttpError(429, JSON.stringify({
  error: {
   code: 429,
   message: `${longPrefix} limit: 0`,
   details: [{ violations: [{ quotaValue: '0' }] }]
  }
 }));
 assert.equal(parsedLong.isZeroQuota, true);
 assert.ok(/\blimit:\s*0\b/i.test(parsedLong.reasonSnippet), `Expected [limit: 0] preserved in 180-char snippet, got: ${parsedLong.reasonSnippet}`);

 const previous = globalThis.fetch;
 const bodies: any[] = [];
 try {
  globalThis.fetch = (async (_url: RequestInfo | URL, opts?: RequestInit) => {
   bodies.push(JSON.parse(String(opts?.body)));
   return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
   });
  }) as typeof fetch;

  const flash35: ResolvedProvider = {
   kind: 'gemini',
   provider: 'gemini',
   model: 'gemini-3.5-flash',
   endpoint: 'https://generativelanguage.googleapis.com/v1beta',
   apiKey: 'mock-secret'
  };
  const out = await callModel(flash35, { system: 's', text: '2+2', maxTokens: 16 });
  assert.equal(out, 'OK');
  assert.equal(bodies[0].generationConfig.thinkingConfig?.thinkingLevel, 'LOW');
  assert.ok(bodies[0].generationConfig.maxOutputTokens >= 512);
 } finally {
  globalThis.fetch = previous;
 }
});

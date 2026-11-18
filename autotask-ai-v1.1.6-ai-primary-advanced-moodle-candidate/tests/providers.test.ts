import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callModel,type ResolvedProvider} from '../src/providers.js';

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
test('Anthropic native adapter uses Messages API + image content',async()=>{
 const p:ResolvedProvider={kind:'anthropic',provider:'anthropic',model:'test-model',endpoint:'https://api.anthropic.com/v1/messages',apiKey:'mock-secret'};
 const sent=await mockedCall(p,'x-api-key',{content:[{type:'text',text:'OK'}]});
 assert.equal(sent.body.messages[0].content[1].type,'image');
});

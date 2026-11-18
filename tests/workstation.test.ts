import test from 'node:test';import assert from 'node:assert/strict';
import {kindFor,safeLink,toTask} from '../src/discovery.js';
import {canFallback,profileCandidates} from '../src/provider-fallback.js';
import {COLORS,DEFAULT_THEME,validThemeSettings,windowsTerminalProfile} from '../src/ui/themes.js';
import {safeFormat} from '../src/documents.js';
import {validateConfig} from '../src/config.js';
test('Discover recognizes common activity types',()=>{
 assert.equal(kindFor('Quiz Week 2','https://lms.example.edu/mod/quiz/view.php'),'quiz');
 assert.equal(kindFor('Nộp bài tập','https://lms.example.edu/a'),'assignment');
 assert.equal(kindFor('Mathematics Course','https://lms.example.edu/course/view.php?id=2'),'course');
});
test('Discovery rejects external link and javascript URLs',()=>{
 assert.equal(safeLink('javascript:alert(1)','https://lms.example.edu/course',['lms.example.edu']),null);
 assert.equal(safeLink('https://evil.example/login','https://lms.example.edu/',['lms.example.edu']),null);
 assert.ok(safeLink('/mod/quiz/view.php','https://lms.example.edu/',['lms.example.edu'])?.includes('quiz'));
});
test('Model fallback triggers only transient errors',()=>{
 assert.equal(canFallback(new Error('AI API request failed: HTTP 429')),true);
 assert.equal(canFallback(new Error('AI API request failed: HTTP 401')),false);
 assert.equal(canFallback(new Error('Provider returned no text')),true);
});
test('Model fallback deduplicates primary and validates IDs',async()=>{
 const arr=await profileCandidates({primary:{profileId:'a'},fallbackProfileIds:['a','b','c']});
 assert.deepEqual(arr.map(s=>s.profileId),['a','b','c']);
});
test('Both terminal themes are accessible and have corresponding terminal scheme',()=>{
 for(const theme of ['tokyo-night','cyberpunk'] as const){
  const cfg={...DEFAULT_THEME,theme};assert.ok(validThemeSettings(cfg));assert.ok(COLORS[theme].cyan.startsWith('#'));assert.ok(windowsTerminalProfile(cfg).foreground);
 }
 assert.equal(validThemeSettings({...DEFAULT_THEME,opacity:123}),false);
});
test('Document engine recognizes supported formats',()=>{
 assert.equal(safeFormat('task.DOCX'),'docx');assert.equal(safeFormat('sheet.xlsx'),'xlsx');assert.equal(safeFormat('payload.exe'),'txt');
});
test('Discovery-only config with explicit scope is valid',()=>{
 const c={allowedHosts:['lms.example.edu'],approvedForAIUse:true,parallelTabs:2,authUrls:[],deadlinePages:[],tasks:[],autoDiscover:true,discoveryStartUrls:['https://lms.example.edu/my'],provider:{profileId:'test'}};
 assert.ok(validateConfig(c).autoDiscover);
});

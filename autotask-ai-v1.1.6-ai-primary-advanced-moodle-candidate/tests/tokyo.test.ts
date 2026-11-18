import {test} from 'node:test';
import assert from 'node:assert/strict';
import {palette,paint,colorEnabled} from '../src/ui/tokyo.js';

test('Tokyo Night palette has required RGB colors',()=>{
 assert.equal(palette.purple,'#bb9af7');
 assert.equal(palette.cyan,'#7dcfff');
 assert.equal(palette.midnight,'#1a1b26');
});
test('NO_COLOR disables ANSI without altering text',()=>{
 const old=process.env.NO_COLOR;
 try{process.env.NO_COLOR='1';assert.equal(colorEnabled(),false);assert.equal(paint('Tokyo Night','purple',true),'Tokyo Night');}
 finally{if(old===undefined)delete process.env.NO_COLOR;else process.env.NO_COLOR=old;}
});

import test from 'node:test';import assert from 'node:assert/strict';
import {nextSelection} from '../src/ui/menu.js';
import {deadlineSeverity} from '../src/ui/dashboard.js';
import {hasUnvisitedPages,readyForReview} from '../src/workflow-guards.js';
test('Menu selection cycles with arrow keys and vim keys',()=>{
 assert.equal(nextSelection(0,'up',5),4);assert.equal(nextSelection(4,'down',5),0);
 assert.equal(nextSelection(1,'j',5),2);assert.equal(nextSelection(1,'k',5),0);
});
test('Deadline radar levels are based on hours until due',()=>{
 assert.equal(deadlineSeverity(-1),'overdue');assert.equal(deadlineSeverity(20),'urgent');
 assert.equal(deadlineSeverity(48),'soon');assert.equal(deadlineSeverity(100),'future');assert.equal(deadlineSeverity(null),'unknown');
});
test('Never mark capped multi-page workflow READY while Next still exists',()=>{
 assert.equal(hasUnvisitedPages(7,8,true),true);
 assert.equal(hasUnvisitedPages(7,8,false),false);
 assert.equal(hasUnvisitedPages(2,8,true),false);
 assert.equal(readyForReview({supported:true,complete:false,filled:8,found:8,waiting:false}),false);
 assert.equal(readyForReview({supported:true,complete:true,filled:8,found:8,waiting:false}),true);
 assert.equal(readyForReview({supported:true,complete:true,filled:0,found:0,waiting:false}),false);
});

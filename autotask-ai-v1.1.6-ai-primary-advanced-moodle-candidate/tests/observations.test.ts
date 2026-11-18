import test from 'node:test';import assert from 'node:assert/strict';
import {findScore,parseTopicRow} from '../src/observations.js';
test('Reads existing Moodle grade rather than inferring a score',()=>{
 assert.equal(findScore('Your attempts Attempt 1 Status Finished Grade 9.00 out of 10.00 (90%)'),'Grade 9.00 out of 10.00 (90%)');
 assert.equal(findScore('Grade: 11 out of 10'),null);
 assert.equal(findScore('No score has been published'),null);
});
test('FAMI subject inventory reads the visible table without starting exams',()=>{
 const record=parseTopicRow(['172852','MI2020','CĐ4 - Một số đặc trưng','', '15','10','5','1','','']);
 assert.equal(record?.topic,'CĐ4 - Một số đặc trưng');
 assert.equal(record?.readingMinutes,15);
 assert.equal(record?.examMinutes,10);
 assert.equal(record?.questionCount,5);
});

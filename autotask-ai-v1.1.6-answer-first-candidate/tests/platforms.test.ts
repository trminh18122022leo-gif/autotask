import test from 'node:test';
import assert from 'node:assert/strict';
import {platformForUrl,hintsForPlatform,isAudioOrSpeech,isLoginChallenge} from '../src/platforms.js';
import {kindFor,safeLink} from '../src/discovery.js';
import {parseDeadline} from '../src/calendar.js';
test('platform matching is restricted to exact relevant hosts',()=>{
 assert.equal(platformForUrl('https://docs.google.com/forms/d/e/example/viewform'),'google-forms');
 assert.equal(platformForUrl('https://forms.office.com/Pages/ResponsePage.aspx'),'microsoft-forms');
 assert.equal(platformForUrl('https://englishdiscoveries.net/'),'english-discoveries');
 assert.equal(platformForUrl('https://lms.hust.edu.vn/course/view.php?id=1'),'moodle');
 assert.equal(platformForUrl('https://fami.hust.edu.vn/sohoa/phong-hoc'),'fami');
 assert.equal(platformForUrl('https://fake-forms.office.com.evil.com/'),'generic');
 assert.equal(platformForUrl('https://google.com/forms'),'generic');
});
test('adapters expose platform-specific capabilities',()=>{
 assert.ok(hintsForPlatform('google-forms').questionContainers.includes('.Qr7Oae'));
 assert.ok(hintsForPlatform('microsoft-forms').questionContainers.some(x=>x.includes('automation')));
 assert.ok(hintsForPlatform('english-discoveries').features.includes('audio-detection'));
});
test('non-text exercise and MFA signals are detected',()=>{
 assert.equal(isAudioOrSpeech('record your voice with microphone'),true);
 assert.equal(isLoginChallenge('Verify your identity'),true);
 assert.equal(isAudioOrSpeech('Question 1: Which city?'),false);
});
test('activity classification extends exercises and course units',()=>{
 assert.equal(kindFor('Exercise 7','https://englishdiscoveries.net/lesson/7'),'quiz');
 assert.equal(kindFor('Unit 4','https://englishdiscoveries.net/units/4'),'course');
 assert.equal(kindFor('Homework','https://lms.hust.edu.vn/mod/assign/view.php?id=2'),'assignment');
});
test('crawler stays within approved domain',()=>{
 assert.equal(safeLink('https://evil.example/collect','https://lms.hust.edu.vn/',['lms.hust.edu.vn']),null);
 assert.equal(safeLink('javascript:alert(1)','https://lms.hust.edu.vn/',['lms.hust.edu.vn']),null);
 assert.ok(safeLink('/course/view.php?id=3','https://lms.hust.edu.vn/',['lms.hust.edu.vn'])?.includes('/course/view'));
});
test('deadline parser supports Vietnamese day-first date',()=>{
 assert.equal(parseDeadline('27/10/2026 09:30','+07:00'),'2026-10-27T02:30:00.000Z');
});

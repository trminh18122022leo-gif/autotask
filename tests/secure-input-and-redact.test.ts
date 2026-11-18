import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { redactSecrets, redactObject } from '../src/security/redact.js';
import { promptSecret } from '../src/security/secure-input.js';

test('redactSecrets sanitizes diverse API keys and credential formats', () => {
  // OpenAI
  const oai = 'Error with key sk-proj-1234567890abcdefghijklmnop';
  assert.equal(redactSecrets(oai), 'Error with key sk-proj-[REDACTED]');

  // Anthropic
  const claude = 'Failed request with sk-ant-api03-abcdefghijklmnop12345678';
  assert.equal(redactSecrets(claude), 'Failed request with sk-ant-[REDACTED]');

  // Gemini
  const gemini = 'Google key AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz12345 in header';
  assert.equal(redactSecrets(gemini), 'Google key AIzaSy[REDACTED] in header');

  // Groq
  const groq = 'Groq auth failed with gsk_abcdefghijklmnop1234567890';
  assert.equal(redactSecrets(groq), 'Groq auth failed with gsk_[REDACTED]');

  // Bearer Token
  const bearer = 'Authorization: Bearer secret_jwt_token_1234567890_value';
  assert.equal(redactSecrets(bearer), 'Authorization: Bearer [REDACTED_TOKEN]');

  // Password embedded in URL
  const urlWithPwd = 'Connecting to https://myuser:supersecretpass123@lms.university.edu/login';
  assert.equal(
    redactSecrets(urlWithPwd),
    'Connecting to https://myuser:[REDACTED_PWD]@lms.university.edu/login'
  );

  // URL query secret
  const queryUrl = 'https://api.provider.com/v1?key=super_secret_query_key_value&other=1';
  assert.equal(
    redactSecrets(queryUrl),
    'https://api.provider.com/v1?key=[REDACTED]&other=1'
  );

  // Basic auth header in string
  const basicAuth = 'Authorization: Basic dXNlcjpzdXBlcnNlY3JldDEyMw==';
  assert.equal(redactSecrets(basicAuth), 'Authorization: Basic [REDACTED_CREDENTIAL]');

  // Known secret explicit list
  const customSecret = 'my-super-confidential-custom-pass';
  const customText = `Error while checking ${customSecret} on host`;
  assert.equal(
    redactSecrets(customText, [customSecret]),
    'Error while checking [REDACTED_SECRET] on host'
  );
});

test('redactObject recursively cleans payloads, objects and Error stacks', () => {
  const secretKey = 'sk-proj-9876543210zyxwvutsrqponmlk';
  const payload = {
    user: 'student1',
    apiKey: secretKey,
    details: {
      url: 'https://api.openai.com/v1',
      headers: {
        Authorization: `Bearer ${secretKey}`
      }
    },
    list: [
      `Token was: ${secretKey}`
    ]
  };

  const cleaned = redactObject(payload);
  assert.equal(cleaned.apiKey, '[REDACTED_KEY]');
  assert.ok(!JSON.stringify(cleaned).includes(secretKey));

  // Object with authorization header field
  const authObj = {
    method: 'POST',
    headers: {
      authorization: 'Basic dXNlcjpwYXNzd29yZDEyMw==',
      cookie: 'session_id=abcdef1234567890'
    }
  };
  const cleanedAuth = redactObject(authObj);
  assert.equal(cleanedAuth.headers.authorization, '[REDACTED_CREDENTIAL]');
  assert.equal(cleanedAuth.headers.cookie, '[REDACTED_CREDENTIAL]');

  // Error stack cleaning
  const err = new Error(`Connection failed with key ${secretKey}`);
  const cleanedErr = redactObject(err);
  assert.ok(!cleanedErr.message.includes(secretKey));
  assert.ok(cleanedErr.message.includes('sk-proj-[REDACTED]'));
});

test('promptSecret in controlled non-TTY stream safely resolves valid secret', async () => {
  const stream = Readable.from(['my-test-secure-key-1234\n']);
  const res = await promptSecret('Key: ', { input: stream });
  assert.equal(res, 'my-test-secure-key-1234');
});

test('promptSecret in non-TTY mode rejects empty input if allowEmpty is false', async () => {
  const emptyStream = Readable.from(['\n']);
  await assert.rejects(
    async () => {
      await promptSecret('Secret: ', { input: emptyStream, allowEmpty: false });
    },
    /Non-TTY secret input is empty/
  );
});

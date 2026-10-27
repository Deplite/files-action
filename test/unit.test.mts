import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeBaseUrl, run } from '../src/main.ts';
import { makeOutputFile, makeTempDir, readOutputs, setActionEnv } from './helpers.mts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface RecordedCall {
  url: string;
  init?: RequestInit;
  headers: Record<string, string>;
  bodyText?: string;
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      init,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    };
    if (typeof init?.body === 'string') {
      call.bodyText = init.body;
    } else if (init?.body) {
      call.bodyText = await new Response(init.body as BodyInit).text();
    }
    calls.push(call);
    return handler(call.url, init);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setInputs(inputs: Record<string, string>): string {
  const outputFile = makeOutputFile();
  setActionEnv(process.env, inputs, outputFile);
  return outputFile;
}

function makeSourceFile(content: string): string {
  const path = join(makeTempDir(), 'artifact.txt');
  writeFileSync(path, content);
  return path;
}

test('normalizeBaseUrl defaults and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl(''), 'https://api.deplite.io/v1');
  assert.equal(normalizeBaseUrl('https://example.test/v1'), 'https://example.test/v1');
  assert.equal(normalizeBaseUrl('https://example.test/v1/'), 'https://example.test/v1');
  assert.equal(normalizeBaseUrl('https://example.test/v1///'), 'https://example.test/v1');
});

test('run rejects when api-token is missing', async () => {
  setInputs({ mode: 'upload' });
  await assert.rejects(run(), /api-token/);
});

test('run rejects on unknown mode', async () => {
  setInputs({ 'api-token': 't', mode: 'copy' });
  await assert.rejects(run(), /Unknown mode 'copy'/);
});

test('upload presigns, PUTs the file, completes, and sets outputs', async () => {
  const path = makeSourceFile('hello upload');
  const outputFile = setInputs({
    'api-token': 'tkn',
    mode: 'upload',
    'base-url': 'https://mock.test/v1/',
    path,
    'cleanup-rule': 'ttl',
    'ttl-seconds': '3600',
    'content-type': 'text/plain',
    'binding-id': 'bind-1',
  });
  const calls = stubFetch((url) => {
    if (url.endsWith('/presign-upload')) {
      return jsonResponse({
        fileId: 'file 1',
        uploadUrl: 'https://blob.test/put',
        uploadHeaders: { 'x-mock-upload': 'yes' },
      });
    }
    if (url === 'https://blob.test/put') return new Response(null, { status: 200 });
    if (url.endsWith('/complete')) return jsonResponse({ id: 'file 1', size: null, status: 'stored' });
    throw new Error(`unexpected ${url}`);
  });

  await run();

  assert.equal(calls.length, 3);
  const [presign, put, complete] = calls;
  assert.equal(presign.url, 'https://mock.test/v1/storage/files/presign-upload');
  assert.equal(presign.init?.method, 'POST');
  assert.equal(presign.headers.Authorization, 'Bearer tkn');
  assert.equal(presign.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(presign.bodyText ?? ''), {
    filename: 'artifact.txt',
    cleanupRule: 'ttl',
    contentType: 'text/plain',
    ttlSeconds: 3600,
    bindingId: 'bind-1',
  });
  assert.equal(put.url, 'https://blob.test/put');
  assert.equal(put.init?.method, 'PUT');
  assert.deepEqual(put.headers, { 'x-mock-upload': 'yes', 'Content-Type': 'text/plain' });
  assert.equal(put.bodyText, 'hello upload');
  assert.equal(complete.url, 'https://mock.test/v1/storage/files/file%201/complete');
  assert.equal(complete.init?.method, 'POST');
  assert.deepEqual(readOutputs(outputFile), { 'file-id': 'file 1', size: '12', status: 'stored' });
});

test('upload uses filename override, omits optional presign fields, and reports API size', async () => {
  const path = makeSourceFile('x');
  const outputFile = setInputs({
    'api-token': 'tkn',
    mode: 'upload',
    'base-url': 'https://mock.test/v1',
    path,
    filename: 'custom.txt',
    'cleanup-rule': 'persistent',
  });
  const calls = stubFetch((url) => {
    if (url.endsWith('/presign-upload')) {
      return jsonResponse({ fileId: 'f2', uploadUrl: 'https://blob.test/put' });
    }
    if (url === 'https://blob.test/put') return new Response(null, { status: 200 });
    if (url.endsWith('/complete')) return jsonResponse({ id: 'f2', size: 999, status: 'stored' });
    throw new Error(`unexpected ${url}`);
  });

  await run();

  assert.deepEqual(JSON.parse(calls[0].bodyText ?? ''), {
    filename: 'custom.txt',
    cleanupRule: 'persistent',
  });
  assert.deepEqual(calls[1].headers, {});
  assert.deepEqual(readOutputs(outputFile), { 'file-id': 'f2', size: '999', status: 'stored' });
});

test('upload keeps presigned content-type header over the input', async () => {
  const path = makeSourceFile('x');
  setInputs({
    'api-token': 'tkn',
    mode: 'upload',
    'base-url': 'https://mock.test/v1',
    path,
    'cleanup-rule': 'ttl',
    'content-type': 'text/plain',
  });
  const calls = stubFetch((url) => {
    if (url.endsWith('/presign-upload')) {
      return jsonResponse({
        fileId: 'f3',
        uploadUrl: 'https://blob.test/put',
        uploadHeaders: { 'content-type': 'application/gzip' },
      });
    }
    if (url === 'https://blob.test/put') return new Response(null, { status: 200 });
    if (url.endsWith('/complete')) return jsonResponse({ id: 'f3', size: 1, status: 'stored' });
    throw new Error(`unexpected ${url}`);
  });

  await run();

  assert.deepEqual(calls[1].headers, { 'content-type': 'application/gzip' });
});

test('upload requires path', async () => {
  setInputs({ 'api-token': 't', mode: 'upload', 'cleanup-rule': 'ttl' });
  await assert.rejects(run(), /Input 'path' is required for this mode\./);
});

test('upload validates cleanup-rule', async () => {
  setInputs({ 'api-token': 't', mode: 'upload', path: 'whatever', 'cleanup-rule': 'forever' });
  await assert.rejects(run(), /'cleanup-rule' must be 'ttl' or 'persistent', got 'forever'/);
});

test('upload surfaces presign API errors with body text', async () => {
  const path = makeSourceFile('x');
  setInputs({
    'api-token': 't',
    mode: 'upload',
    'base-url': 'https://mock.test/v1',
    path,
    'cleanup-rule': 'ttl',
  });
  stubFetch(() => new Response('{"error":"nope"}', { status: 400, statusText: 'Bad Request' }));
  await assert.rejects(run(), (err: Error) => {
    assert.match(err.message, /POST https:\/\/mock\.test\/v1\/storage\/files\/presign-upload failed: HTTP 400/);
    assert.match(err.message, /nope/);
    return true;
  });
});

test('upload fails when the presigned PUT is rejected', async () => {
  const path = makeSourceFile('x');
  setInputs({
    'api-token': 't',
    mode: 'upload',
    'base-url': 'https://mock.test/v1',
    path,
    'cleanup-rule': 'ttl',
  });
  stubFetch((url) => {
    if (url.endsWith('/presign-upload')) {
      return jsonResponse({ fileId: 'f4', uploadUrl: 'https://blob.test/put' });
    }
    return new Response(null, { status: 500, statusText: 'Internal Server Error' });
  });
  await assert.rejects(run(), /Upload PUT failed: HTTP 500/);
});

test('download writes dest (creating directories) and sets size output', async () => {
  const dest = join(makeTempDir(), 'nested', 'dir', 'file.bin');
  const outputFile = setInputs({
    'api-token': 'tok',
    mode: 'download',
    'base-url': 'https://mock.test/v1',
    'file-id': 'id 9',
    dest,
  });
  const calls = stubFetch((url) => {
    if (url === 'https://mock.test/v1/storage/files/id%209/download-url') {
      return jsonResponse({ downloadUrl: 'https://blob.test/get', expiresInSeconds: 30 });
    }
    if (url === 'https://blob.test/get') return new Response('downloaded-content');
    throw new Error(`unexpected ${url}`);
  });

  await run();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[1].init, undefined);
  assert.equal(readFileSync(dest, 'utf8'), 'downloaded-content');
  assert.deepEqual(readOutputs(outputFile), { size: '18' });
});

test('download requires dest', async () => {
  setInputs({ 'api-token': 't', mode: 'download', 'file-id': 'x' });
  await assert.rejects(run(), /Input 'dest' is required for this mode\./);
});

test('download fails when the presigned GET is rejected', async () => {
  setInputs({
    'api-token': 't',
    mode: 'download',
    'base-url': 'https://mock.test/v1',
    'file-id': 'x',
    dest: join(makeTempDir(), 'out.bin'),
  });
  stubFetch((url) => {
    if (url.endsWith('/download-url')) {
      return jsonResponse({ downloadUrl: 'https://blob.test/get', expiresInSeconds: 30 });
    }
    return new Response(null, { status: 404, statusText: 'Not Found' });
  });
  await assert.rejects(run(), /Download failed: HTTP 404/);
});

test('delete issues DELETE with bearer token and accepts 204', async () => {
  const outputFile = setInputs({
    'api-token': 'tok',
    mode: 'delete',
    'base-url': 'https://mock.test/v1',
    'file-id': 'del me',
  });
  const calls = stubFetch(() => new Response(null, { status: 204 }));

  await run();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://mock.test/v1/storage/files/del%20me');
  assert.equal(calls[0].init?.method, 'DELETE');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.deepEqual(readOutputs(outputFile), {});
});

test('delete surfaces HTTP errors with body text', async () => {
  setInputs({
    'api-token': 't',
    mode: 'delete',
    'base-url': 'https://mock.test/v1',
    'file-id': 'x',
  });
  stubFetch(() => new Response('gone wrong', { status: 403, statusText: 'Forbidden' }));
  await assert.rejects(run(), (err: Error) => {
    assert.match(err.message, /Delete failed: HTTP 403/);
    assert.match(err.message, /gone wrong/);
    return true;
  });
});

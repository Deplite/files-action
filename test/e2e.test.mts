import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOutputFile, makeTempDir, readOutputs, setActionEnv } from './helpers.mts';

const distPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const downloadPayload = Buffer.concat([Buffer.from('e2e-download-payload-'), Buffer.from([0, 1, 2, 255])]);

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let server: Server;
let origin = '';
const requests: RecordedRequest[] = [];
const blobs = new Map<string, Buffer>();

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function route(method: string, url: string, body: Buffer, res: ServerResponse): void {
  if (method === 'POST' && url === '/v1/storage/files/presign-upload') {
    json(res, {
      fileId: 'f-123',
      uploadUrl: `${origin}/blob/f-123`,
      uploadHeaders: { 'x-mock-upload': 'yes' },
    });
    return;
  }
  if (method === 'PUT' && url === '/blob/f-123') {
    blobs.set('f-123', body);
    res.writeHead(200).end();
    return;
  }
  if (method === 'POST' && url === '/v1/storage/files/f-123/complete') {
    json(res, { id: 'f-123', size: blobs.get('f-123')?.length ?? null, status: 'stored' });
    return;
  }
  if (method === 'GET' && url === '/v1/storage/files/f-456/download-url') {
    json(res, { downloadUrl: `${origin}/blob/f-456`, expiresInSeconds: 60 });
    return;
  }
  if (method === 'GET' && url === '/blob/f-456') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(downloadPayload);
    return;
  }
  if (method === 'DELETE' && url === '/v1/storage/files/f-789') {
    res.writeHead(204).end();
    return;
  }
  if (method === 'DELETE' && url === '/v1/storage/files/boom') {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('storage backend unavailable');
    return;
  }
  res.writeHead(404).end('unexpected request');
}

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const method = req.method ?? '';
      const url = req.url ?? '';
      requests.push({ method, url, headers: req.headers, body });
      route(method, url, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  requests.length = 0;
  blobs.clear();
});

interface ActionResult {
  status: number | null;
  stdout: string;
  stderr: string;
  outputFile: string;
}

// spawnSync would block the event loop and deadlock against the in-process mock server
async function runAction(inputs: Record<string, string>): Promise<ActionResult> {
  const outputFile = makeOutputFile();
  const env: NodeJS.ProcessEnv = { ...process.env };
  setActionEnv(env, { 'base-url': `${origin}/v1`, ...inputs }, outputFile);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distPath], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, outputFile }));
  });
}

test('upload: presign, PUT to presigned URL, complete, outputs', async () => {
  const path = join(makeTempDir(), 'artifact.bin');
  const content = Buffer.concat([Buffer.from('upload-payload-'), Buffer.from([0, 1, 2, 250])]);
  writeFileSync(path, content);

  const result = await runAction({
    'api-token': 'e2e-token',
    mode: 'upload',
    path,
    filename: 'custom-name.bin',
    'content-type': 'application/octet-stream',
    'cleanup-rule': 'persistent',
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    'POST /v1/storage/files/presign-upload',
    'PUT /blob/f-123',
    'POST /v1/storage/files/f-123/complete',
  ]);
  const [presign, put, complete] = requests;
  assert.equal(presign.headers.authorization, 'Bearer e2e-token');
  assert.equal(presign.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(presign.body.toString('utf8')), {
    filename: 'custom-name.bin',
    cleanupRule: 'persistent',
    contentType: 'application/octet-stream',
  });
  assert.equal(put.headers['x-mock-upload'], 'yes');
  assert.equal(put.headers['content-type'], 'application/octet-stream');
  assert.ok(put.body.equals(content));
  assert.equal(complete.headers.authorization, 'Bearer e2e-token');
  assert.deepEqual(readOutputs(result.outputFile), {
    'file-id': 'f-123',
    size: String(content.length),
    status: 'stored',
  });
});

test('download: resolves presigned URL and writes dest', async () => {
  const dest = join(makeTempDir(), 'nested', 'out', 'result.bin');

  const result = await runAction({ 'api-token': 'e2e-token', mode: 'download', 'file-id': 'f-456', dest });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    'GET /v1/storage/files/f-456/download-url',
    'GET /blob/f-456',
  ]);
  assert.equal(requests[0].headers.authorization, 'Bearer e2e-token');
  assert.equal(requests[1].headers.authorization, undefined);
  assert.ok(readFileSync(dest).equals(downloadPayload));
  assert.deepEqual(readOutputs(result.outputFile), { size: String(downloadPayload.length) });
});

test('delete: issues DELETE with bearer token', async () => {
  const result = await runAction({ 'api-token': 'e2e-token', mode: 'delete', 'file-id': 'f-789' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ['DELETE /v1/storage/files/f-789']);
  assert.equal(requests[0].headers.authorization, 'Bearer e2e-token');
  assert.deepEqual(readOutputs(result.outputFile), {});
});

test('API failure exits 1 with an error annotation', async () => {
  const result = await runAction({ 'api-token': 'e2e-token', mode: 'delete', 'file-id': 'boom' });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /::error::/);
  assert.match(result.stdout, /Delete failed: HTTP 500/);
  assert.match(result.stdout, /storage backend unavailable/);
});

test('unknown mode exits 1 without calling the API', async () => {
  const result = await runAction({ 'api-token': 'e2e-token', mode: 'sideload' });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /::error::Unknown mode 'sideload'/);
  assert.equal(requests.length, 0);
});

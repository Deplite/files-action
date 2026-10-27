import * as core from '@actions/core';
import { createReadStream, statSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';

interface PresignUploadResponse {
  fileId: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  expiresInSeconds?: number;
}

interface FileMeta {
  id: string;
  size: number | null;
  status: string;
}

interface DownloadUrlResponse {
  downloadUrl: string;
  expiresInSeconds: number;
}

const DEFAULT_BASE_URL = 'https://api.deplite.io/v1';

export function normalizeBaseUrl(raw: string): string {
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export async function run(): Promise<void> {
  const apiToken = core.getInput('api-token', { required: true });
  const mode = core.getInput('mode', { required: true });
  const baseUrl = normalizeBaseUrl(core.getInput('base-url'));

  switch (mode) {
    case 'upload':
      await upload(apiToken, baseUrl);
      return;
    case 'download':
      await download(apiToken, baseUrl);
      return;
    case 'delete':
      await remove(apiToken, baseUrl);
      return;
    default:
      throw new Error(`Unknown mode '${mode}' — expected one of: upload, download, delete`);
  }
}

async function upload(apiToken: string, baseUrl: string): Promise<void> {
  const path = required('path');
  const cleanupRule = required('cleanup-rule');
  if (cleanupRule !== 'ttl' && cleanupRule !== 'persistent') {
    throw new Error(`'cleanup-rule' must be 'ttl' or 'persistent', got '${cleanupRule}'`);
  }
  const filename = core.getInput('filename') || basename(path);
  const contentType = core.getInput('content-type') || undefined;
  const ttlRaw = core.getInput('ttl-seconds');
  const ttlSeconds = ttlRaw ? Number(ttlRaw) : undefined;
  const bindingId = core.getInput('binding-id') || undefined;

  const stat = statSync(path);
  core.info(`Uploading ${path} (${stat.size} bytes) as '${filename}' [${cleanupRule}]`);

  const presignBody: Record<string, unknown> = { filename, cleanupRule };
  if (contentType) presignBody.contentType = contentType;
  if (ttlSeconds !== undefined) presignBody.ttlSeconds = ttlSeconds;
  if (bindingId) presignBody.bindingId = bindingId;

  const presign = await apiJson<PresignUploadResponse>(
    `${baseUrl}/storage/files/presign-upload`,
    { method: 'POST', token: apiToken, body: presignBody },
  );

  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
  const putHeaders: Record<string, string> = { ...(presign.uploadHeaders ?? {}) };
  if (contentType && !putHeaders['Content-Type'] && !putHeaders['content-type']) {
    putHeaders['Content-Type'] = contentType;
  }
  const putRes = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: putHeaders,
    body: stream,
    // @ts-expect-error — undici-only field, required for streaming PUTs
    duplex: 'half',
  });
  if (!putRes.ok) {
    throw new Error(`Upload PUT failed: HTTP ${putRes.status} ${putRes.statusText}`);
  }

  const meta = await apiJson<FileMeta>(
    `${baseUrl}/storage/files/${encodeURIComponent(presign.fileId)}/complete`,
    { method: 'POST', token: apiToken },
  );

  core.setOutput('file-id', meta.id);
  core.setOutput('size', String(meta.size ?? stat.size));
  core.setOutput('status', meta.status);
  core.info(`Uploaded: file-id=${meta.id} status=${meta.status}`);
}

async function download(apiToken: string, baseUrl: string): Promise<void> {
  const fileId = required('file-id');
  const dest = required('dest');

  const urlRes = await apiJson<DownloadUrlResponse>(
    `${baseUrl}/storage/files/${encodeURIComponent(fileId)}/download-url`,
    { method: 'GET', token: apiToken },
  );

  const getRes = await fetch(urlRes.downloadUrl);
  if (!getRes.ok) {
    throw new Error(`Download failed: HTTP ${getRes.status} ${getRes.statusText}`);
  }
  const buf = Buffer.from(await getRes.arrayBuffer());
  mkdirSync(dirname(resolve(dest)), { recursive: true });
  await writeFile(dest, buf);
  core.setOutput('size', String(buf.length));
  core.info(`Downloaded ${buf.length} bytes to ${dest}`);
}

async function remove(apiToken: string, baseUrl: string): Promise<void> {
  const fileId = required('file-id');
  const res = await fetch(`${baseUrl}/storage/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (res.status !== 204 && !res.ok) {
    throw new Error(`Delete failed: HTTP ${res.status} ${res.statusText} — ${await res.text()}`);
  }
  core.info(`Deleted file ${fileId}`);
}

function required(name: string): string {
  const v = core.getInput(name);
  if (!v) throw new Error(`Input '${name}' is required for this mode.`);
  return v;
}

async function apiJson<T>(
  url: string,
  opts: { method: string; token: string; body?: unknown },
): Promise<T> {
  const res = await fetch(url, {
    method: opts.method,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${opts.method} ${url} failed: HTTP ${res.status} ${res.statusText} — ${text}`);
  }
  return JSON.parse(text) as T;
}

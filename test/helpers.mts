import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'files-action-test-'));
}

export function makeOutputFile(): string {
  const file = join(makeTempDir(), 'github-output');
  writeFileSync(file, '');
  return file;
}

export function setActionEnv(
  env: NodeJS.ProcessEnv,
  inputs: Record<string, string>,
  outputFile: string,
): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('INPUT_')) delete env[key];
  }
  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }
  env.GITHUB_OUTPUT = outputFile;
}

export function readOutputs(file: string): Record<string, string> {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const outputs: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const header = /^(.+?)<<(.+)$/.exec(lines[i]);
    if (!header) continue;
    const value: string[] = [];
    for (i++; i < lines.length && lines[i] !== header[2]; i++) value.push(lines[i]);
    outputs[header[1]] = value.join('\n');
  }
  return outputs;
}

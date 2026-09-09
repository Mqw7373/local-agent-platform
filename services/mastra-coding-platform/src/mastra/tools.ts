import { spawn } from 'node:child_process';
import path from 'node:path';
import { audit } from './audit.js';
import { getProjectConfig } from './config.js';

const outputLimit = 40_000;

async function executeCommand(profileId: string, commandId: string) {
  const config = await getProjectConfig(profileId);
  const command = config.verificationCommands.find(item => item.id === commandId);
  if (!command) throw new Error(`Unknown configured command id: ${commandId}`);
  const cwd = command.cwd ? path.resolve(config.projectRoot, command.cwd) : config.projectRoot;
  const started = Date.now();
  return new Promise<{
    id: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
  }>((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...command.env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => {
      if (stdout.length < outputLimit) stdout += String(chunk).slice(0, outputLimit - stdout.length);
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < outputLimit) stderr += String(chunk).slice(0, outputLimit - stderr.length);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, command.timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({
        id: command.id,
        exitCode: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}spawn failed: ${error.message}`,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({ id: command.id, exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
  });
}

export async function runAllVerification(profileId: string) {
  const config = await getProjectConfig(profileId);
  const commands = [];
  for (const command of config.verificationCommands) commands.push(await executeCommand(profileId, command.id));
  const result = { passed: commands.every(item => item.exitCode === 0 && !item.timedOut), commands };
  await audit(profileId, { actor: 'automated-verification', action: 'verification-complete', data: result });
  return result;
}

#!/usr/bin/env node
/**
 * P1a — Supported-distribution local pack proof (no publish).
 *
 * Packs to a temp dir, inspects against allowlist, clean-installs the tarball,
 * and runs CLI --help smoke.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

type Allowlist = {
  package_json_files_field: string[];
  engines: { node: string };
  size_ceiling_bytes: number;
  required_pack_paths: string[];
  forbidden_pack_path_prefixes: string[];
  smoke: { help_args: string[]; help_must_contain: string[] };
  publish_authorized: boolean;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

function run(command: string, args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_ignore_scripts: undefined },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function listTarballPaths(tarballPath: string): string[] {
  const result = run('npm', ['pack', '--dry-run', '--json'], path.dirname(tarballPath));
  // Prefer tar listing via npm pack content inspection.
  const list = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
  if (list.status === 0 && list.stdout) {
    return list.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^package\//, ''));
  }
  // Fallback: node tar via npm's pack dry-run is not always enough on Windows without tar.
  void result;
  throw new Error('Unable to list tarball contents (tar -tzf failed)');
}

function main(): void {
  const allowlist = readJson<Allowlist>('config/ci/package-files-allowlist.json');
  if (allowlist.publish_authorized) {
    throw new Error('P1a allowlist must keep publish_authorized=false');
  }

  const pkg = readJson<{ files?: string[]; engines?: { node?: string }; name: string; version: string }>(
    'package.json'
  );
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error('package.json missing non-empty files allowlist');
  }
  for (const required of allowlist.package_json_files_field) {
    if (!pkg.files.includes(required)) {
      throw new Error(`package.json files missing required entry: ${required}`);
    }
  }
  if (pkg.engines?.node !== allowlist.engines.node) {
    throw new Error(`package.json engines.node must be ${allowlist.engines.node}`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-p1a-pack-'));
  const packDir = path.join(tmpRoot, 'pack');
  fs.mkdirSync(packDir, { recursive: true });

  try {
    // Ensure dist exists for packing without publish.
    if (!fs.existsSync(path.join(repoRoot, 'dist', 'index.js'))) {
      const build = run('npm', ['run', 'build'], repoRoot);
      if (build.status !== 0) {
        throw new Error(`build failed: ${build.stderr || build.stdout}`);
      }
    }

    const pack = run('npm', ['pack', '--pack-destination', packDir], repoRoot);
    if (pack.status !== 0) {
      throw new Error(`npm pack failed: ${pack.stderr || pack.stdout}`);
    }

    const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly one tarball in ${packDir}, found ${tarballs.length}`);
    }
    const tarballPath = path.join(packDir, tarballs[0]);
    const size = fs.statSync(tarballPath).size;
    if (size > allowlist.size_ceiling_bytes) {
      throw new Error(`tarball size ${size} exceeds ceiling ${allowlist.size_ceiling_bytes}`);
    }

    const packedPaths = listTarballPaths(tarballPath);
    for (const required of allowlist.required_pack_paths) {
      if (!packedPaths.includes(required)) {
        throw new Error(`packed tarball missing required path: ${required}`);
      }
    }
    for (const packed of packedPaths) {
      for (const forbidden of allowlist.forbidden_pack_path_prefixes) {
        if (packed === forbidden.replace(/\/$/, '') || packed.startsWith(forbidden)) {
          throw new Error(`packed tarball contains forbidden path: ${packed}`);
        }
      }
    }

    const extractDir = path.join(tmpRoot, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    const extract = spawnSync('tar', ['-xzf', tarballPath, '-C', extractDir], { encoding: 'utf8' });
    if (extract.status !== 0) {
      throw new Error(`tar extract failed: ${extract.stderr || extract.stdout}`);
    }
    const extractedPkgRoot = path.join(extractDir, 'package');
    if (!fs.existsSync(path.join(extractedPkgRoot, 'package.json'))) {
      throw new Error(`extracted package missing package.json under ${extractedPkgRoot}`);
    }

    // Clean production install from the packed artifact (no publish; ignore prepare/build scripts).
    const install = run(
      'npm',
      ['install', '--omit=dev', '--ignore-scripts', '--no-package-lock'],
      extractedPkgRoot
    );
    if (install.status !== 0) {
      throw new Error(`clean install failed: ${install.stderr || install.stdout}`);
    }

    const binPath = path.join(extractedPkgRoot, 'bin', 'context-engine-mcp.js');
    if (!fs.existsSync(binPath)) {
      throw new Error(`installed package missing bin at ${binPath}`);
    }

    const help = spawnSync(process.execPath, [binPath, ...allowlist.smoke.help_args], {
      cwd: extractedPkgRoot,
      encoding: 'utf8',
      env: { ...process.env },
    });
    const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
    for (const needle of allowlist.smoke.help_must_contain) {
      if (!helpText.includes(needle)) {
        throw new Error(`CLI help smoke missing expected text: ${needle}\n${helpText}`);
      }
    }

    const receipt = {
      schema_version: 1,
      task_id: 'P1a',
      disposition: 'implemented',
      publish_authorized: false,
      package_name: pkg.name,
      package_version: pkg.version,
      tarball: path.basename(tarballPath),
      tarball_size_bytes: size,
      packed_path_count: packedPaths.length,
      required_paths_present: allowlist.required_pack_paths,
      forbidden_paths_absent: true,
      clean_install: true,
      cli_help_smoke: true,
      temp_dir: tmpRoot,
      generated_at_utc: new Date().toISOString(),
    };
    const receiptPath = path.join(repoRoot, 'artifacts/plan/context-engine-remediation-p1a-pack-proof.json');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ status: 'pass', receipt: path.relative(repoRoot, receiptPath).replace(/\\/g, '/') }, null, 2));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

try {
  main();
  process.exit(0);
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

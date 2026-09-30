#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod, copyFile, lstat, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED_STATUSES = new Set([
  'idle', 'withheld', 'held_disabled', 'held_claimed', 'solo_selected',
  'solo_completed', 'submitting', 'submitted', 'delivery_failed', 'pending_expired',
]);

class VerifyFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireCheck(condition, code) {
  if (!condition) throw new VerifyFailure(code);
}

async function checked(code, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof VerifyFailure) throw error;
    throw new VerifyFailure(code);
  }
}

async function parseJson(file, code) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new VerifyFailure(code);
  }
}

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function safeConfigFile(file) {
  const info = await lstat(file).catch(() => null);
  requireCheck(info?.isFile() && !info.isSymbolicLink() && info.nlink === 1,
    'config_file_unsafe');
  requireCheck((info.mode & 0o777) === 0o644, 'config_file_mode');
}

function dashboardCheck(server, config, data) {
  const program = [
    'import importlib.util,sys',
    'server_path,config_path,data_path=sys.argv[1:]',
    'spec=importlib.util.spec_from_file_location("aru_postinstall_dashboard",server_path)',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'state,config,interaction=module.load_snapshot_inputs(config_path,data_path)',
    'module.create_dashboard_snapshot(state,config,interaction=interaction)',
  ].join(';');
  const result = spawnSync('python3', ['-I', '-c', program, server, config, data], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  requireCheck(result.status === 0, 'dashboard_reader');
}

async function safeCycleCheck(root, data, config, delivery) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'aru-postinstall-verify-'));
  try {
    await chmod(temporary, 0o700);
    const safeConfig = structuredClone(config);
    safeConfig.observeOnly = true;
    safeConfig.deliveryEnabled = false;
    const safeDelivery = structuredClone(delivery);
    safeDelivery.enabled = false;
    const configPath = path.join(temporary, 'default.json');
    const deliveryPath = path.join(temporary, 'aru-delivery.json');
    await writeFile(configPath, JSON.stringify(safeConfig), { mode: 0o600 });
    await writeFile(deliveryPath, JSON.stringify(safeDelivery), { mode: 0o600 });
    for (const name of ['state.json', 'interaction-state.json']) {
      const target = path.join(temporary, name);
      await copyFile(path.join(data, name), target);
      await chmod(target, 0o600);
    }
    const result = spawnSync(process.execPath, [
      path.join(root, 'bin/desire-cycle.mjs'),
      '--config', configPath,
      '--delivery-config', deliveryPath,
      '--data-dir', temporary,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    requireCheck(result.status === 0, 'heartbeat_entry');
    let output;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      throw new VerifyFailure('heartbeat_output');
    }
    requireCheck(
      output?.schema === 'aru.desire-heartbeat.cycle-result.v1' &&
      ALLOWED_STATUSES.has(output.status),
      'heartbeat_output',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verify(root, data, expectedVersion) {
  const injected = process.env.ARU_ACTIVE_UPGRADE_INJECT_POSTINSTALL_FAILURE;
  const injectable = new Set([
    'config_schema', 'state_schema', 'interaction_schema',
    'dashboard_reader', 'heartbeat_entry',
  ]);
  if (process.env.ARU_ACTIVE_UPGRADE_ISOLATED_TEST_MODE === '1' &&
      injectable.has(injected)) {
    throw new VerifyFailure(injected);
  }
  const configPath = path.join(root, 'config/default.json');
  const deliveryPath = path.join(root, 'config/aru-delivery.json');
  const statePath = path.join(data, 'state.json');
  const interactionPath = path.join(data, 'interaction-state.json');
  await safeConfigFile(configPath);
  const packageJson = await parseJson(path.join(root, 'package.json'), 'package_file');
  requireCheck(packageJson.version === expectedVersion, 'package_version');

  const [storage, interactionStorage, adapter] = await checked(
    'runtime_import',
    () => Promise.all([
      import(pathToFileURL(path.join(root, 'src/storage.mjs'))),
      import(pathToFileURL(path.join(root, 'src/interaction-storage.mjs'))),
      import(pathToFileURL(path.join(root, 'delivery/aru-adapter.mjs'))),
    ]),
  );
  const config = await checked('config_schema', () => storage.loadConfig(configPath));
  await checked('state_schema', () => storage.loadState(data, config));
  await checked(
    'interaction_schema',
    () => interactionStorage.loadInteractionState(data, config),
  );
  const delivery = await checked('delivery_config', async () =>
    adapter.validateDeliveryConfig(await parseJson(deliveryPath, 'delivery_config')));

  const before = [await digest(statePath), await digest(interactionPath)];
  dashboardCheck(path.join(root, 'dashboard/server.py'), configPath, data);
  await safeCycleCheck(root, data, config, delivery);
  const after = [await digest(statePath), await digest(interactionPath)];
  requireCheck(JSON.stringify(after) === JSON.stringify(before), 'production_state_changed');
}

const [root, data, expectedVersion] = process.argv.slice(2);
try {
  requireCheck(process.argv.length === 5 && path.isAbsolute(root) &&
    path.isAbsolute(data) && /^\d+\.\d+\.\d+$/u.test(expectedVersion), 'usage');
  await verify(path.resolve(root), path.resolve(data), expectedVersion);
  process.stdout.write('ACTIVE_POSTINSTALL_VERIFY=PASS\n');
} catch (error) {
  const code = error instanceof VerifyFailure ? error.code : 'internal_error';
  process.stdout.write(`ACTIVE_POSTINSTALL_VERIFY=FAIL\nfailure_class=${code}\n`);
  process.exitCode = 1;
}

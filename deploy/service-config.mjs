import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { check, digest } from './core.mjs';

// A deliberately small subset of systemd syntax for existing network/PATH
// drop-ins. This is a verifier, never a renderer or service configuration writer.
export function inspectServiceDropIns(t, unitFile, homeDir, version, reportedPaths, run) {
  const pins = t.serviceDropIns ?? [];
  const hook = t.serviceIndexHook;
  if (hook) {
    check(hook.path === path.join(homeDir, '.local/share/t3code-custom/ensure-orchestration-indexes.sh') && hook.sha256 === '59ef3df05bfd4d1903bb58389ade9dcd768ae160c821d380c4d2e0624ace9ea1', 'unsupported', 'Only the reviewed existing index-maintenance helper is supported');
    check(fs.realpathSync(hook.path) === hook.path && fs.statSync(hook.path).isFile() && digest(fs.readFileSync(hook.path)) === hook.sha256, 'service-config', 'Reviewed index helper identity changed');
  }
  let hookLine = false, timeoutLine = false;
  check(Array.isArray(pins) && pins.length <= 8, 'config', 'serviceDropIns must pin the complete reviewed path/hash set');
  const directory = unitFile + '.d', seen = new Set(), values = {};
  for (const pin of pins) {
    check(typeof pin.path === 'string' && path.isAbsolute(pin.path) && !/\s/.test(pin.path) && path.dirname(pin.path) === directory && /^[A-Za-z0-9_.-]+\.conf$/.test(path.basename(pin.path)) && /^[a-f0-9]{64}$/.test(pin.sha256) && !seen.has(pin.path), 'config', 'Pin unique canonical local service drop-in paths and SHA-256 hashes');
    seen.add(pin.path);
  }
  const expected = [...seen].sort();
  const loaded = reportedPaths.trim() ? reportedPaths.trim().split(/\s+/).sort() : [];
  check(JSON.stringify(loaded) === JSON.stringify(expected), 'service-config', 'Loaded service drop-in path set differs from reviewed configuration');
  // Catch a local addition/removal even before daemon-reload notices it.
  const present = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.conf')).map(name => path.join(directory, name)).sort() : [];
  check(JSON.stringify(present) === JSON.stringify(expected), 'service-config', 'Service drop-in file set differs from reviewed configuration');
  const files = pins.map(pin => {
    check(fs.realpathSync(pin.path) === path.resolve(pin.path) && fs.statSync(pin.path).isFile(), 'service-config', 'Service drop-ins must be canonical regular files');
    const bytes = fs.readFileSync(pin.path);
    check(bytes.length <= 16384 && digest(bytes) === pin.sha256, 'service-config', 'Service drop-in bytes differ from the reviewed hash');
    const contents = bytes.toString('utf8');
    check(Buffer.from(contents).equals(bytes), 'unsupported', 'Service drop-in must be UTF-8 text');
    let section = false;
    for (const raw of contents.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      if (line === '[Service]' && !section) { section = true; continue; }
      if (hook && line === 'ExecStartPre=-' + hook.path) { check(section && !hookLine, 'service-config', 'Duplicate index startup helper'); hookLine = true; continue; }
      if (hook && line === 'TimeoutStartSec=900') { check(section && !timeoutLine, 'service-config', 'Duplicate startup timeout'); timeoutLine = true; continue; }
      const match = /^Environment="(PATH|T3CODE_HOST|T3CODE_PORT|T3CODE_NO_BROWSER)=([^"\\%$\s]+)"$/.exec(line);
      check(section && match && !Object.hasOwn(values, match[1]), 'unsupported', 'Only single reviewed PATH/HOST/PORT/NO_BROWSER Environment assignments are supported');
      const [, key, value] = match;
      check(key !== 'PATH' || value.split(':').every(p => /^\/[A-Za-z0-9_./-]+$/.test(p)), 'unsupported', 'PATH must contain explicit absolute directories');
      check(key !== 'T3CODE_HOST' || isIP(value) !== 0 || value === 'localhost', 'unsupported', 'HOST must be a literal IP address or localhost');
      check(key !== 'T3CODE_PORT' || (/^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535 && Number(value) === Number(new URL(t.origin).port || 80)), 'service-config', 'Pinned PORT differs from the inspected origin');
      check(key !== 'T3CODE_NO_BROWSER' || value === '1', 'unsupported', 'Only NO_BROWSER=1 is supported');
      values[key] = value;
    }
    check(section, 'unsupported', 'Expected a Service section in the drop-in');
    return { path: pin.path, sha256: pin.sha256, bytes: bytes.length, contents };
  });
  check(!hook || (hookLine && timeoutLine), 'service-config', 'Reviewed index hook requires its exact startup directives');
  if (!pins.length) return { dropIns: files };

  // Confirm systemd loaded exactly these semantics, not stale cached directives.
  // Only this reviewed subset needs the restricted property serialization below;
  // existing empty-drop-in hosts retain their canonical-unit validation.
  check(!/\s/.test(t.baseDir + homeDir), 'unsupported', 'Reviewed drop-in support requires unambiguous service paths without whitespace');
  const names = ['NeedDaemonReload', 'Environment', 'EnvironmentFiles', 'PassEnvironment', 'UnsetEnvironment', 'ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'Type', 'Restart', 'WorkingDirectory', 'KillMode', 'KillSignal', 'RestartKillSignal', 'FinalKillSignal', 'SendSIGKILL', 'OOMPolicy', ...(hook ? ['TimeoutStartUSec'] : [])];
  const output = run('systemctl', ['--user', 'show', '--all', t.service, ...names.flatMap(name => ['-p', name])]);
  const properties = Object.fromEntries(output.trim().split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  const expectedProperties = { NeedDaemonReload: 'no', Type: 'simple', Restart: 'always', WorkingDirectory: homeDir, KillMode: 'mixed', KillSignal: '15', RestartKillSignal: '15', FinalKillSignal: '9', SendSIGKILL: 'yes', OOMPolicy: 'continue' };
  for (const [key, value] of Object.entries(expectedProperties)) check(properties[key] === value, 'service-config', 'Effective service semantics differ: ' + key);
  for (const key of ['EnvironmentFiles', 'PassEnvironment', 'UnsetEnvironment', ...(hook ? [] : ['ExecStartPre']), 'ExecStartPost', 'ExecStop', 'ExecStopPost']) check(!properties[key], 'unsupported', 'Unsupported effective service directive: ' + key);
  if (hook) {
    const pre = properties.ExecStartPre ?? '';
    check(pre.startsWith(`{ path=${hook.path} ; argv[]=${hook.path} ; ignore_errors=yes ;`) && pre.endsWith(' }') && pre.indexOf('{', 1) === -1 && properties.TimeoutStartUSec === '15min', 'service-config', 'Effective index startup semantics differ');
  }
  const environment = (properties.Environment ?? '').split(/\s+/).filter(Boolean).sort();
  const expectedEnvironment = Object.entries({ T3CODE_HOME: t.baseDir, T3_BOOT_SERVICE_UNIT: t.service, ...values }).map(([key, value]) => key + '=' + value).sort();
  check(JSON.stringify(environment) === JSON.stringify(expectedEnvironment), 'service-config', 'Effective service environment differs from pinned unit/drop-ins');
  const server = path.join(t.baseDir, 'runtime/versions', version, 't3'), exec = properties.ExecStart ?? '';
  check(exec.startsWith(`{ path=${server} ; argv[]=${server} __service-launcher ; ignore_errors=no ;`) && exec.endsWith(' }') && exec.indexOf('{', 1) === -1, 'unsupported', 'Effective service launcher differs from the pinned runtime');
  return { dropIns: files, effectiveEnvironment: expectedEnvironment, effectivePolicy: expectedProperties, ...(hook ? { indexStartupHelper: hook, timeoutStartSeconds: 900 } : {}) };
}

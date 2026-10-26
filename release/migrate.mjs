// Copied into the pinned source's scripts/ directory; uses its exact migration code.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { selectCliRuntimeExternalDependencies } from '../scripts/lib/cli-external-packages.ts';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { migrationManifest } from '../apps/server/src/persistence/Migrations.ts';
import { makeSqlitePersistenceLive } from '../apps/server/src/persistence/Layers/Sqlite.ts';
if (process.argv[2] === '--manifest') {
  console.log(JSON.stringify([...migrationManifest].sort((a, b) => a[0] - b[0])));
} else if (process.argv[2] === '--native') {
  const versions = {};
  for (const relative of ['../apps/server/package.json', '../packages/shared/package.json']) {
    const url = new URL(relative, import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(url, 'utf8'));
    const require = createRequire(url);
    for (const name of Object.keys(selectCliRuntimeExternalDependencies(pkg.dependencies ?? {}))) {
      let directory = path.dirname(require.resolve(name));
      while (!fs.existsSync(path.join(directory, 'package.json'))) directory = path.dirname(directory);
      versions[name] = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
    }
  }
  console.log(JSON.stringify(versions));
} else {
  await Effect.runPromise(Effect.scoped(Layer.build(makeSqlitePersistenceLive(process.argv[2]))).pipe(Effect.provide(NodeServices.layer)));
}

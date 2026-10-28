// Exact existing Windows catalog semantics, using the retained reviewed
// safeStorage/DPAPI comparison. Secrets stay in memory and are never emitted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, digest, sha } from './core.mjs';
export const WINDOWS_CATALOG_POLICY = {
  originalCiphertextSha256: '1139b7d344671c6734563ee9dfd5de8aaa67f1b88a500050d51d0acc44919e0e',
  baseline: 'C:/Users/simon/t3-workflows/jobs/base-sessions-20261024/release/private/settings-snapshot/connection-catalog.json',
  baselineSha256: 'd726ba2109fb7182abb89d34b26bd32b477798736e72a3d7fc5725445124208c',
  functional: 'C:/Users/simon/.t3/runtime/t3w-deploy/allocation-custom44-myalien-20261024/catalog-current-functional-proof.json',
  functionalSha256: 'a99a5ffd24727257a4ced903611b82f0be4990ade4f58e8ad9e31512fc41e01b',
  durableFieldsSha256: '05ae4ad933fcba84a865d7a09717551b67d1ce71eaf7965764e69f6a67ebced8',
};
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const catalogFingerprint = v => digest(JSON.stringify(canonical(v)));
const durable = v => Object.fromEntries(['schemaVersion','targets','profiles','credentials','disabledEnvironmentIds'].map(k => [k,v[k]]));
export function compareCatalogDocuments(baseline, current) {
  const stable = doc => {
    const copy = structuredClone(doc);
    check(Array.isArray(copy.remoteDpopTokens) && copy.remoteDpopTokens.length === 1, 'catalog-acceptance', 'Unexpected token cache shape');
    const token = copy.remoteDpopTokens[0];
    check(typeof token.accessToken === 'string' && token.accessToken.length > 0 && Number.isSafeInteger(token.expiresAtEpochMs) && token.expiresAtEpochMs > 0, 'catalog-acceptance', 'Unexpected token cache fields');
    delete token.accessToken; delete token.expiresAtEpochMs;
    return copy;
  };
  check(catalogFingerprint(stable(baseline)) === catalogFingerprint(stable(current)), 'catalog-acceptance', 'Catalog differs beyond the two reviewed volatile token fields');
  const durableFieldsSha256 = catalogFingerprint(durable(current));
  check(durableFieldsSha256 === catalogFingerprint(durable(baseline)), 'catalog-acceptance', 'Durable catalog configuration differs');
  return { durableFieldsSha256, semanticSha256: catalogFingerprint(current), baselineSemanticSha256: catalogFingerprint(baseline), allowedVolatileFields: ['/remoteDpopTokens/0/accessToken','/remoteDpopTokens/0/expiresAtEpochMs'] };
}
export function readWindowsCatalogProof(baseDir, review, runCommand) {
  const p = WINDOWS_CATALOG_POLICY;
  check(review?.policySha256 === digest(JSON.stringify(p)), 'catalog-acceptance', 'Catalog policy differs');
  const canonicalFile = name => { check(fs.realpathSync(name) === path.resolve(name) && fs.lstatSync(name).isFile(), 'catalog-acceptance', 'Catalog evidence path differs'); return name; };
  check(sha(canonicalFile(p.baseline)) === p.baselineSha256 && sha(canonicalFile(p.functional)) === p.functionalSha256, 'catalog-acceptance', 'Retained catalog evidence differs');
  const functional = JSON.parse(fs.readFileSync(p.functional));
  check(functional.durableFieldsSha256 === p.durableFieldsSha256, 'catalog-acceptance', 'Reviewed durable catalog differs');
  const file = canonicalFile(path.join(baseDir,'userdata/connection-catalog.json')), raw = fs.readFileSync(file);
  check(digest(raw) === review.currentCiphertextSha256, 'catalog-acceptance', 'Current catalog changed after decision');
  const ps = `Add-Type -AssemblyName System.Security
$d = Get-Content -LiteralPath 'C:/Users/simon/AppData/Roaming/t3code/Local State' -Raw | ConvertFrom-Json
$b = [Convert]::FromBase64String($d.os_crypt.encrypted_key)
[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b[5..($b.Length-1)], $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  const key = Buffer.from(runCommand('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{timeout:10000}).trim(),'base64');
  try {
    const decrypt = bytes => {
      const envelope = JSON.parse(bytes), b = Buffer.from(envelope.encryptedCatalog,'base64');
      check(Object.keys(envelope).sort().join(',') === 'encryptedCatalog,version' && envelope.version === 1 && b.subarray(0,3).toString() === 'v10', 'catalog-acceptance', 'Unknown encrypted catalog envelope');
      const d = crypto.createDecipheriv('aes-256-gcm',key,b.subarray(3,15));d.setAuthTag(b.subarray(-16));
      return JSON.parse(Buffer.concat([d.update(b.subarray(15,-16)),d.final()]).toString());
    };
    const proof = compareCatalogDocuments(decrypt(fs.readFileSync(p.baseline)),decrypt(raw));
    check(proof.durableFieldsSha256 === p.durableFieldsSha256 && sha(file) === review.currentCiphertextSha256 && sha(p.baseline) === p.baselineSha256, 'catalog-acceptance', 'Catalog proof changed during comparison');
    return { verified:true, policySha256:review.policySha256, currentCiphertextSha256:review.currentCiphertextSha256, ...proof, historicalEquality:'unproven', retainedFunctionalProofSha256:p.functionalSha256, baselineCiphertextSha256:p.baselineSha256 };
  } finally { key.fill(0); }
}
export function validateWindowsCatalogReview(context, live, proof) {
  const p = WINDOWS_CATALOG_POLICY, d = context.decision, r = d.windowsCatalogReview, id = 'file:connection-catalog.json';
  check(r?.policySha256 === digest(JSON.stringify(p)) && proof?.verified === true && proof.policySha256 === r.policySha256 && proof.currentCiphertextSha256 === r.currentCiphertextSha256 && proof.durableFieldsSha256 === p.durableFieldsSha256 && proof.baselineCiphertextSha256 === p.baselineSha256 && proof.retainedFunctionalProofSha256 === p.functionalSha256 && proof.historicalEquality === 'unproven', 'catalog-acceptance', 'Missing current durable catalog proof');
  check([context.receipt.before,context.closed].every(s => new Map(s.routes).get(id) === p.originalCiphertextSha256) && new Map(live.snapshot.routes).get(id) === r.currentCiphertextSha256, 'catalog-acceptance', 'Catalog boundaries differ');
  const entry = d.reviewedCurrentFiles?.find(e => e.id === id);
  check(entry?.fromSha256 === p.originalCiphertextSha256 && entry.toSha256 === r.currentCiphertextSha256, 'catalog-acceptance', 'Catalog route review differs');
}

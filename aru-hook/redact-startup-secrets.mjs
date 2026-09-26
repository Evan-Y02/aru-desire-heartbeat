#!/usr/bin/env node
import {
  chmod, chown, lstat, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';

const file = process.argv[2];
if (!file) throw new Error('server path is required');
const original = await lstat(file);
if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1) {
  throw new Error('server path must be a regular non-symlink file');
}
let source = await readFile(file, 'utf8');

function replaceOnce(before, after, label, alreadySafe = null) {
  if (alreadySafe !== null && source.includes(alreadySafe)) return;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label} patch anchor is missing or ambiguous`);
  }
  source = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

replaceOnce(
  `  const pairingPayload = {
    schema: "aru.selfhost.pairing-envelope.v1",
    canonicalUrl: config.baseUrl,
    manifestUrl: manifestURL,
    serverId: state.serverId,
    pairingToken: state.pairing.token,
    installSessionLabel: "stub-boot",
  };
  const pairingURL =
    \`aru://pair?canonicalUrl=\${encodeURIComponent(config.baseUrl)}\` +
    \`&serverId=\${encodeURIComponent(state.serverId)}\` +
    \`&pairingToken=\${encodeURIComponent(state.pairing.token)}\` +
    \`&manifestUrl=\${encodeURIComponent(manifestURL)}\`;
`,
  '',
  'pairing secret construction',
  'startup logs never include credentials',
);
replaceOnce(
  `  console.log("Pairing payload (paste into Aru, or encode as QR). Single use,");
  console.log(\`expires in 10 minutes:\`);
  console.log("");
  console.log(JSON.stringify(pairingPayload, null, 2));
  console.log("");
  console.log(pairingURL);
  console.log("");
  console.log("No secrets are logged past this point.");
`,
  `  console.log("Pairing bootstrap is active; startup logs never include credentials.");
  console.log("Use the explicit owner-only pairing command when a new device is intended.");
`,
  'pairing secret logging',
  'startup logs never include credentials',
);
if (source.includes('pairingToken: state.pairing.token') ||
    source.includes('console.log(pairingURL)')) {
  throw new Error('pairing secret logging remains after hardening');
}
if (source.split('startup logs never include credentials').length !== 2) {
  throw new Error('startup credential redaction marker is not unique');
}

const temporary = `${file}.startup-redaction.tmp`;
try {
  await writeFile(temporary, source, { flag: 'wx', mode: original.mode & 0o7777 });
  const staged = await lstat(temporary);
  if (staged.uid !== original.uid || staged.gid !== original.gid) {
    await chown(temporary, original.uid, original.gid);
  }
  await chmod(temporary, original.mode & 0o7777);
  await rename(temporary, file);
} catch (error) {
  await unlink(temporary).catch(() => {});
  throw error;
}

#!/usr/bin/env node
import {
  chmod, chown, lstat, readFile, rename, unlink, writeFile,
} from 'node:fs/promises';

const file = process.argv[2];
const relayFile = process.argv[3];
if (!file || !relayFile) throw new Error('server and relay paths are required');
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

replaceOnce(
  'import { createWakeBridge } from "./wake-bridge.mjs";\n',
  'import { createWakeBridge } from "./wake-bridge.mjs";\n' +
    'import { createAruDesireTurnHook, wrapOnTurnSettled } from "./aru-desire-turn-hook.mjs";\n',
  'import',
  'import { createAruDesireTurnHook, wrapOnTurnSettled } from "./aru-desire-turn-hook.mjs";',
);
replaceOnce(
  'const conversationTurnRelay = createConversationTurnRelay({\n',
  'const desireTurnHook = createAruDesireTurnHook();\n' +
    'const conversationTurnRelay = createConversationTurnRelay({\n',
  'hook construction',
  'const desireTurnHook = createAruDesireTurnHook();',
);
// v0.9.8 constructed the hook later, before collaboratorHost. Move that
// existing construction to the shared point above both turn sources.
const lateConstruction = 'const desireTurnHook = createAruDesireTurnHook();\n' +
  'const collaboratorHost = createCollaboratorHost({\n';
if (source.includes(lateConstruction) &&
    source.indexOf('const desireTurnHook = createAruDesireTurnHook();') >
      source.indexOf('const conversationTurnRelay = createConversationTurnRelay({')) {
  source = source.replace(lateConstruction, 'const collaboratorHost = createCollaboratorHost({\n');
  source = source.replace(
    'const conversationTurnRelay = createConversationTurnRelay({\n',
    'const desireTurnHook = createAruDesireTurnHook();\n' +
      'const conversationTurnRelay = createConversationTurnRelay({\n',
  );
}
replaceOnce(
  '  onTurnSettled: (candidate) => conversationDesire.submit(candidate),\n',
  `  onTurnSettled: (candidate) => candidate?.outcome === "completed"
    ? desireTurnHook.deliver(candidate)
    : conversationDesire.submit(candidate),
`,
  'relay turn callback',
  'candidate?.outcome === "completed"',
);
replaceOnce(
  '  onTurnSettled: remotePush.deliverHostedCollaboratorTurn,\n',
  '  onTurnSettled: wrapOnTurnSettled(remotePush.deliverHostedCollaboratorTurn, desireTurnHook),\n',
  'turn callback',
  'onTurnSettled: wrapOnTurnSettled(remotePush.deliverHostedCollaboratorTurn, desireTurnHook)',
);
replaceOnce(
  '    deviceCount: state.devices.filter((d) => !d.revokedAt).length,\n',
  '    deviceCount: state.devices.filter((d) => !d.revokedAt).length,\n' +
    '    desireTurnHook: desireTurnHook.diagnostics(),\n',
  'diagnostics',
  'desireTurnHook: desireTurnHook.diagnostics()',
);
for (const marker of [
  'startup logs never include credentials',
  'import { createAruDesireTurnHook, wrapOnTurnSettled } from "./aru-desire-turn-hook.mjs";',
  'const desireTurnHook = createAruDesireTurnHook();',
  'candidate?.outcome === "completed"',
  'onTurnSettled: wrapOnTurnSettled(remotePush.deliverHostedCollaboratorTurn, desireTurnHook)',
  'desireTurnHook: desireTurnHook.diagnostics()',
]) {
  if (source.split(marker).length !== 2) throw new Error('patched Aru wiring is not unique');
}

const relayOriginal = await lstat(relayFile);
if (!relayOriginal.isFile() || relayOriginal.isSymbolicLink() || relayOriginal.nlink !== 1) {
  throw new Error('relay path must be a regular non-symlink file');
}
let relay = await readFile(relayFile, 'utf8');
function replaceRelayOnce(before, after, label, alreadySafe = null) {
  if (alreadySafe !== null && relay.includes(alreadySafe)) return;
  const first = relay.indexOf(before);
  if (first < 0 || relay.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label} relay patch anchor is missing or ambiguous`);
  }
  relay = `${relay.slice(0, first)}${after}${relay.slice(first + before.length)}`;
}
replaceRelayOnce(
  'import { buildStirCandidate } from "./conversation-desire-candidate.mjs";\n',
  'import { buildStirCandidate } from "./conversation-desire-candidate.mjs";\n' +
    'import { buildAruDesireRelayTurn } from "./aru-desire-relay-turn.mjs";\n',
  'relay import',
  'import { buildAruDesireRelayTurn } from "./aru-desire-relay-turn.mjs";',
);
replaceRelayOnce(
  '      let desireCandidate = null;\n',
  `      turn.completedAt = Date.now();
      const desireCompleteTurn = buildAruDesireRelayTurn({
        turn, providerBody: body, responseBody,
      });
      let desireCandidate = null;
`,
  'relay complete turn construction',
  'const desireCompleteTurn = buildAruDesireRelayTurn({',
);
replaceRelayOnce(
  '      if (desireCandidate?.kind === "stir") {\n        setImmediate(() => { void notifyTurnSettled(desireCandidate); });\n      }\n',
  `      if (desireCandidate?.kind === "stir") {
        setImmediate(() => { void notifyTurnSettled(desireCandidate); });
      }
      if (desireCompleteTurn) {
        setImmediate(() => { void notifyTurnSettled(desireCompleteTurn); });
      }
`,
  'relay callback',
  'void notifyTurnSettled(desireCompleteTurn)',
);
const relayTemporary = `${relayFile}.desire-hook.tmp`;
try {
  await writeFile(relayTemporary, relay, { flag: 'wx', mode: relayOriginal.mode & 0o7777 });
  const staged = await lstat(relayTemporary);
  if (staged.uid !== relayOriginal.uid || staged.gid !== relayOriginal.gid) {
    await chown(relayTemporary, relayOriginal.uid, relayOriginal.gid);
  }
  await chmod(relayTemporary, relayOriginal.mode & 0o7777);
  await rename(relayTemporary, relayFile);
} catch (error) {
  await unlink(relayTemporary).catch(() => {});
  throw error;
}

const temporary = `${file}.desire-hook.tmp`;
try {
  await writeFile(temporary, source, { flag: 'wx', mode: original.mode & 0o7777 });
  const staged = await lstat(temporary);
  if (staged.uid !== original.uid || staged.gid !== original.gid) {
    await chown(temporary, original.uid, original.gid);
  }
  // chmod must follow chown because chown may clear special mode bits. This
  // explicit restoration also makes the result independent of process umask.
  await chmod(temporary, original.mode & 0o7777);
  await rename(temporary, file);
} catch (error) {
  await unlink(temporary).catch(() => {});
  throw error;
}

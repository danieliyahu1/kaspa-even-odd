import test from 'node:test';
import assert from 'node:assert/strict';
import { KaspaChainAdapter } from '../src/chain-adapter.js';

test('requires an RPC client', () => {
  assert.throws(() => new KaspaChainAdapter({}), { code: 'RPC_UNAVAILABLE' });
});

test('prepareCreation rejects a request without a creator address', async () => {
  const adapter = new KaspaChainAdapter({ rpc: {}, covenantAddress: 'x', scriptPublicKey: 'y' });
  await assert.rejects(adapter.prepareCreation({ covenantScriptPublicKey: '00'.repeat(34) }), { code: 'INVALID_TRANSACTION' });
});

test('prepareCreation rejects a request without a covenant script', async () => {
  const adapter = new KaspaChainAdapter({ rpc: {}, covenantAddress: 'x', scriptPublicKey: 'y' });
  await assert.rejects(adapter.prepareCreation({ creatorAddress: 'kaspatest:a' }), { code: 'INVALID_TRANSACTION' });
});

test('prepareCreation surfaces an empty wallet as no ordinary UTXOs', async () => {
  const rpc = {
    getUtxosByAddresses: async () => ({ entries: [] }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
  };
  const adapter = new KaspaChainAdapter({ rpc, covenantAddress: 'x', scriptPublicKey: 'y' });
  await assert.rejects(
    adapter.prepareCreation({ creatorAddress: 'kaspatest:a', covenantScriptPublicKey: '00'.repeat(34), stakeSompi: 100_000_000n, feeSompi: 0n, network: 'testnet-10' }),
    { code: 'NO_UTXOS' },
  );
});

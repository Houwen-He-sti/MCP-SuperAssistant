// Smoke test: verify production executionGuard.ts module can be imported
// and exports match expected interface.
//
// This test uses a custom module loader to mock workspace-scoped dependencies
// (@extension/shared/lib/logger, ./storage) that aren't available in Node.js.
// Run with: node --import ./executionGuard.loader.mjs executionGuard.smoke.mjs

globalThis.window = { location: { href: 'https://chatgpt.com/c/test' } };
globalThis.document = { querySelectorAll: () => [], addEventListener: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

import('./executionGuard.ts').then(m => {
  console.log('Exports:', Object.keys(m));
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  
  // Verify expected exports exist
  assert(typeof m.executionGuardStore === 'object', 'executionGuardStore should be an object');
  assert(typeof m.canAutoExecute === 'function', 'canAutoExecute should be a function');
  assert(typeof m.reserveExecution === 'function', 'reserveExecution should be a function');
  assert(typeof m.isInLatestAssistantMessage === 'function', 'isInLatestAssistantMessage should be a function');
  
  // Verify store methods
  const store = m.executionGuardStore;
  assert(typeof store.computeKey === 'function', 'store.computeKey should be a function');
  assert(typeof store.has === 'function', 'store.has should be a function');
  assert(typeof store.reserve === 'function', 'store.reserve should be a function');
  assert(typeof store.markSucceeded === 'function', 'store.markSucceeded should be a function');
  assert(typeof store.markFailed === 'function', 'store.markFailed should be a function');
  assert(typeof store.clear === 'function', 'store.clear should be a function');
  
  // Verify basic functionality with real module
  const key = store.computeKey({ functionName: 'test_fn', callId: 'call_1', params: { a: 1 } });
  assert(typeof key === 'string', 'computeKey should return a string');
  assert(key.includes('test_fn'), 'key should contain functionName');
  assert(key.includes('call_1'), 'key should contain callId');
  
  // Verify reserve works
  assert(store.reserve(key) === true, 'first reserve should succeed');
  assert(store.reserve(key) === false, 'second reserve should fail (pending)');
  assert(store.has(key, ['pending']), 'key should be in pending state');
  
  // Verify reserveExecution function
  store.clear();
  const result = m.reserveExecution({ functionName: 'fn2', callId: 'c2', params: {} });
  assert(result !== null, 'reserveExecution should return key on success');
  const result2 = m.reserveExecution({ functionName: 'fn2', callId: 'c2', params: {} });
  assert(result2 === null, 'reserveExecution should return null when already reserved');
  
  console.log('✅ All production module smoke tests passed');
}).catch(e => {
  console.error('❌ Import failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});

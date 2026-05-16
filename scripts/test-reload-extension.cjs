#!/usr/bin/env node

const assert = require('assert');
const { findExtensionTarget } = require('./reload-extension.cjs');

const hkj = 'hkjclekhnaffnhldgpmjnohihjmblbpj';
const mcj = 'mcjlamohcooanphmebaiigheeeoplihb';

const targets = [
    {
        type: 'service_worker',
        url: `chrome-extension://${mcj}/service-worker-loader.js`,
        id: 'mcj-service-worker',
    },
    {
        type: 'service_worker',
        url: `chrome-extension://${hkj}/background.js`,
        id: 'hkj-service-worker',
    },
    {
        type: 'background_page',
        url: `chrome-extension://${hkj}/background.html`,
        id: 'hkj-background-page',
    },
];

assert.equal(
    findExtensionTarget(targets, [hkj, mcj]).id,
    'hkj-service-worker',
    'honors explicit candidate priority over CDP target order',
);

assert.equal(
    findExtensionTarget(targets, [mcj, hkj]).id,
    'mcj-service-worker',
    'still accepts legacy ID when it is explicitly first',
);

assert.equal(
    findExtensionTarget([
        { type: 'background_page', url: `chrome-extension://${hkj}/background.html`, id: 'hkj-background-page' },
    ], [hkj]).id,
    'hkj-background-page',
    'falls back to a non-service-worker target for the selected ID',
);

assert.equal(
    findExtensionTarget([
        { type: 'service_worker', url: 'chrome-extension://unknown/service-worker-loader.js', id: 'fallback-service-worker' },
    ], [hkj]).id,
    'fallback-service-worker',
    'keeps the generic service-worker-loader fallback',
);

console.log('reload extension tests passed');

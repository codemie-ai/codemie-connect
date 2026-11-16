import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRowStatus } from '../connections-status.js';

test('app not installed wins regardless of other signals', () => {
  assert.equal(computeRowStatus({ appInstalled: false, configPresent: true, daemonHealthy: true }), 'not-installed');
});

test('installed with no config file is not-set', () => {
  assert.equal(computeRowStatus({ appInstalled: true, configPresent: false, daemonHealthy: true }), 'not-set');
});

test('config present and daemon healthy is connected', () => {
  assert.equal(computeRowStatus({ appInstalled: true, configPresent: true, daemonHealthy: true }), 'connected');
});

test('config present but daemon unhealthy is disconnected', () => {
  assert.equal(computeRowStatus({ appInstalled: true, configPresent: true, daemonHealthy: false }), 'disconnected');
});

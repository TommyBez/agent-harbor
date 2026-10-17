import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceTotal } from './src/invoice.mjs';

test('sums invoice rows in cents', () => {
  assert.equal(invoiceTotal([{ quantity: 2, unitPrice: 12.5 }, { quantity: 3, unitPrice: 0.1 }]), 25.3);
});

test('applies the discount to the full invoice', () => {
  assert.equal(invoiceTotal([{ quantity: 3, unitPrice: 20 }], 10), 54);
});

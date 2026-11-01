import test from "node:test";
import assert from "node:assert/strict";
import {
  DB_NAME,
  GUEST_STORAGE_SCOPE,
  databaseNameForScope,
  getStorageScope,
  normalizeStorageScope,
  setStorageScope,
} from "../js/storage.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

test("guest keeps the exact legacy IndexedDB name", () => {
  assert.equal(databaseNameForScope(GUEST_STORAGE_SCOPE), DB_NAME);
  assert.equal(databaseNameForScope(), DB_NAME);
});

test("authenticated users receive deterministic isolated database names", () => {
  assert.equal(databaseNameForScope(USER_A), `${DB_NAME}-user-${USER_A}`);
  assert.equal(databaseNameForScope(`user:${USER_A.toUpperCase()}`), `${DB_NAME}-user-${USER_A}`);
  assert.notEqual(databaseNameForScope(USER_A), databaseNameForScope(USER_B));
});

test("active storage scope can switch without attributing guest data", () => {
  try {
    assert.equal(setStorageScope(USER_A), USER_A);
    assert.equal(getStorageScope(), USER_A);
    assert.equal(databaseNameForScope(), `${DB_NAME}-user-${USER_A}`);
    assert.equal(setStorageScope(), GUEST_STORAGE_SCOPE);
    assert.equal(databaseNameForScope(), DB_NAME);
  } finally {
    setStorageScope(GUEST_STORAGE_SCOPE);
  }
});

test("scope accepts only guest or UUID user identities", () => {
  assert.throws(() => normalizeStorageScope("someone@example.com"), /ідентифікатор/);
  assert.throws(() => normalizeStorageScope("../../../other"), /ідентифікатор/);
});

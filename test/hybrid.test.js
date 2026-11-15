// The sealing that keeps the login service from being able to read a refresh token afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { checkPublicKey, fromB64u, generateKeyPair, open, seal, toB64u } from "../src/hybrid.js";

const TOKEN = "refresh-token-" + "x".repeat(600);

test("base64url round trip and strict decoding", () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual([...fromB64u(toB64u(bytes))], [...bytes]);
  assert.ok(!/[+/=]/.test(toB64u(bytes)));
  assert.throws(() => fromB64u("a+b"), /not base64url/);
  assert.throws(() => fromB64u(42), /not base64url/);
});

test("sealed to a public key, only the matching private key opens it, for the same login only", async () => {
  const mine = await generateKeyPair(webcrypto);
  const other = await generateKeyPair(webcrypto);
  assert.ok(checkPublicKey(mine.publicKey));
  const sealed = await seal(mine.publicKey, TOKEN, "nonce-1", webcrypto);
  assert.equal(await open(mine.privateKey, sealed, "nonce-1", webcrypto), TOKEN, "a long token survives (more than RSA could carry)");
  assert.ok(!JSON.stringify(sealed).includes("refresh-token"), "the sealed text does not contain the token");
  await assert.rejects(open(other.privateKey, sealed, "nonce-1", webcrypto), /could not open/, "another computer's key cannot open it");
  await assert.rejects(open(mine.privateKey, sealed, "nonce-2", webcrypto), /could not open/, "bound to this login: a different nonce fails");
  await assert.rejects(open(mine.privateKey, { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith("AA") ? "BB" : "AA") }, "nonce-1", webcrypto), /could not open/, "changed data fails");
  await assert.rejects(open(mine.privateKey, { ...sealed, v: 2 }, "nonce-1", webcrypto), /unknown format/);
  const again = await seal(mine.publicKey, TOKEN, "nonce-1", webcrypto);
  assert.notEqual(again.ct, sealed.ct, "every sealing is different (fresh ephemeral key, salt and iv)");
  assert.notEqual(again.epk, sealed.epk);
});

test("only a real uncompressed P-256 public key is accepted", async () => {
  const k = await generateKeyPair(webcrypto);
  assert.equal(checkPublicKey(k.publicKey), true);
  for (const bad of ["", "AAAA", k.publicKey.slice(0, -4), toB64u(Uint8Array.from({ length: 65 }, () => 7)), "not base64!", undefined, 5]) assert.equal(checkPublicKey(bad), false, String(bad));
  await assert.rejects(seal("AAAA", "x", "n", webcrypto), /invalid public key/);
  const sealed = await seal(k.publicKey, "x", "n", webcrypto);
  await assert.rejects(open(k.privateKey, { ...sealed, epk: toB64u(new Uint8Array(65)) }, "n", webcrypto), /invalid key/);
});

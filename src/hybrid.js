// Sealing a secret so that only one computer can open it: ECDH (P-256) with an ephemeral key, HKDF-SHA256, AES-256-GCM.
// Pure Web Crypto with no Node imports, so the same file runs in the login service (a Cloudflare Worker) and on the user's
// computer. The login service seals a refresh token to the public key the user's computer made for this one login; after that
// nothing the service keeps can open it, and a copy of the sealed text is useless to anyone else.

const enc = new TextEncoder();
const dec = new TextDecoder();
const INFO = enc.encode("ads-mcp-for-snapchat sealed-token v1");

export const toB64u = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromB64u = (text) => {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const ECDH = { name: "ECDH", namedCurve: "P-256" };

// A public key as the 65 bytes of an uncompressed P-256 point, base64url (87 characters).
export const PUBLIC_KEY_LENGTH = 65;

export async function generateKeyPair(crypto = globalThis.crypto) {
  const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicKey: toB64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
}

export function checkPublicKey(text) {
  let raw;
  try {
    raw = fromB64u(text);
  } catch {
    return false;
  }
  return raw.length === PUBLIC_KEY_LENGTH && raw[0] === 4;
}

async function deriveKey(crypto, privateKey, peerPublicRaw, salt) {
  const peer = await crypto.subtle.importKey("raw", peerPublicRaw, ECDH, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// `aad` is extra text the sealed value is bound to (the login's nonce), so it cannot be replayed into another login.
export async function seal(publicKey, plaintext, aad, crypto = globalThis.crypto) {
  if (!checkPublicKey(publicKey)) throw new Error("invalid public key");
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(crypto, ephemeral.privateKey, fromB64u(publicKey), salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(String(aad)) }, key, enc.encode(plaintext)));
  return { v: 1, epk: toB64u(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))), salt: toB64u(salt), iv: toB64u(iv), ct: toB64u(ct) };
}

export async function open(privateKey, sealed, aad, crypto = globalThis.crypto) {
  if (!sealed || sealed.v !== 1) throw new Error("unknown format");
  const epk = fromB64u(sealed.epk);
  if (epk.length !== PUBLIC_KEY_LENGTH || epk[0] !== 4) throw new Error("invalid key");
  const key = await deriveKey(crypto, privateKey, epk, fromB64u(sealed.salt));
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(sealed.iv), additionalData: enc.encode(String(aad)) }, key, fromB64u(sealed.ct)));
  } catch {
    throw new Error("could not open the sealed value (wrong key, changed data, or a different login)");
  }
}

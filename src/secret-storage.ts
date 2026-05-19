// Lightweight obfuscation for passwords stored in data.json.
// XOR with a vault-id-derived key, base64 in/out. NOT cryptographic — see README.

const PREFIX = "sbj-enc-v1:";

function deriveKey(vaultKey: string): Uint8Array {
	let h0 = 0x811c9dc5;
	let h1 = 0xdeadbeef;
	for (let i = 0; i < vaultKey.length; i++) {
		h0 ^= vaultKey.charCodeAt(i);
		h0 = Math.imul(h0, 16777619) >>> 0;
		h1 ^= vaultKey.charCodeAt(i);
		h1 = Math.imul(h1, 2246822519) >>> 0;
	}
	const out = new Uint8Array(32);
	for (let i = 0; i < 32; i += 4) {
		const v = (h0 ^ Math.imul(h1 + i, 1597334677)) >>> 0;
		out[i] = (v >>> 24) & 0xff;
		out[i + 1] = (v >>> 16) & 0xff;
		out[i + 2] = (v >>> 8) & 0xff;
		out[i + 3] = v & 0xff;
		h0 = Math.imul(h0 ^ v, 374761393) >>> 0;
		h1 = Math.imul(h1 ^ v, 668265263) >>> 0;
	}
	return out;
}

function b64encode(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin);
}

function b64decode(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function encryptSecret(plain: string, vaultKey: string): string {
	if (!plain) return "";
	if (!vaultKey) return plain;
	const key = deriveKey(vaultKey);
	const data = new TextEncoder().encode(plain);
	const out = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ key[i % key.length]!;
	return PREFIX + b64encode(out);
}

export function decryptSecret(stored: string, vaultKey: string): string {
	if (!stored) return "";
	if (!stored.startsWith(PREFIX)) return stored;
	if (!vaultKey) return "";
	try {
		const data = b64decode(stored.slice(PREFIX.length));
		const key = deriveKey(vaultKey);
		const out = new Uint8Array(data.length);
		for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ key[i % key.length]!;
		return new TextDecoder().decode(out);
	} catch {
		return "";
	}
}

export function isEncrypted(stored: string): boolean {
	return typeof stored === "string" && stored.startsWith(PREFIX);
}

// A short name for a file's bytes, so that a write can be refused when the file is no
// longer what was read (the browser's page sends it to `naiad serve` and to the
// development file bridge; src-tauri/src/lib.rs computes the same).

/** FNV-1a, 64 bits, as 16 hex digits. Not for secrets: only to see that a file changed. */
export function fnv1a64(bytes: Uint8Array): string {
  // The 64-bit value in two 32-bit halves. The prime is 2^40 + 0x1b3, so a multiply is
  // the low half times 0x1b3 (exact in a double, under 2^41) plus the low half shifted
  // 40 bits, which lands in the high half as a shift of 8.
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    const low = lo * 0x1b3;
    hi = (hi * 0x1b3 + Math.floor(low / 0x100000000) + ((lo << 8) >>> 0)) >>> 0;
    lo = low >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

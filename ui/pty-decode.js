// Decodes base64 PTY chunks as streaming UTF-8 so a multi-byte character split
// across two chunks survives. One decoder per spawn.
export function createPtyDecoder() {
  const decoder = new TextDecoder('utf-8');
  return (b64) => decoder.decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)), { stream: true });
}

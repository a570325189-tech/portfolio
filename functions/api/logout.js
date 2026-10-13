import { json, clearCookie } from './_lib.js';

export async function onRequestPost() {
  return json({ ok: true }, { headers: { 'set-cookie': clearCookie() } });
}

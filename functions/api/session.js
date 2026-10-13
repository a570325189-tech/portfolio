import { json, isAuthed } from './_lib.js';

export async function onRequestGet(context) {
  return json({ authed: await isAuthed(context) });
}

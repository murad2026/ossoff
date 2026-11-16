// Cheap, non-AI signals that catch common troll and bot patterns.

export function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
export function refCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('');
}

export function signals(text) {
  const out = [];
  const links = (text.match(/https?:\/\/|www\./gi) || []).length;
  if (links > 1) out.push('link_spam');
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length > 30 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) out.push('shouting');
  if (/(.)\1{5,}/.test(text)) out.push('repeated_chars');
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length > 12 && new Set(words).size / words.length < 0.35) out.push('repetitive');
  return out;
}

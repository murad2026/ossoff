// Site settings — edit these, no other file needs changing.
window.SITE_CONFIG = {
  // URL of the deployed Cloudflare Worker, e.g. "https://draft-ossoff-api.yourname.workers.dev".
  // Leave empty to run in DEMO MODE (everything works locally in the browser, nothing is saved to a server).
  API_BASE: "",

  // Public address of this site (used in share links and on share cards).
  SITE_URL: "https://draftossoff.org/",

  // Who runs the site — shown in the footer disclaimer.
  ORG_NAME: "Draft Ossoff 2028 volunteers",
  CONTACT_EMAIL: "hello@example.com",

  // Home-page photo. Use ONLY a photo you have the rights to publish (your own shot, or one whose
  // license allows reuse — check the license and credit line). Put the file in site/img/ and set e.g.
  //   HERO_PHOTO: "img/ossoff.jpg", HERO_PHOTO_CREDIT: "Photo: Jane Doe / CC BY 4.0"
  // Empty = a star emblem is shown instead.
  HERO_PHOTO: "img/ossoff.jpg",
  HERO_PHOTO_CREDIT: "Photo: U.S. Senate Photographic Studio / Public domain",

  // Optional Cloudflare Turnstile captcha site key (pair with TURNSTILE_SECRET on the worker).
  TURNSTILE_SITEKEY: ""
};

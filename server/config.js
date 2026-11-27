// Optional deployment settings. They come from environment variables or from
// data/config.json (gitignored, like everything in data/), never from the
// repository: this file's values include secrets.
//
//   {
//     "publicUrl": "https://cams.example.com",
//     "google": { "clientId": "...", "clientSecret": "..." },
//     "resend": { "apiKey": "...", "from": "SecureCam <noreply@example.com>" },
//     "contactEmail": "privacy@example.com",
//     "allowSignup": true,
//     "restrictCameraHosts": true,
//     "maxCamerasPerUser": 4
//   }
import { readJson } from './store.js';

const file = readJson('config.json', {});
const env = process.env;

function flag(envValue, fileValue, fallback) {
  if (envValue === '1' || envValue === '0') return envValue === '1';
  return typeof fileValue === 'boolean' ? fileValue : fallback;
}

export const config = {
  // Where visitors reach the app. Used for links in emails and for the Google
  // sign-in return address. Without it the address of the request is used,
  // which is fine at home but should not be relied on in public.
  publicUrl: String(env.PUBLIC_URL || file.publicUrl || '').replace(/\/+$/, ''),
  googleClientId: env.GOOGLE_CLIENT_ID || file.google?.clientId || '',
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || file.google?.clientSecret || '',
  resendApiKey: env.RESEND_API_KEY || file.resend?.apiKey || '',
  mailFrom: env.MAIL_FROM || file.resend?.from || '',
  // Shown on the privacy page as the address for questions and requests.
  contactEmail: String(env.CONTACT_EMAIL || file.contactEmail || '').trim(),
  // Let anyone create an account. Each account only ever sees its own cameras.
  allowSignup: flag(env.ALLOW_SIGNUP, file.allowSignup, true),
  // Public deployments: accounts other than the admin may not point a camera at
  // this machine or its private network, or at files on its disk.
  restrictCameraHosts: flag(env.RESTRICT_CAMERA_HOSTS, file.restrictCameraHosts, false),
  // 0 = no limit. The admin is never limited.
  maxCamerasPerUser: Number(env.MAX_CAMERAS_PER_USER || file.maxCamerasPerUser || 0),
};

export const googleEnabled = Boolean(config.googleClientId && config.googleClientSecret);
// MAIL_LOG=1 prints emails to the server log instead of sending them (testing only).
export const mailLog = env.MAIL_LOG === '1';
export const mailEnabled = mailLog || Boolean(config.resendApiKey && config.mailFrom);

export function baseUrl(req) {
  return config.publicUrl || `${req.protocol}://${req.get('host')}`;
}

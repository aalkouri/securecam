// Shared by the sign-in pages: login, setup, signup, forgot and reset.
const form = document.getElementById('auth-form');
const errorEl = document.getElementById('error');
const noticeEl = document.getElementById('notice');
const mode = form.dataset.mode;
const show = (id) => document.getElementById(id)?.classList.remove('hidden');

const NOTICES = {
  badlink: 'That link has expired or was already used. Sign in, or use "Forgot password" for a new one.',
  google: 'Google sign-in did not complete. Please try again.',
  nosignup: 'New accounts are turned off on this server.',
};

function notice(text) {
  if (!noticeEl) return;
  noticeEl.textContent = text;
  noticeEl.classList.remove('hidden');
}

// Replace the form's fields with a message once there is nothing left to enter.
function finish(text) {
  for (const el of form.querySelectorAll('label, input, button, .hint, .google-btn, .auth-divider, p')) el.remove();
  notice(text);
}

(async () => {
  const info = await fetch('/api/setup').then((r) => r.json());
  if (mode !== 'setup' && !info.setupComplete) return location.replace('/setup.html');
  if (mode === 'setup' && info.setupComplete) return location.replace('/login.html');
  if (mode === 'signup' && !info.signup) return location.replace('/login.html?notice=nosignup');
  if (info.google && (mode === 'login' || mode === 'signup')) {
    show('google-btn');
    show('google-divider');
  }
  if (info.mail) {
    show('forgot-link');
    if (mode === 'signup') show('resend-btn');
  }
  if (info.signup) show('signup-link');
  if (mode === 'forgot' && !info.mail) finish('This server cannot send email, so passwords cannot be reset here.');
  const key = new URLSearchParams(location.search).get('notice');
  if (NOTICES[key]) notice(NOTICES[key]);
})();

const ROUTES = {
  login: '/api/login', setup: '/api/setup', signup: '/api/signup', forgot: '/api/forgot', reset: '/api/reset',
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const value = (name) => form.elements[name]?.value;
  if (form.elements.confirm && value('password') !== value('confirm')) {
    errorEl.textContent = 'Passwords do not match';
    return;
  }
  const body = {
    email: value('email')?.trim(),
    password: value('password'),
    building: value('building')?.trim(),
    // The reset link carries its one-time code after the "#", which browsers
    // never send to servers or leave in their logs.
    token: mode === 'reset' ? location.hash.slice(1) : undefined,
  };
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const res = await fetch(ROUTES[mode], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorEl.textContent = data.error || 'Something went wrong';
    } else if (mode === 'forgot') {
      finish('If that email has an account, a reset link is on its way. It works for 1 hour.');
    } else if (mode === 'setup' || (mode === 'signup' && !data.signedIn)) {
      finish('Check your email for a link to confirm your account. It works for 24 hours.');
    } else {
      location.replace('/');
    }
  } catch {
    errorEl.textContent = 'Could not reach the server';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('resend-btn')?.addEventListener('click', async () => {
  errorEl.textContent = '';
  const email = document.getElementById('email').value.trim();
  if (!email) {
    errorEl.textContent = 'Enter your email address first';
    return;
  }
  try {
    const res = await fetch('/api/resend-verification', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) errorEl.textContent = data.error || 'Could not send the email';
    else finish('If that address has an unconfirmed account, a new link is on its way.');
  } catch {
    errorEl.textContent = 'Could not reach the server';
  }
});

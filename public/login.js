// Shared by login.html and setup.html.
const form = document.getElementById('auth-form');
const errorEl = document.getElementById('error');
const mode = form.dataset.mode;

(async () => {
  const { setupComplete } = await fetch('/api/setup').then((r) => r.json());
  if (mode === 'login' && !setupComplete) location.replace('/setup.html');
  if (mode === 'setup' && setupComplete) location.replace('/login.html');
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const username = form.username.value.trim();
  const password = form.password.value;

  if (mode === 'setup' && password !== form.confirm.value) {
    errorEl.textContent = 'Passwords do not match';
    return;
  }

  const res = await fetch(mode === 'setup' ? '/api/setup' : '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.ok) {
    location.replace('/');
  } else {
    const body = await res.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Something went wrong';
  }
});

// Public home page: hide the sign-up buttons when this server has sign-up off.
fetch('/api/setup')
  .then((r) => r.json())
  .then((info) => {
    if (info.signup) return;
    for (const el of document.querySelectorAll('.needs-signup')) el.hidden = true;
  })
  .catch(() => { /* leave the page as it is */ });

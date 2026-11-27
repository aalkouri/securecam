// Public pages (home, privacy): adapt to this server's settings.
fetch('/api/setup')
  .then((r) => r.json())
  .then((info) => {
    // Hide the sign-up buttons when this server has sign-up off.
    if (!info.signup) {
      for (const el of document.querySelectorAll('.needs-signup')) el.hidden = true;
    }
    // The privacy page's contact address comes from the server's settings.
    const line = document.getElementById('contact-line');
    if (line && info.contact) {
      const link = document.createElement('a');
      link.href = `mailto:${info.contact}`;
      link.textContent = info.contact;
      line.textContent = 'For any question or request about your information, email ';
      line.append(link, '.');
    }
  })
  .catch(() => { /* leave the page as it is */ });

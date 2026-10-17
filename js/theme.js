/* Run in the head to apply the theme before the first paint. */
(() => {
  'use strict';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  function read() {
    try { preference = localStorage.getItem('theme') || 'system'; } catch (_) { preference = 'system'; }
    if (!['light', 'dark', 'system'].includes(preference)) preference = 'system';
  }
  function apply() {
    const dark = preference === 'dark' || preference === 'system' && system.matches;
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.getElementById('theme-color-meta')?.setAttribute('content', dark ? '#1f2937' : '#f3f4f6');
    const button = document.getElementById('theme-toggle');
    if (button) {
      const label = preference[0].toUpperCase() + preference.slice(1);
      button.textContent = `Theme: ${label}`;
      button.setAttribute('aria-label', `Theme: ${label}. Switch to ${preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system'} theme`);
    }
  }
  read(); apply();
  if (system.addEventListener) system.addEventListener('change', apply);
  else system.addListener(apply);
  window.addEventListener('storage', event => { if (event.key === 'theme' || event.key === null) { read(); apply(); } });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      preference = preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system';
      try { localStorage.setItem('theme', preference); } catch (_) { /* Private/restricted storage still supports this tab. */ }
      apply();
    });
  });
})();

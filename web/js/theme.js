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
      const icons = {
        system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
        light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
        dark: '<path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z"/>',
      };
      button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[preference]}</svg>`;
      button.title = `Theme: ${label}`;
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

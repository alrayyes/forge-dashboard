// Shared by every page's header (dashboard/insights/webhooks/settings/
// admin, plus the no-login-needed release history/disclaimer/privacy
// pages) — the same nav markup is duplicated as static HTML in each
// page (matching how footer.js already works), and this script is
// what makes it behave: highlighting whichever link matches the
// current page, showing who's signed in, revealing the Admin link for
// an admin session, and wiring sign-out. login.html doesn't include
// this — there's no session yet, and it isn't reached by the nav.
(() => {
  // release history/disclaimer/privacy set this so a visitor with no
  // session at all can still read them — the whole point of those
  // pages staying reachable without logging in. Every other page
  // leaves it unset, so the default is "yes, redirect," matching
  // app.js's own behavior before this moved out of it.
  var requiresAuth = document.body.dataset.pageRequiresAuth !== 'false';

  // ---- highlight the current page in the nav ----
  // ---- highlight the current page in the nav ----
  // aria-current="page" is the WAI-ARIA Authoring Practices way to mark
  // the current item in a nav (ARIA26), kept in sync with a
  // [aria-current="page"] CSS selector for the visual state — not just
  // a class, so a screen reader gets the same "you are here" signal a
  // sighted user does from the highlight.
  document.querySelectorAll('.app-nav a').forEach((a) => {
    if (a.pathname === window.location.pathname) {
      a.setAttribute('aria-current', 'page');
    } else {
      a.removeAttribute('aria-current');
    }
  });

  // ---- who's signed in, and signing out ----
  fetch('/api/auth/session', { headers: { Accept: 'application/json' } })
    .then((res) => {
      if (res.status === 401) {
        if (requiresAuth) window.location.href = '/login.html';
        return null;
      }
      return res.ok ? res.json() : null;
    })
    .then((session) => {
      if (!session) return;
      var whoami = document.getElementById('whoami');
      var adminLink = document.getElementById('admin-link');
      if (whoami) whoami.textContent = session.displayName;
      if (adminLink) adminLink.hidden = !session.isAdmin;
    })
    .catch(() => {
      /* a transient failure here isn't worth blocking the page over */
    });

  var logoutButton = document.getElementById('logout-button');
  if (logoutButton) {
    logoutButton.addEventListener('click', () => {
      fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
        window.location.href = '/login.html';
      });
    });
  }
})();

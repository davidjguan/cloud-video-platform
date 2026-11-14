// Cloud Video Platform front end (plain JavaScript, no framework or build step).
//
// Sign-up and sign-in call the Cognito API directly from the browser (no library needed).
// After sign-in, every API call sends the Cognito ID token in the Authorization header;
// API Gateway verifies it before the Lambda runs.
//
// Pages are picked by the part of the URL after "#":
//   #/                     home: themed rows + every video
//   #/watch/<video key>    watch page: player, comments, "Up next"
// so the browser's Back button works and a video can be linked to directly.

let config;            // loaded from config.json, written by CDK at deploy time
let session = null;    // { idToken, refreshToken, expiresAt, email }
let me = null;         // { user, isAdmin, name } from GET /api/me
let videos = [];       // every video, newest first (from GET /api/videos)
let current = null;    // the video in the player
let lastSaved = 0;
let playToken = 0;     // ignores slow responses when you switch videos quickly

const $ = (id) => document.getElementById(id);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // S3 enforces this too; checking here just fails faster

// ------------------------------------------------------------------ Cognito
async function cognito(action, payload) {
  const res = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify({ ClientId: config.userPoolClientId, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.__type || `Cognito ${action} failed`);
  return data;
}

const signUp = (email, password) =>
  cognito('SignUp', { Username: email, Password: password, UserAttributes: [{ Name: 'email', Value: email }] });
const confirmSignUp = (email, code) => cognito('ConfirmSignUp', { Username: email, ConfirmationCode: code });
const resendCode = (email) => cognito('ResendConfirmationCode', { Username: email });

async function signIn(email, password) {
  const data = await cognito('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  saveSession(data.AuthenticationResult, email);
}

async function refreshSession() {
  const data = await cognito('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    AuthParameters: { REFRESH_TOKEN: session.refreshToken },
  });
  saveSession({ ...data.AuthenticationResult, RefreshToken: session.refreshToken }, session.email);
}

function saveSession(result, email) {
  session = {
    idToken: result.IdToken,
    refreshToken: result.RefreshToken,
    expiresAt: Date.now() + result.ExpiresIn * 1000,
    email,
  };
  try { localStorage.setItem('session', JSON.stringify(session)); } catch {}
}

function clearSession() {
  session = null;
  try { localStorage.removeItem('session'); } catch {}
}

// ----------------------------------------------------------------- Our API
async function api(method, path, body) {
  if (!session) throw new Error('Not signed in');
  if (Date.now() > session.expiresAt - 60_000) await refreshSession();
  const res = await fetch(config.apiBase + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.idToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { signOut('Your session expired. Please sign in again.'); throw new Error('Unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

// --------------------------------------------------------------- Helpers
/** Builds an element: el('a', { href: '#', textContent: 'Hi' }, child1, child2) */
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

/** Small pop-up message at the bottom of the screen that disappears on its own. */
function toast(message, type = 'ok') {
  const t = el('div', { className: `toast ${type === 'error' ? 'error' : ''}`, textContent: message });
  $('toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3500);
}

function showView(id) {
  for (const v of ['signInView', 'signUpView', 'confirmView', 'homeView', 'watchView']) {
    $(v).classList.toggle('hidden', v !== id);
  }
  $('account').classList.toggle('hidden', id !== 'homeView' && id !== 'watchView');
}

/** Disables a form's buttons while `fn` runs, and shows any error as a toast. */
async function withBusy(form, fn) {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { buttons.forEach((b) => (b.disabled = false)); }
}

/** plural(1, 'view') -> "1 view", plural(1200, 'view') -> "1,200 views" */
function plural(n, word) {
  const count = n || 0;
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Unix seconds -> "just now", "5 minutes ago", "3 days ago", "2 months ago", ... */
function timeAgo(unix) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - unix));
  const steps = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, word] of steps) if (s >= size) return `${plural(Math.floor(s / size), word)} ago`;
  return 'just now';
}

/** "dave.guan" -> "DG", "dguan" -> "DG" (used for the avatar and comment authors) */
function initialsOf(name) {
  const parts = (name || '?').split(/[._\-+\s]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

const watchHref = (v) => `#/watch/${encodeURIComponent(v.key)}`;

/**
 * A styled "Are you sure?" window (replaces the browser's plain confirm box).
 * Resolves true if the person clicks the red button, false for Cancel or Esc.
 */
function confirmAction(title, text, yesLabel = 'Delete') {
  const d = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmYesBtn').textContent = yesLabel;
  return new Promise((resolve) => {
    const finish = (answer) => { d.close(); resolve(answer); };
    $('confirmYesBtn').onclick = () => finish(true);
    $('confirmNoBtn').onclick = () => finish(false);
    d.oncancel = () => resolve(false); // Esc key
    d.showModal();
  });
}

// --------------------------------------------------------------- Menus
// The user menu hangs off the avatar. Card "⋮" menus share one floating menu, positioned
// next to whichever button opened it (rows scroll sideways, which would clip a menu inside them).
const cardMenu = el('div', { className: 'menu floating hidden', role: 'menu' });
document.body.append(cardMenu);

function closeMenus() {
  $('userMenu').classList.add('hidden');
  $('avatarBtn').setAttribute('aria-expanded', 'false');
  cardMenu.classList.add('hidden');
}

$('avatarBtn').addEventListener('click', () => {
  const opening = $('userMenu').classList.contains('hidden');
  closeMenus();
  if (opening) {
    updateAdminStatus();
    $('userMenu').classList.remove('hidden');
    $('avatarBtn').setAttribute('aria-expanded', 'true');
  }
});

function showCardMenu(button, v) {
  const wasOpenHere = !cardMenu.classList.contains('hidden') && cardMenu.dataset.key === v.key;
  closeMenus();
  if (wasOpenHere) return; // second click on the same ⋮ closes it
  cardMenu.dataset.key = v.key;
  cardMenu.replaceChildren(el('button', {
    className: 'menu-item danger-text', role: 'menuitem', textContent: 'Delete video',
    onclick: () => { closeMenus(); removeVideo(v); },
  }));
  const r = button.getBoundingClientRect();
  cardMenu.style.top = `${r.bottom + 4}px`;
  cardMenu.style.left = `${Math.max(8, r.right - 180)}px`;
  cardMenu.classList.remove('hidden');
}

// Click anywhere else, press Esc, or scroll: close open menus.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu, #avatarBtn, .kebab')) closeMenus();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
window.addEventListener('scroll', () => cardMenu.classList.add('hidden'), true); // true = also row scrolling
window.addEventListener('resize', closeMenus);

// ---------------------------------------------------------- Auth screens
let pendingEmail = '';
let pendingPassword = ''; // kept in memory only, just long enough to sign in after confirming

// "Show"/"Hide" buttons inside password fields
document.querySelectorAll('.reveal').forEach((btn) => btn.addEventListener('click', () => {
  const input = btn.previousElementSibling;
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  btn.textContent = hidden ? 'Hide' : 'Show';
  btn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
}));

// Live checklist of the Cognito password rules (same rules as the user pool in the stack)
const passwordRules = {
  length: (p) => p.length >= 8,
  upper: (p) => /[A-Z]/.test(p),
  lower: (p) => /[a-z]/.test(p),
  digit: (p) => /\d/.test(p),
};
$('signUpForm').password.addEventListener('input', (e) => {
  for (const li of $('pwRules').children) li.classList.toggle('ok', passwordRules[li.dataset.rule](e.target.value));
});

$('signUpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    const failed = Object.values(passwordRules).some((rule) => !rule(f.password.value));
    if (failed) throw new Error('Your password doesn\'t meet every rule yet.');
    await signUp(f.email.value.trim(), f.password.value);
    pendingEmail = f.email.value.trim();
    pendingPassword = f.password.value;
    $('confirmEmail').textContent = pendingEmail;
    toast('Account created. Enter the code from your email.');
    showView('confirmView');
  });
});

$('confirmForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    await confirmSignUp(pendingEmail, f.code.value.trim());
    const pw = pendingPassword;
    pendingPassword = '';
    if (pw) { await signIn(pendingEmail, pw); await enterHome(); }
    else { toast('Email confirmed. Please sign in.'); showView('signInView'); }
  });
});

$('resendBtn').addEventListener('click', () =>
  withBusy($('confirmForm'), async () => { await resendCode(pendingEmail); toast('New code sent.'); }));

$('signInForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    try {
      await signIn(f.email.value.trim(), f.password.value);
    } catch (err) {
      if (/not confirmed/i.test(err.message)) {
        pendingEmail = f.email.value.trim();
        $('confirmEmail').textContent = pendingEmail;
        showView('confirmView');
        throw new Error('Please confirm your email first.');
      }
      throw err;
    }
    f.reset();
    await enterHome();
  });
});

document.querySelectorAll('[data-view]').forEach((a) =>
  a.addEventListener('click', (e) => { e.preventDefault(); showView(a.dataset.view); }));

$('signOutBtn').addEventListener('click', () => signOut());

function signOut(message) {
  stopPlayer();
  clearSession();
  closeMenus();
  me = null; videos = [];
  history.replaceState(null, '', location.pathname); // drop any #/watch/... from the address bar
  if (message) toast(message, 'error');
  showView('signInView');
}

// ------------------------------------------------------------------ Signed in
async function enterHome() {
  await refreshMe();
  if (me.isNew) toast('Welcome! Your profile was created.');
  $('avatarBtn').textContent = initialsOf(me.name);
  $('avatarBtn').title = session.email;
  $('who').textContent = session.email;
  $('adminBadge').classList.toggle('hidden', !me.isAdmin);
  $('adminTools').classList.toggle('hidden', !me.isAdmin);

  showView('homeView');
  renderSkeletons();
  await loadVideos();
  route(); // open the page the address bar asks for (e.g. a #/watch/ link)
}

async function refreshMe() {
  me = await api('GET', '/me');
}

async function loadVideos() {
  try {
    ({ videos } = await api('GET', '/videos'));
    renderAll();
  } catch (e) {
    $('rows').replaceChildren();
    $('videoGrid').replaceChildren(el('div', { className: 'empty' }, el('p', { textContent: 'Could not load videos: ' + e.message })));
  }
}

/** Re-draws everything that depends on the video list. */
function renderAll() {
  renderHome();
  if (current) { renderWatchInfo(); renderUpNext(); }
  updateAdminStatus();
}

// --------------------------------------------------------------- Routing
function route() {
  if (!me) return; // not signed in yet
  const match = location.hash.match(/^#\/watch\/(.+)$/);
  if (match) openWatch(decodeURIComponent(match[1]));
  else openHome();
}
window.addEventListener('hashchange', route);

function openHome() {
  stopPlayer();
  showView('homeView');
  renderHome();
  window.scrollTo(0, 0);
}

function openWatch(key) {
  const v = videos.find((x) => x.key === key);
  if (!v) {
    toast('That video doesn\'t exist anymore.', 'error');
    location.hash = '#/';
    return;
  }
  showView('watchView');
  window.scrollTo(0, 0);
  if (current?.key !== key) play(v);
}

// --------------------------------------------------------------- Home page
/** One video card: thumbnail, title, uploader, views, age, and a ⋮ menu if you can delete it. */
function videoCard(v) {
  const progress = me.user.progress?.[v.key];
  const watched = me.user.watched?.[v.key];

  const thumb = el('a', { className: 'thumb', href: watchHref(v), ariaLabel: v.title });
  if (v.thumbnailUrl) {
    thumb.append(el('img', { src: v.thumbnailUrl, alt: '', loading: 'lazy' }));
  } else {
    // Only fresh uploads say "Processing…"; failed and never-processed videos say "No preview".
    thumb.append(el('span', { className: 'pending', textContent: v.thumbnailStatus === 'processing' ? 'Processing…' : 'No preview' }));
  }
  if (v.durationSeconds) thumb.append(el('span', { className: 'dur', textContent: formatTime(v.durationSeconds) }));
  if (progress && v.durationSeconds) {
    const pct = Math.min(100, (progress / v.durationSeconds) * 100);
    thumb.append(el('div', { className: 'progress-bar' }, el('span', { style: `width:${pct}%` })));
  }

  const stats = el('div', { className: 'card-meta' }, `${plural(v.viewCount, 'view')} · ${timeAgo(v.uploadedAt)}`);
  if (watched) stats.append(' · ', el('span', { className: 'watched', textContent: '✓ watched' }));

  const text = el('div', { className: 'card-text' },
    el('a', { className: 'card-title', href: watchHref(v), textContent: v.title }),
    v.credit || v.uploader ? el('div', { className: 'card-meta', textContent: v.credit || v.uploader }) : null,
    stats);

  const body = el('div', { className: 'card-body' }, text);
  if (v.canDelete) {
    body.append(el('button', {
      className: 'kebab', textContent: '⋮', ariaLabel: `More options for ${v.title}`,
      onclick: (e) => showCardMenu(e.currentTarget, v),
    }));
  }
  return el('article', { className: 'card' }, thumb, body);
}

/** A titled horizontal strip of cards. Returns nothing when the list is empty. */
function row(title, list) {
  if (!list.length) return null;
  return el('section', {},
    el('h2', { textContent: title }),
    el('div', { className: 'row-strip' }, ...list.map(videoCard)));
}

function renderHome() {
  if (!me) return;
  const progress = me.user.progress || {};
  const likes = me.user.likes || {};

  if (!videos.length) {
    $('rows').replaceChildren();
    $('videoGrid').replaceChildren(el('div', { className: 'empty' },
      el('p', { textContent: 'No videos yet. Be the first to share one!' }),
      el('button', { textContent: 'Upload a video', onclick: openUpload })));
    return;
  }

  // Themed rows, all built from data we already have (no extra API calls)
  $('rows').replaceChildren(...[
    row('Continue watching', videos.filter((v) => progress[v.key])),
    row('Recently added', videos.slice(0, 10)), // the API returns newest first
    row('Most viewed', videos.filter((v) => v.viewCount > 0).sort((a, b) => b.viewCount - a.viewCount).slice(0, 10)),
    row('Your liked videos', videos.filter((v) => likes[v.key]).sort((a, b) => likes[b.key] - likes[a.key])),
  ].filter(Boolean));

  // Everything, A to Z (the rows above already cover "newest" and "most viewed")
  const all = [...videos].sort((a, b) => a.title.localeCompare(b.title));
  $('videoGrid').replaceChildren(...all.map(videoCard));
}

/** Grey placeholder cards while the video list loads. */
function renderSkeletons() {
  const skeleton = () => el('div', { className: 'card skeleton' },
    el('div', { className: 'thumb' }), el('div', { className: 'line' }), el('div', { className: 'line short' }));
  $('rows').replaceChildren();
  $('videoGrid').replaceChildren(...Array.from({ length: 8 }, skeleton));
}

// ------------------------------------------------------------- Watch page
async function play(v) {
  savePosition();
  const token = ++playToken;
  current = v;
  renderWatchInfo();
  renderUpNext();
  loadComments();
  try {
    const data = await api('POST', '/play', { key: v.key });
    if (token !== playToken) return; // you already switched to another video
    // First time this person plays it? The server counted a view, so bump our copy too.
    if (data.newView) v.viewCount = (v.viewCount || 0) + 1;
    const p = $('player');
    p.src = data.url;
    p.onloadedmetadata = () => { if (data.resumeAt) p.currentTime = data.resumeAt; p.play().catch(() => {}); };
    await refreshMe(); // picks up "watched" for this video
    renderWatchInfo();
  } catch (e) { toast('Could not play: ' + e.message, 'error'); }
}

/** Title, views/likes line, credit, description and the Like button. */
function renderWatchInfo() {
  const v = videos.find((x) => x.key === current.key) || current;
  const liked = !!me.user.likes?.[v.key];
  $('nowPlaying').textContent = v.title;
  $('watchMeta').textContent = [
    plural(v.viewCount, 'view'), plural(v.likeCount, 'like'), `uploaded ${timeAgo(v.uploadedAt)}`,
    v.uploader ? `by ${v.uploader}` : null,
  ].filter(Boolean).join(' · ');
  $('likeBtn').textContent = liked ? '👍 Liked' : '👍 Like';
  $('likeBtn').className = liked ? 'liked' : 'secondary';

  $('videoCredit').replaceChildren();
  if (v.credit || v.sourceUrl) {
    $('videoCredit').append(`Credit: ${v.credit || 'source'}`);
    if (v.sourceUrl) {
      $('videoCredit').append(' · ', el('a', { href: v.sourceUrl, target: '_blank', rel: 'noopener', textContent: 'original' }));
    }
  }
  $('videoDesc').textContent = v.description || '';
}

/** Side list: videos you haven't watched first, then the rest, newest first. */
function renderUpNext() {
  const watched = me.user.watched || {};
  const others = videos.filter((v) => v.key !== current.key);
  const ordered = [...others.filter((v) => !watched[v.key]), ...others.filter((v) => watched[v.key])].slice(0, 12);
  if (!ordered.length) { $('upNext').replaceChildren(el('p', { className: 'muted', textContent: 'No other videos yet.' })); return; }

  $('upNext').replaceChildren(...ordered.map((v) => {
    const thumb = el('div', { className: 'thumb' },
      v.thumbnailUrl ? el('img', { src: v.thumbnailUrl, alt: '', loading: 'lazy' }) : el('span', { className: 'pending', textContent: 'No preview' }),
      v.durationSeconds ? el('span', { className: 'dur', textContent: formatTime(v.durationSeconds) }) : null);
    return el('a', { className: 'compact', href: watchHref(v) }, thumb,
      el('div', {},
        el('div', { className: 'compact-title', textContent: v.title }),
        el('div', { className: 'card-meta', textContent: v.credit || v.uploader || '' }),
        el('div', { className: 'card-meta', textContent: `${plural(v.viewCount, 'view')} · ${timeAgo(v.uploadedAt)}` })));
  }));
}

/** Leaving the watch page: save your spot and stop the video. */
function stopPlayer() {
  if (!current) return;
  savePosition();
  playToken++;
  current = null;
  const p = $('player');
  p.pause();
  p.removeAttribute('src');
  p.load();
}

function savePosition(finished = false) {
  const p = $('player');
  if (!current || !session || (!p.currentTime && !finished)) return;
  lastSaved = Date.now();
  api('PUT', '/progress', { key: current.key, seconds: p.currentTime, finished })
    .then(() => refreshMe())
    .then(() => { if (!current) renderHome(); }) // back on the home page: update "Continue watching"
    .catch(() => {});
}
$('player').addEventListener('timeupdate', () => { if (Date.now() - lastSaved > 5000) savePosition(); });
$('player').addEventListener('pause', () => { if (!$('player').ended) savePosition(); });
$('player').addEventListener('ended', () => savePosition(true));

async function toggleLike(v) {
  try {
    const liked = !!me.user.likes?.[v.key];
    const r = await api('POST', '/likes', { key: v.key, like: !liked });
    const target = videos.find((x) => x.key === v.key);
    if (target) target.likeCount = r.likeCount;
    await refreshMe();
    renderWatchInfo();
  } catch (e) { toast('Could not like: ' + e.message, 'error'); }
}
$('likeBtn').addEventListener('click', () => current && toggleLike(current));

// -------------------------------------------------------------- Comments
async function loadComments() {
  const box = $('comments');
  const key = current.key;
  $('commentsHeading').textContent = 'Comments';
  box.replaceChildren(...Array.from({ length: 2 }, () =>
    el('div', { className: 'skeleton' }, el('div', { className: 'line' }), el('div', { className: 'line short' }))));
  try {
    const { comments } = await api('GET', `/comments?key=${encodeURIComponent(key)}`);
    if (current?.key !== key) return; // switched videos while loading
    $('commentsHeading').textContent = `Comments (${comments.length})`;
    if (!comments.length) {
      box.replaceChildren(el('p', { className: 'muted', textContent: 'No comments yet. Be the first!' }));
      return;
    }
    box.replaceChildren(...comments.map((c) => {
      const row = el('div', { className: 'comment' },
        el('div', { className: 'initials', textContent: initialsOf(c.author), ariaHidden: 'true' }),
        el('div', { className: 'body' },
          el('div', {}, el('span', { className: 'author', textContent: c.author }), el('span', { className: 'when', textContent: timeAgo(c.createdAt) })),
          el('div', { textContent: c.text })));
      if (c.canDelete) {
        row.append(el('button', {
          className: 'secondary',
          textContent: c.mine ? 'Delete' : 'Remove (admin)',
          onclick: () => removeComment(c),
        }));
      }
      return row;
    }));
  } catch (e) { box.replaceChildren(el('p', { className: 'muted', textContent: 'Could not load comments: ' + e.message })); }
}

$('commentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    await api('POST', '/comments', { key: current.key, text: f.text.value });
    f.reset();
    toast('Comment posted.');
    await loadComments();
  });
});

async function removeComment(c) {
  if (!(await confirmAction('Delete this comment?', 'This can\'t be undone.'))) return;
  try {
    await api('DELETE', '/comments', { key: current.key, commentId: c.commentId });
    toast('Comment deleted.');
    await loadComments();
  } catch (e) { toast('Could not delete: ' + e.message, 'error'); }
}

// ------------------------------------------------------------- Upload window
// Step 1: ask our API for a presigned S3 form. Step 2: send the file straight to S3.
let selectedFile = null;
let previewUrl = null;
let autoTitle = '';     // the title we filled in from the filename (so we don't overwrite yours)
let uploading = false;

function openUpload() {
  closeMenus();
  $('uploadForm').reset();
  chooseFile(null);
  $('uploadProgressWrap').classList.add('hidden');
  $('uploadDialog').showModal();
}
$('uploadOpenBtn').addEventListener('click', openUpload);

/** "beach-day_2024.mp4" -> "Beach day 2024" */
function titleFromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base.charAt(0).toUpperCase() + base.slice(1)).slice(0, 80);
}

/** Checks the file, then shows a preview and suggests a title. Pass null to clear. */
function chooseFile(file) {
  if (previewUrl) URL.revokeObjectURL(previewUrl); // free the memory used by the old preview
  previewUrl = null;
  selectedFile = null;
  $('uploadPreview').classList.add('hidden');
  $('previewPlayer').removeAttribute('src');
  if (!file) return;

  if (file.type !== 'video/mp4') { toast('Please choose an .mp4 video.', 'error'); return; }
  if (file.size > MAX_UPLOAD_BYTES) { toast(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 100 MB.`, 'error'); return; }

  selectedFile = file;
  previewUrl = URL.createObjectURL(file); // plays the file from your computer, nothing uploaded yet
  $('previewPlayer').src = previewUrl;
  $('fileInfo').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
  $('uploadPreview').classList.remove('hidden');

  const title = $('uploadForm').title;
  if (!title.value || title.value === autoTitle) { autoTitle = titleFromFilename(file.name); title.value = autoTitle; }
}

$('uploadForm').file.addEventListener('change', (e) => chooseFile(e.target.files[0]));

// Drag and drop onto the dashed box
const dropZone = $('dropZone');
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  chooseFile(e.dataTransfer.files[0]);
});

$('uploadCancelBtn').addEventListener('click', () => $('uploadDialog').close());
$('uploadDialog').addEventListener('cancel', (e) => { if (uploading) e.preventDefault(); }); // no Esc mid-upload
$('uploadDialog').addEventListener('close', () => { $('previewPlayer').pause(); });

$('uploadForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const file = selectedFile;
  if (!file) { toast('Choose a video first.', 'error'); return; }
  uploading = true;
  withBusy(f, async () => {
    const { upload } = await api('POST', '/uploads', {
      title: f.title.value, sizeBytes: file.size, contentType: file.type,
    });

    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
    form.append('file', file); // must be last

    const bar = $('uploadProgress');
    const mb = (bytes) => (bytes / 1048576).toFixed(1);
    $('uploadProgressWrap').classList.remove('hidden');
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); // XHR (not fetch) so we can show upload progress
      xhr.open('POST', upload.url);
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round((ev.loaded / ev.total) * 100);
        bar.value = pct;
        $('uploadProgressText').textContent = `${pct}% · ${mb(ev.loaded)} of ${mb(ev.total)} MB`;
      };
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`S3 rejected the upload (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
      xhr.send(form);
    });

    uploading = false;
    $('uploadDialog').close();
    toast('Uploaded! Making a thumbnail in the background…');
    location.hash = '#/'; // your video appears at the front of "Recently added"
    await loadVideos();
    refreshUntilThumbnails();
  }).finally(() => { uploading = false; });
});

// ---------------------------------------------------------- Delete a video
async function removeVideo(v) {
  const ok = await confirmAction(`Delete "${v.title}"?`, 'This also removes its thumbnail and comments. It can\'t be undone.');
  if (!ok) return;
  try {
    await api('DELETE', '/videos', { key: v.key });
    if (current?.key === v.key) location.hash = '#/';
    toast('Video deleted.');
    await loadVideos();
  } catch (e) { toast('Could not delete: ' + e.message, 'error'); }
}

// ---------------------------------------------------------- Account window
$('accountOpenBtn').addEventListener('click', () => {
  closeMenus();
  const u = me.user;
  const count = (map) => Object.keys(map || {}).length;
  const stat = (n, label) => el('div', { className: 'stat' }, el('b', { textContent: n.toLocaleString() }), el('span', { textContent: label }));
  $('accountEmail').textContent = `${session.email} · member since ${new Date(u.createdAt * 1000).toLocaleDateString()}`;
  $('accountStats').replaceChildren(
    stat(count(u.watched), 'videos watched'),
    stat(count(u.likes), 'videos liked'),
    stat(count(u.progress), 'in progress'),
    stat(videos.filter((v) => v.uploader === me.name).length, 'uploaded'),
  );
  $('accountDialog').showModal();
});
$('accountCloseBtn').addEventListener('click', () => $('accountDialog').close());

// Your whole DynamoDB record as a .json file (made in the browser; nothing extra is sent anywhere)
$('downloadDataBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(me.user, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: 'my-cloud-video-data.json' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------------------------------------------------- Admin: thumbnails
function updateAdminStatus() {
  if (!me?.isAdmin) return;
  const missing = videos.filter((v) => !v.thumbnailUrl).length;
  $('thumbStatus').textContent = missing ? `${plural(missing, 'video')} without a thumbnail` : 'Every video has a thumbnail ✓';
  $('backfillBtn').disabled = missing === 0;
}

// After an upload or a backfill, re-check every 5 s until every video has a thumbnail
// (gives up after 3 minutes).
let thumbTimer = null;
function refreshUntilThumbnails(deadline = Date.now() + 3 * 60_000) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(async () => {
    if (!session) return;
    await loadVideos();
    const missing = videos.filter((v) => !v.thumbnailUrl).length;
    if (missing && Date.now() < deadline) refreshUntilThumbnails(deadline);
  }, 5000);
}

$('backfillBtn').addEventListener('click', async () => {
  closeMenus();
  try {
    await api('POST', '/admin/thumbnails', {});
    toast('Making missing thumbnails. They\'ll appear over the next minute or two.');
    refreshUntilThumbnails();
  } catch (e) { toast('Could not start: ' + e.message, 'error'); }
});

// ------------------------------------------------------------------- Start
(async function init() {
  try {
    config = await (await fetch('config.json', { cache: 'no-store' })).json();
  } catch {
    toast('Could not load config.json. Has the stack been deployed?', 'error');
    return;
  }
  try { session = JSON.parse(localStorage.getItem('session')); } catch { session = null; }
  if (session?.refreshToken) {
    try { await enterHome(); return; } catch { clearSession(); }
  }
  showView('signInView');
})();

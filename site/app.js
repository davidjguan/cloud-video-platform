// Cloud Video Platform front end.
//
// Sign-up and sign-in call the Cognito API directly from the browser (no library needed).
// After sign-in, every API call sends the Cognito ID token in the Authorization header;
// API Gateway verifies it before the Lambda runs.

let config;            // loaded from config.json, written by CDK at deploy time
let session = null;    // { idToken, refreshToken, expiresAt, email }
let me = null;         // { user, isAdmin, name } from GET /api/me
let videos = [];
let current = null;    // the video in the player
let lastSaved = 0;

const $ = (id) => document.getElementById(id);

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
function show(msg, ok = false) { $('msg').textContent = msg || ''; $('msg').className = ok ? 'ok' : ''; }

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function showView(id) {
  for (const v of ['signInView', 'signUpView', 'confirmView', 'homeView']) $(v).classList.toggle('hidden', v !== id);
  $('account').classList.toggle('hidden', id !== 'homeView');
}

async function withBusy(form, fn) {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try { await fn(); } catch (e) { show(e.message); } finally { buttons.forEach((b) => (b.disabled = false)); }
}

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const timeAgo = (unix) => {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - unix));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// ---------------------------------------------------------- Auth screens
let pendingEmail = '';
let pendingPassword = ''; // kept in memory only, just long enough to sign in after confirming

$('signUpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    await signUp(f.email.value.trim(), f.password.value);
    pendingEmail = f.email.value.trim();
    pendingPassword = f.password.value;
    $('confirmEmail').textContent = pendingEmail;
    show('Account created. Enter the code from your email.', true);
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
    else { show('Email confirmed. Please sign in.', true); showView('signInView'); }
  });
});

$('resendBtn').addEventListener('click', () =>
  withBusy($('confirmForm'), async () => { await resendCode(pendingEmail); show('New code sent.', true); }));

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
    await enterHome();
  });
});

document.querySelectorAll('[data-view]').forEach((a) =>
  a.addEventListener('click', (e) => { e.preventDefault(); show(''); showView(a.dataset.view); }));

$('signOutBtn').addEventListener('click', () => signOut());

function signOut(message) {
  savePosition();
  clearSession();
  me = null; current = null; videos = [];
  const p = $('player'); p.pause(); p.removeAttribute('src');
  $('playerPanel').classList.add('hidden');
  show(message || '');
  showView('signInView');
}

// ------------------------------------------------------------------ Home
async function enterHome() {
  await refreshMe();
  show(me.isNew ? 'Welcome! Your profile was created.' : '', true);
  $('who').textContent = session.email;
  $('adminBadge').classList.toggle('hidden', !me.isAdmin);
  $('adminTools').classList.toggle('hidden', !me.isAdmin);
  showView('homeView');
  await loadVideos();
}

async function refreshMe() {
  me = await api('GET', '/me');
  $('userData').textContent = JSON.stringify(me.user, null, 2);
}

async function loadVideos() {
  try {
    ({ videos } = await api('GET', '/videos'));
    renderVideos();
  } catch (e) { $('videoList').textContent = 'Could not load videos: ' + e.message; }
}

function videoRow(v) {
  const watched = me.user.watched?.[v.key];
  const resume = me.user.progress?.[v.key];
  const liked = !!me.user.likes?.[v.key];

  const thumb = el('div', { className: 'thumb' });
  if (!v.thumbnailUrl) {
    // Only fresh uploads say "Processing…"; failed and never-processed videos say "No preview".
    const label = v.thumbnailStatus === 'processing' ? 'Processing…' : 'No preview';
    thumb.append(el('span', { className: 'pending', textContent: label }));
  }
  if (v.thumbnailUrl) thumb.append(el('img', { src: v.thumbnailUrl, alt: '', loading: 'lazy' }));
  if (v.durationSeconds) thumb.append(el('span', { className: 'dur', textContent: formatTime(v.durationSeconds) }));
  thumb.onclick = () => play(v);

  const info = el('div', { className: 'info' },
    el('div', {}, v.title,
      watched ? el('span', { className: 'badge', textContent: '✓ watched' }) : null,
      resume ? el('span', { className: 'badge', textContent: `resume at ${formatTime(resume)}` }) : null),
    el('div', {
      className: 'meta',
      textContent: [v.credit ? `Credit: ${v.credit}` : v.uploader ? `by ${v.uploader}` : null, plural(v.viewCount, 'view'), `${v.sizeMB} MB`, `👍 ${v.likeCount}`]
        .filter(Boolean).join(' · '),
    }));

  const buttons = el('div', { className: 'buttons' });
  buttons.append(el('button', { className: `small ${liked ? 'liked' : 'secondary'}`, textContent: liked ? '👍 Liked' : '👍', onclick: () => toggleLike(v) }));
  if (v.canDelete) buttons.append(el('button', { className: 'small secondary', textContent: 'Delete', onclick: () => removeVideo(v) }));
  buttons.append(el('button', { className: 'small', textContent: resume ? 'Resume' : 'Play', onclick: () => play(v) }));

  return el('div', { className: 'video' }, el('div', { className: 'left' }, thumb, info), buttons);
}

function renderVideos() {
  const list = $('videoList');
  list.innerHTML = '';
  if (!videos.length) list.textContent = 'No videos yet. Upload one below!';
  for (const v of videos) list.append(videoRow(v));

  // Continue Watching: videos you've started but not finished
  const inProgress = videos.filter((v) => me.user.progress?.[v.key]);
  $('continueSection').classList.toggle('hidden', !inProgress.length);
  $('continueList').innerHTML = '';
  for (const v of inProgress) $('continueList').append(videoRow(v));

  if (current) renderLike();
}

// ------------------------------------------------------------- Playback
async function play(v) {
  savePosition();
  try {
    const data = await api('POST', '/play', { key: v.key });
    // First time this person plays it? The server counted a view, so bump our copy too.
    if (data.newView) v.viewCount = (v.viewCount || 0) + 1;
    current = v;
    const p = $('player');
    p.src = data.url;
    p.onloadedmetadata = () => { if (data.resumeAt) p.currentTime = data.resumeAt; p.play().catch(() => {}); };
    $('nowPlaying').textContent = v.title;
    $('videoDesc').textContent = v.description || '';
    $('videoCredit').innerHTML = '';
    if (v.sourceUrl) {
      $('videoCredit').append(`Credit: ${v.credit || 'source'} · `,
        el('a', { href: v.sourceUrl, target: '_blank', rel: 'noopener', textContent: 'original' }));
    }
    $('playerPanel').classList.remove('hidden');
    $('playerPanel').scrollIntoView({ behavior: 'smooth' });
    renderLike();
    loadComments();
    await refreshMe();
    renderVideos();
  } catch (e) { show('Could not play: ' + e.message); }
}

function savePosition(finished = false) {
  const p = $('player');
  if (!current || !session || (!p.currentTime && !finished)) return;
  lastSaved = Date.now();
  api('PUT', '/progress', { key: current.key, seconds: p.currentTime, finished })
    .then(() => (finished ? refreshMe().then(renderVideos) : null))
    .catch(() => {});
}
$('player').addEventListener('timeupdate', () => { if (Date.now() - lastSaved > 5000) savePosition(); });
$('player').addEventListener('pause', () => { if (!$('player').ended) savePosition(); });
$('player').addEventListener('ended', () => savePosition(true));

// ----------------------------------------------------------------- Likes
/** plural(1, 'view') -> "1 view", plural(1200, 'view') -> "1,200 views" */
function plural(n, word) {
  const count = n || 0;
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

function renderLike() {
  const v = videos.find((x) => x.key === current.key) || current;
  const liked = !!me.user.likes?.[current.key];
  $('likeBtn').textContent = liked ? '👍 Liked' : '👍 Like';
  $('likeBtn').className = liked ? 'liked' : 'secondary';
  $('likeCount').textContent = `${plural(v.viewCount, 'view')} · ${plural(v.likeCount, 'like')}`;
}

async function toggleLike(v) {
  try {
    const liked = !!me.user.likes?.[v.key];
    const r = await api('POST', '/likes', { key: v.key, like: !liked });
    const target = videos.find((x) => x.key === v.key);
    if (target) target.likeCount = r.likeCount;
    await refreshMe();
    renderVideos();
  } catch (e) { show('Could not like: ' + e.message); }
}
$('likeBtn').addEventListener('click', () => current && toggleLike(current));

// -------------------------------------------------------------- Comments
async function loadComments() {
  const box = $('comments');
  box.textContent = 'Loading…';
  try {
    const { comments } = await api('GET', `/comments?key=${encodeURIComponent(current.key)}`);
    box.innerHTML = '';
    if (!comments.length) box.textContent = 'No comments yet. Be the first!';
    for (const c of comments) {
      const text = el('div', {},
        el('span', { className: 'author', textContent: c.author }),
        c.text,
        el('span', { className: 'when', textContent: timeAgo(c.createdAt) }));
      const row = el('div', { className: 'comment' }, text);
      if (c.canDelete) {
        row.append(el('button', {
          className: 'small secondary',
          textContent: c.mine ? 'Delete' : 'Remove (admin)',
          onclick: () => removeComment(c),
        }));
      }
      box.append(row);
    }
  } catch (e) { box.textContent = 'Could not load comments: ' + e.message; }
}

$('commentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    await api('POST', '/comments', { key: current.key, text: f.text.value });
    f.reset();
    await loadComments();
  });
});

async function removeComment(c) {
  if (!confirm('Delete this comment?')) return;
  try { await api('DELETE', '/comments', { key: current.key, commentId: c.commentId }); await loadComments(); }
  catch (e) { show('Could not delete: ' + e.message); }
}

// ------------------------------------------------- Uploads & video delete
// Step 1: ask our API for a presigned S3 form. Step 2: send the file straight to S3.
$('uploadForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const file = f.file.files[0];
  if (!file) return;
  withBusy(f, async () => {
    if (file.type !== 'video/mp4') throw new Error('Please choose an .mp4 file');
    if (file.size > 100 * 1024 * 1024) throw new Error('Videos must be 100 MB or smaller');

    const { upload } = await api('POST', '/uploads', {
      title: f.title.value, sizeBytes: file.size, contentType: file.type,
    });

    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
    form.append('file', file); // must be last

    const bar = $('uploadProgress');
    bar.classList.remove('hidden');
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); // XHR (not fetch) so we can show upload progress
      xhr.open('POST', upload.url);
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) bar.value = (ev.loaded / ev.total) * 100; };
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`S3 rejected the upload (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(form);
    });
    bar.classList.add('hidden');
    bar.value = 0;
    f.reset();
    show('Uploaded! Making a thumbnail in the background…', true);
    await loadVideos();
    refreshUntilThumbnails();
  });
});

async function removeVideo(v) {
  if (!confirm(`Delete "${v.title}"? This also removes its comments.`)) return;
  try {
    await api('DELETE', '/videos', { key: v.key });
    if (current?.key === v.key) {
      current = null;
      $('player').pause();
      $('playerPanel').classList.add('hidden');
    }
    show('Video deleted.', true);
    await loadVideos();
  } catch (e) { show('Could not delete: ' + e.message); }
}

// ------------------------------------------------------------------- Start
(async function init() {
  try {
    config = await (await fetch('config.json', { cache: 'no-store' })).json();
  } catch {
    show('Could not load config.json. Has the stack been deployed?');
    return;
  }
  try { session = JSON.parse(localStorage.getItem('session')); } catch { session = null; }
  if (session?.refreshToken) {
    try { await enterHome(); return; } catch { clearSession(); }
  }
  showView('signInView');
})();

// --------------------------------------------- Thumbnails (made in the background)
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
  const btn = $('backfillBtn');
  btn.disabled = true;
  try {
    await api('POST', '/admin/thumbnails', {});
    show('Making thumbnails for videos that don\'t have one. They\'ll appear over the next minute or two.', true);
    refreshUntilThumbnails();
  } catch (e) { show('Could not start: ' + e.message); }
  finally { btn.disabled = false; }
});

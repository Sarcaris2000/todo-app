// Uploading backups to Google Drive.
//
// Uses the `drive.file` scope, which is the narrow one: the app can only see
// and touch files it created itself. It cannot read the rest of your Drive,
// and a leaked token cannot either. The broader `drive` scope would be easier
// to work with and is not worth it.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const BACKUP_FOLDER = 'To Do App Backups';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function isConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

/**
 * Trade the long-lived refresh token for a short-lived access token.
 *
 * Refresh tokens do not expire on their own, but Google revokes them if the
 * OAuth app stays in "testing" rather than "published" - which is the usual
 * reason a backup that worked for a week silently stops.
 */
async function accessToken(env) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${response.status}`;
    throw new Error(`Google refused the refresh token: ${detail}`);
  }
  return data.access_token;
}

/** The backup folder, created on first use. */
async function ensureFolder(env, token) {
  const query = encodeURIComponent(
    `name='${BACKUP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );

  const found = await fetch(`${DRIVE_API}/files?q=${query}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json()).catch(() => ({}));

  if (found.files?.length) return found.files[0].id;

  const created = await fetch(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BACKUP_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  }).then((r) => r.json());

  if (!created.id) throw new Error('Could not create the backup folder');
  return created.id;
}

/** Multipart upload: metadata and body in one request. */
async function uploadFile(token, folderId, filename, content) {
  const boundary = `b${crypto.randomUUID().replace(/-/g, '')}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify({ name: filename, parents: [folderId] }),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const response = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,size`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    throw new Error(`Upload failed: ${data.error?.message || `HTTP ${response.status}`}`);
  }
  return data;
}

/**
 * Delete all but the most recent `keep` backups *of one kind*.
 *
 * Scoped by filename prefix, because the folder holds two different series:
 * the weekly `todo-backup-` files, and the `pre-restore-` snapshots taken
 * before a restore destroys anything. Pruning them together meant that doing
 * a few restores in an afternoon would silently evict months of weekly
 * backups - the retention limit quietly working against the thing it exists
 * to protect.
 *
 * Only files this app created are visible under the drive.file scope, so
 * nothing outside its own folder can be caught by this.
 */
async function prune(env, token, folderId, keep, prefix) {
  const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const list = await fetch(
    `${DRIVE_API}/files?q=${query}&orderBy=createdTime desc&fields=files(id,name,createdTime)&pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json()).catch(() => ({}));

  const files = (list.files ?? []).filter((f) => String(f.name).startsWith(prefix));
  const surplus = files.slice(keep);

  let deleted = 0;
  for (const file of surplus) {
    const res = await fetch(`${DRIVE_API}/files/${file.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok || res.status === 204) deleted++;
  }

  return { total: files.length, deleted };
}

/** Push one backup up, and tidy old ones. */
export async function backupToDrive(env, filename, content, { keep = 12, prefix } = {}) {
  if (!isConfigured(env)) {
    return { ok: false, reason: 'Google Drive is not connected' };
  }

  try {
    const token = await accessToken(env);
    const folderId = await ensureFolder(env, token);
    const file = await uploadFile(token, folderId, filename, content);
    // Default the series to the filename minus its date, so a caller cannot
    // forget the prefix and have one series prune another.
    const series = prefix ?? filename.replace(/-\d{4}-\d{2}-\d{2}\.json$/, '');
    const pruned = await prune(env, token, folderId, keep, series);

    return {
      ok: true,
      file: file.name,
      bytes: Number(file.size) || content.length,
      kept: Math.min(pruned.total, keep),
      removed: pruned.deleted,
      at: new Date().toISOString(),
    };
  } catch (error) {
    return { ok: false, reason: String(error.message || error).slice(0, 200) };
  }
}

/**
 * Mapping from yt-dlp's `--dump-single-json` output onto our media record.
 *
 * Only the fields the data model already has: a public reel's description gives
 * us the caption without an OCR pass.
 */

export interface YtDlpInfo {
  id?: string;
  title?: string;
  description?: string;
  /** Epoch seconds. */
  timestamp?: number;
  /** YYYYMMDD, present when `timestamp` is not. */
  upload_date?: string;
  duration?: number;
  uploader?: string;
  uploader_id?: string;
  webpage_url?: string;
  ext?: string;
  filesize?: number;
  filesize_approx?: number;
  is_live?: boolean;
  availability?: string;
}

export interface MediaFields {
  caption_raw?: string;
  caption_normalized?: string;
  taken_at?: string;
  duration_ms?: number;
  uploader?: string;
}

/** Zero-width characters Instagram captions are littered with. */
const INVISIBLE = new RegExp('[\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g');

/**
 * Keeps the caption's meaning and its hashtags, drops the noise: invisible
 * characters, CRLF, trailing spaces and runs of blank lines.
 */
export function normalizeCaption(caption: string): string {
  return caption
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function takenAtFrom(info: YtDlpInfo): string | undefined {
  if (typeof info.timestamp === 'number' && Number.isFinite(info.timestamp)) {
    return new Date(info.timestamp * 1000).toISOString();
  }
  const date = info.upload_date;
  if (date && /^\d{8}$/.test(date)) {
    return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00.000Z`).toISOString();
  }
  return undefined;
}

export function toMediaFields(info: YtDlpInfo): MediaFields {
  // Instagram has no separate title: yt-dlp synthesises one from the caption,
  // so it is only worth using when there is no description at all.
  const caption = info.description?.trim() || undefined;
  const normalized = caption ? normalizeCaption(caption) : undefined;
  return {
    caption_raw: caption,
    caption_normalized: normalized,
    taken_at: takenAtFrom(info),
    duration_ms:
      typeof info.duration === 'number' && Number.isFinite(info.duration)
        ? Math.round(info.duration * 1000)
        : undefined,
    uploader: info.uploader ?? info.uploader_id,
  };
}

/** Phrases Instagram serves instead of media when it wants a logged-in session. */
const LOGIN_WALL = [
  'login required',
  'requested content is not available',
  'rate-limit reached',
  'sign in to confirm',
  'you need to log in',
  'private account',
  // What Instagram actually returned to the Lambda: a 200 with no media. It
  // means the same thing, and no number of retries will change it.
  'empty media response',
  'without being logged-in',
  'use --cookies',
];

/**
 * Turns a yt-dlp stderr dump into something the Library can show, and says
 * plainly when the cause is a login wall rather than a broken link.
 */
/**
 * What an image post or carousel looks like to yt-dlp. Distinct from a login
 * wall: reporting it as one sent the reader after cookies for a problem that
 * has nothing to do with authentication.
 */
const NO_VIDEO = ['no video formats found', 'no video could be found', 'unsupported url'];

export function explainDownloadFailure(stderr: string): {
  message: string;
  loginWalled: boolean;
  noVideo: boolean;
} {
  const haystack = stderr.toLowerCase();
  const noVideo = NO_VIDEO.some((phrase) => haystack.includes(phrase));
  const loginWalled = !noVideo && LOGIN_WALL.some((phrase) => haystack.includes(phrase));
  // Our subprocess wrapper prefixes "yt-dlp exited N: ", so ERROR: sits mid-line.
  const errorLine = stderr.split('\n').find((line) => line.includes('ERROR:'));
  const firstError = errorLine
    ? errorLine.slice(errorLine.indexOf('ERROR:')).trim()
    : (stderr.trim().split('\n').slice(-1)[0] ?? 'download failed');
  if (noVideo) {
    return {
      message:
        'This link has no video in it, which is what an image post or a carousel looks like. ' +
        'Upload its images instead, or connect the account if it is yours.',
      loginWalled: false,
      noVideo: true,
    };
  }
  return {
    message: loginWalled
      ? `Instagram would not serve this reel without a logged-in session: ${firstError}`
      : firstError,
    loginWalled,
    noVideo: false,
  };
}

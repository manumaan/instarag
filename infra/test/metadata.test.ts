import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  explainDownloadFailure,
  normalizeCaption,
  takenAtFrom,
  toMediaFields,
} from '../extract/src/metadata';

const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const LINE_SEP = String.fromCharCode(0x2028);

test('normalizeCaption strips invisible characters but keeps hashtags', () => {
  const caption = `Sunset at the${ZWSP} pier${BOM}   \r\n\r\n\r\nBest light${LINE_SEP} all week   \n#sunset #pier`;
  const normalized = normalizeCaption(caption);
  assert.equal(normalized, 'Sunset at the pier\n\nBest light all week\n#sunset #pier');
  const invisible = new RegExp(`[${ZWSP}${BOM}${LINE_SEP}]`);
  assert.ok(!invisible.test(normalized), 'invisible characters survived');
  assert.match(normalized, /#sunset #pier/);
});

test('normalizeCaption leaves an ordinary caption alone', () => {
  assert.equal(normalizeCaption('One line only'), 'One line only');
  assert.equal(normalizeCaption('  padded  '), 'padded');
});

test('takenAtFrom prefers the timestamp and falls back to upload_date', () => {
  assert.equal(takenAtFrom({ timestamp: 1789000000 }), new Date(1789000000000).toISOString());
  assert.equal(takenAtFrom({ upload_date: '20260921' }), '2026-09-21T00:00:00.000Z');
  assert.equal(takenAtFrom({ upload_date: 'not-a-date' }), undefined);
  assert.equal(takenAtFrom({}), undefined);
});

test('toMediaFields maps a reel payload onto the data model', () => {
  const fields = toMediaFields({
    id: 'Cx1y2z3AbCd',
    description: `Look at this${ZWSP} view\n\n\n#travel`,
    timestamp: 1789000000,
    duration: 8.04,
    uploader: 'someaccount',
    ext: 'mp4',
  });
  assert.equal(fields.caption_raw, `Look at this${ZWSP} view\n\n\n#travel`);
  assert.equal(fields.caption_normalized, 'Look at this view\n\n#travel');
  assert.equal(fields.duration_ms, 8040);
  assert.equal(fields.uploader, 'someaccount');
  assert.equal(fields.taken_at, new Date(1789000000000).toISOString());
});

test('toMediaFields leaves a captionless reel without a caption', () => {
  const fields = toMediaFields({ description: '   ', uploader_id: '12345' });
  assert.equal(fields.caption_raw, undefined);
  assert.equal(fields.caption_normalized, undefined);
  assert.equal(fields.uploader, '12345');
});

test('explainDownloadFailure names a login wall as such', () => {
  const walled = explainDownloadFailure(
    'yt-dlp exited 1: ERROR: [Instagram] Cx1y: Requested content is not available, rate-limit reached or login required',
  );
  assert.equal(walled.loginWalled, true);
  assert.match(walled.message, /would not serve this reel without a logged-in session/);

  const missing = explainDownloadFailure('yt-dlp exited 1: ERROR: [Instagram] Cx1y: Post not found');
  assert.equal(missing.loginWalled, false);
  assert.equal(missing.message, 'ERROR: [Instagram] Cx1y: Post not found');

  const noise = explainDownloadFailure('something odd happened');
  assert.equal(noise.loginWalled, false);
  assert.equal(noise.message, 'something odd happened');
});

test('an empty media response is treated as a wall, not a retryable fault', () => {
  const observed = explainDownloadFailure(
    'yt-dlp exited 1: ERROR: [Instagram] Zz9: Instagram sent an empty media response. ' +
      'Check if this post is accessible in your browser without being logged-in.',
  );
  assert.equal(observed.loginWalled, true, 'must not be retried');
  assert.match(observed.message, /would not serve this reel without a logged-in session/);
});

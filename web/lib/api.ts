'use client';

import { fetchAuthSession } from 'aws-amplify/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export type MediaStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'downloading'
  | 'extracting'
  | 'analysing'
  | 'transcribing'
  | 'indexing'
  | 'ready'
  | 'failed';

export interface Media {
  id: string;
  source: 'api' | 'upload' | 'url';
  type: 'reel' | 'post' | 'carousel';
  status: MediaStatus;
  created_at: string;
  s3_key?: string;
  content_type?: string;
  bytes?: number;
  original_filename?: string;
  permalink?: string;
  caption_raw?: string;
  caption_normalized?: string;
  taken_at?: string;
  uploader?: string;
  analysis_summary?: string;
  places?: Place[];
  /** Speech, transcribed from the reel's audio. */
  transcript?: string;
  transcript_segment_count?: number;
  spoken_language?: string;
  /** 'frames' when the caption was read off the video rather than supplied. */
  caption_source?: string;
  error?: string;
}

export interface Frame {
  media_id: string;
  ts_ms: number;
  url?: string;
  kind?: 'cover' | 'scene' | 'sample';
  description?: string;
  ocr_text?: string;
}

export interface PlaceEvidence {
  ts_ms: number;
  text: string;
  kind: 'signage' | 'menu' | 'street_sign' | 'on_screen_caption' | 'other';
}

export interface Place {
  name: string;
  kind: string;
  /** read_from_frame is grounded in legible text; inferred is the model reasoning. */
  basis: 'read_from_frame' | 'from_caption' | 'inferred';
  evidence: PlaceEvidence[];
}

export interface TranscriptSegment {
  media_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface MediaDetail {
  media: Media;
  frames: Frame[];
  transcriptSegments: TranscriptSegment[];
  playbackUrl?: string;
}

/** The HTTP API's JWT authorizer is scoped to the user pool client, so it wants the id token. */
async function authHeader(): Promise<Record<string, string>> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('not signed in');
  return { authorization: token };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new Error('NEXT_PUBLIC_API_URL is not set — run scripts/write-web-env.sh');
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(await authHeader()) },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const listMedia = (cursor?: string) =>
  call<{ items: Media[]; cursor?: string }>(`/media${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);

export const getMedia = (id: string) => call<MediaDetail>(`/media/${id}`);

export const deleteMedia = (id: string) => call<{ deleted: string }>(`/media/${id}`, { method: 'DELETE' });

export const addFromUrl = (url: string) =>
  call<{ mediaId: string; media: Media }>('/media/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });

export interface Citation {
  media_id: string;
  ts_ms: number;
}

export interface AskAnswer {
  threadId: string | null;
  /** false when the indexed frames did not support an answer. */
  answered: boolean;
  answer: string;
  citations: Citation[];
  retrieved?: Citation[];
}

export interface ThreadMessage {
  thread_id: string;
  created_at: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
}

export interface Thread {
  id: string;
  scope: 'media' | 'library';
  media_id?: string;
  title: string;
  created_at: string;
}

/** Ask a question, optionally scoped to one reel. */
export const ask = (question: string, options: { mediaId?: string; threadId?: string } = {}) =>
  call<AskAnswer>('/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, mediaId: options.mediaId, threadId: options.threadId }),
  });

export const listThreads = () => call<{ items: Thread[] }>('/threads');

export const getThread = (id: string) =>
  call<{ threadId: string; messages: ThreadMessage[] }>(`/threads/${id}`);

/**
 * Three steps: reserve the id, PUT the bytes straight to S3 with the presigned
 * URL, then tell the API the object landed so it can queue the pipeline.
 */
export async function uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<Media> {
  // The presigned URL signs this exact string, so both calls must agree on it.
  const contentType = file.type.toLowerCase();

  const { mediaId, uploadUrl } = await call<{ mediaId: string; uploadUrl: string }>('/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: file.name, contentType, bytes: file.size }),
  });

  await putWithProgress(uploadUrl, file, contentType, onProgress);

  return call<Media>(`/media/${mediaId}/complete`, { method: 'POST' });
}

/** XHR rather than fetch, purely because fetch gives no upload progress. */
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(file);
  });
}

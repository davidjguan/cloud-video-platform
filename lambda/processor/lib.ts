/** Pure helpers for the video processor (no AWS calls), so they're easy to unit test. */

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
}

/** Pulls duration and resolution out of `ffprobe -print_format json` output. */
export function parseProbe(json: string): ProbeResult {
  const data = JSON.parse(json) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };
  const video = (data.streams ?? []).find((s) => s.codec_type === 'video');
  if (!video) throw new Error('No video stream found');
  const duration = Number(data.format?.duration ?? video.duration ?? 0);
  return {
    durationSeconds: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
  };
}

/** Grab the thumbnail 10% of the way in (past fade-ins), at least 1 s and at most 30 s. */
export function pickSeekSeconds(durationSeconds: number): number {
  if (!durationSeconds || durationSeconds < 2) return 0;
  return Math.min(30, Math.max(1, Math.round(durationSeconds * 0.1 * 10) / 10));
}

/** "videos/beach-day-abc.mp4" -> "thumbnails/beach-day-abc.jpg" */
export function thumbnailKeyFor(videoKey: string): string {
  return videoKey.replace(/^videos\//, 'thumbnails/').replace(/\.mp4$/i, '.jpg');
}

/** S3 event keys can arrive URL-encoded (spaces as "+"). */
export function decodeS3Key(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

export function isVideoKey(key: string): boolean {
  return /^videos\/[^/]+\.mp4$/i.test(key);
}

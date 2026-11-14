import {
  isValidVideoKey, titleFromKey, parseBody, toSeconds, HttpError, json,
  slugify, requireText, parseGroups, displayName, newCommentId, chunk, thumbnailStatus,
} from '../lambda/api/lib';

describe('isValidVideoKey', () => {
  it('accepts mp4 files inside videos/', () => {
    expect(isValidVideoKey('videos/ocean-waves.mp4')).toBe(true);
    expect(isValidVideoKey('videos/16821231_3840_2160_50fps.mp4')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isValidVideoKey('site/index.html')).toBe(false);
    expect(isValidVideoKey('videos/../secret.mp4')).toBe(false);
    expect(isValidVideoKey('videos/sub/dir.mp4')).toBe(false);
    expect(isValidVideoKey('videos/clip.mov')).toBe(false);
    expect(isValidVideoKey(42)).toBe(false);
    expect(isValidVideoKey(undefined)).toBe(false);
  });
});

describe('titleFromKey / slugify', () => {
  it('turns file names into titles', () => {
    expect(titleFromKey('videos/ocean-waves.mp4')).toBe('Ocean Waves');
    expect(titleFromKey('videos/city_at__night.MP4')).toBe('City At Night');
  });
  it('makes S3-safe slugs', () => {
    expect(slugify('My Beach Trip!')).toBe('my-beach-trip');
    expect(slugify('***')).toBe('video');
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });
});

describe('parseBody', () => {
  it('parses JSON and base64 JSON', () => {
    expect(parseBody('{"key":"a"}')).toEqual({ key: 'a' });
    expect(parseBody(Buffer.from('{"x":1}').toString('base64'), true)).toEqual({ x: 1 });
    expect(parseBody(undefined)).toEqual({});
  });
  it('rejects bad bodies with a 400', () => {
    expect(() => parseBody('not json')).toThrow(HttpError);
    expect(() => parseBody('[1,2]')).toThrow(HttpError);
  });
});

describe('requireText', () => {
  it('trims and collapses whitespace', () => {
    expect(requireText('  hi   there ', 'text', 50)).toBe('hi there');
  });
  it('rejects empty, missing or too long', () => {
    expect(() => requireText('   ', 'text', 50)).toThrow(HttpError);
    expect(() => requireText(undefined, 'text', 50)).toThrow(HttpError);
    expect(() => requireText('abcdef', 'text', 5)).toThrow(HttpError);
  });
});

describe('toSeconds', () => {
  it('floors and clamps', () => {
    expect(toSeconds(12.9)).toBe(12);
    expect(toSeconds('30')).toBe(30);
    expect(toSeconds(10 ** 9)).toBe(86400);
  });
  it('rejects negatives and junk', () => {
    expect(() => toSeconds(-1)).toThrow(HttpError);
    expect(() => toSeconds('abc')).toThrow(HttpError);
  });
});

describe('parseGroups', () => {
  it('handles the formats Cognito groups can arrive in', () => {
    expect(parseGroups('[admins]')).toEqual(['admins']);
    expect(parseGroups('[admins editors]')).toEqual(['admins', 'editors']);
    expect(parseGroups(['admins'])).toEqual(['admins']);
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups('[notadmins]')).not.toContain('admins');
  });
});

describe('misc helpers', () => {
  it('displayName uses the part before the @', () => {
    expect(displayName('dave@example.com')).toBe('dave');
  });
  it('comment ids sort by time', () => {
    expect(newCommentId(1000) < newCommentId(2000)).toBe(true);
  });
  it('chunk splits arrays', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('json builds an API Gateway response', () => {
    const r = json(200, { ok: true });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });
});

describe('thumbnailStatus', () => {
  it('says what the site should show in the thumbnail spot', () => {
    expect(thumbnailStatus({ thumbnailKey: 'thumbnails/a.jpg', status: 'ready' })).toBe('ready');
    expect(thumbnailStatus({ thumbnailKey: 'thumbnails/a.jpg', status: 'failed' })).toBe('ready'); // old image still good
    expect(thumbnailStatus({ status: 'processing' })).toBe('processing');
    expect(thumbnailStatus({ status: 'failed' })).toBe('failed');
    expect(thumbnailStatus({})).toBe('missing');       // older video, never processed
    expect(thumbnailStatus(undefined)).toBe('missing'); // video with no metadata row
  });
});

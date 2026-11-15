import { countViewers } from '../scripts/backfill-views';

describe('countViewers', () => {
  test('counts each user once per video they watched', () => {
    const counts = countViewers([
      { watched: { 'videos/a.mp4': 1, 'videos/b.mp4': 2 } },
      { watched: { 'videos/a.mp4': 3 } },
      { watched: {} },
      {}, // a user record created before the watched map existed
    ]);
    expect(counts.get('videos/a.mp4')).toBe(2);
    expect(counts.get('videos/b.mp4')).toBe(1);
    expect(counts.size).toBe(2);
  });
});

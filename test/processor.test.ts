/**
 * Processor tests: pure helpers, plus what happens when ffmpeg fails (AWS calls are mocked).
 */
process.env.VIDEOS_BUCKET = 'videos-bucket';
process.env.VIDEOS_TABLE = 'Videos';
process.env.FFPROBE_PATH = '/does/not/exist/ffprobe'; // makes processing fail on purpose
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'test';               // fake keys so presigning works offline
process.env.AWS_SECRET_ACCESS_KEY = 'test';

import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { processVideo } from '../lambda/processor/index';
import { parseProbe, pickSeekSeconds, thumbnailKeyFor, decodeS3Key, isVideoKey } from '../lambda/processor/lib';

describe('parseProbe', () => {
  it('reads duration and resolution from ffprobe output', () => {
    const json = JSON.stringify({
      format: { duration: '12.345' },
      streams: [{ codec_type: 'audio' }, { codec_type: 'video', width: 1920, height: 1080 }],
    });
    expect(parseProbe(json)).toEqual({ durationSeconds: 12.3, width: 1920, height: 1080 });
  });
  it('fails clearly when there is no video stream', () => {
    expect(() => parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio' }] }))).toThrow('No video stream');
  });
});

describe('pickSeekSeconds', () => {
  it('grabs 10% in, between 1 and 30 seconds', () => {
    expect(pickSeekSeconds(0)).toBe(0);
    expect(pickSeekSeconds(1.5)).toBe(0);
    expect(pickSeekSeconds(5)).toBe(1);
    expect(pickSeekSeconds(60)).toBe(6);
    expect(pickSeekSeconds(3600)).toBe(30);
  });
});

describe('keys', () => {
  it('maps a video to its thumbnail', () => {
    expect(thumbnailKeyFor('videos/beach-day-abc.mp4')).toBe('thumbnails/beach-day-abc.jpg');
  });
  it('decodes URL-encoded S3 event keys', () => {
    expect(decodeS3Key('videos/my+clip%281%29.mp4')).toBe('videos/my clip(1).mp4');
    expect(decodeS3Key('videos/plain.mp4')).toBe('videos/plain.mp4');
  });
  it('only processes .mp4 files directly in videos/', () => {
    expect(isVideoKey('videos/a.mp4')).toBe(true);
    expect(isVideoKey('thumbnails/a.jpg')).toBe(false);
    expect(isVideoKey('videos/sub/a.mp4')).toBe(false);
  });
});

describe('processVideo when ffmpeg fails', () => {
  const s3Mock = mockClient(S3Client);
  const ddbMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
    s3Mock.on(HeadObjectCommand).resolves({});  // the video exists
    ddbMock.on(GetCommand).resolves({});         // and has no thumbnail yet
  });

  it('marks the video as failed (so the site stops saying "Processing…") and re-throws', async () => {
    await expect(processVideo('videos/broken.mp4')).rejects.toThrow();

    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0].input).toMatchObject({
      Key: { videoKey: 'videos/broken.mp4' },
      ExpressionAttributeValues: expect.objectContaining({ ':failed': 'failed' }),
    });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0); // no thumbnail written
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageEmbedType } from '@discord2/shared';
import { EmbedsService } from './embeds.service';

describe('EmbedsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a safe youtube-nocookie embed', async () => {
    const service = new EmbedsService();

    await expect(
      service.createEmbeds('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).resolves.toEqual([
      expect.objectContaining({
        type: MessageEmbedType.YouTube,
        provider: 'YouTube',
        embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      }),
    ]);
  });

  it('creates image embeds from remote image links', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', {
        headers: {
          'content-type': 'image/gif',
        },
      }),
    );
    const service = new EmbedsService();

    await expect(service.createEmbeds('https://cdn.example.test/fun.gif')).resolves.toEqual([
      expect.objectContaining({
        type: MessageEmbedType.Image,
        thumbnailUrl: 'https://cdn.example.test/fun.gif',
      }),
    ]);
  });

  it('extracts open graph metadata for standard links', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '<html><head><meta property="og:title" content="Article"><meta property="og:description" content="Summary"><meta property="og:image" content="/cover.png"></head></html>',
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
          },
        },
      ),
    );
    const service = new EmbedsService();

    await expect(service.createEmbeds('https://example.test/post')).resolves.toEqual([
      expect.objectContaining({
        type: MessageEmbedType.Link,
        title: 'Article',
        description: 'Summary',
        thumbnailUrl: 'https://example.test/cover.png',
      }),
    ]);
  });
});

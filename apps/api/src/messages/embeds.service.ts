import { Injectable } from '@nestjs/common';
import { MessageEmbedType } from '@discord2/shared';
import type { InsertEmbedInput } from '@discord2/db';
import { Buffer } from 'node:buffer';

const MAX_EMBEDS_PER_MESSAGE = 4;
const FETCH_TIMEOUT_MS = 2500;
const MAX_HTML_BYTES = 256 * 1024;
const IMAGE_MIME_PREFIX = 'image/';
const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;

@Injectable()
export class EmbedsService {
  async createEmbeds(content: string | null): Promise<InsertEmbedInput[]> {
    const urls = extractUrls(content).slice(0, MAX_EMBEDS_PER_MESSAGE);
    const embeds: InsertEmbedInput[] = [];

    for (const url of urls) {
      const youtube = createYouTubeEmbed(url);
      if (youtube) {
        embeds.push(youtube);
        continue;
      }

      const embed = await this.createRemoteEmbed(url);
      if (embed) {
        embeds.push(embed);
      }
    }

    return embeds;
  }

  private async createRemoteEmbed(url: string): Promise<InsertEmbedInput | null> {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, { method: 'GET' });
    } catch {
      return createFallbackLinkEmbed(url);
    }

    const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
    if (contentType.startsWith(IMAGE_MIME_PREFIX)) {
      return {
        type: MessageEmbedType.Image,
        url,
        title: fileNameFromUrl(url),
        thumbnailUrl: url,
        provider: new URL(url).hostname,
      };
    }

    if (!contentType.includes('text/html')) {
      return createFallbackLinkEmbed(url);
    }

    const html = await readLimitedText(response);
    if (!html) {
      return createFallbackLinkEmbed(url);
    }

    const linkEmbed: InsertEmbedInput = {
      type: MessageEmbedType.Link,
      url,
    };
    const title = firstMetaContent(html, ['og:title', 'twitter:title']) ?? titleFromHtml(html);
    const description = firstMetaContent(html, [
      'og:description',
      'description',
      'twitter:description',
    ]);
    const thumbnailUrl = absolutizeUrl(firstMetaContent(html, ['og:image', 'twitter:image']), url);
    const provider = firstMetaContent(html, ['og:site_name']) ?? new URL(url).hostname;

    if (title) linkEmbed.title = title;
    if (description) linkEmbed.description = description;
    if (thumbnailUrl) linkEmbed.thumbnailUrl = thumbnailUrl;
    if (provider) linkEmbed.provider = provider;

    return linkEmbed;
  }
}

function extractUrls(content: string | null): string[] {
  if (!content) {
    return [];
  }

  return Array.from(new Set(content.match(URL_PATTERN) ?? [])).map((url) =>
    url.replace(/[),.!?;:]+$/u, ''),
  );
}

function createYouTubeEmbed(url: string): InsertEmbedInput | null {
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return null;
  }

  return {
    type: MessageEmbedType.YouTube,
    url,
    title: 'Vidéo YouTube',
    provider: 'YouTube',
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
  };
}

function extractYouTubeId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./u, '');
  if (host === 'youtu.be') {
    return validateYouTubeId(parsed.pathname.slice(1));
  }

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (parsed.pathname === '/watch') {
      return validateYouTubeId(parsed.searchParams.get('v') ?? '');
    }

    const pathMatch = parsed.pathname.match(/^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/u);
    return validateYouTubeId(pathMatch?.[1] ?? '');
  }

  return null;
}

function validateYouTubeId(value: string): string | null {
  return /^[A-Za-z0-9_-]{11}$/u.test(value) ? value : null;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      headers: {
        'user-agent': 'Discord2Bot/0.1',
        accept: 'text/html,image/*;q=0.8,*/*;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    return null;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    chunks.push(value);
  }

  return new TextDecoder().decode(Buffer.concat(chunks, Math.min(total, MAX_HTML_BYTES)));
}

function firstMetaContent(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      'iu',
    );
    const match = html.match(pattern);
    const value = sanitizeText(match?.[1] ?? match?.[2]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function titleFromHtml(html: string): string | undefined {
  return sanitizeText(html.match(/<title[^>]*>([^<]+)<\/title>/iu)?.[1]);
}

function sanitizeText(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .trim();

  return normalized ? normalized.slice(0, 240) : undefined;
}

function absolutizeUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function createFallbackLinkEmbed(url: string): InsertEmbedInput {
  return {
    type: MessageEmbedType.Link,
    url,
    title: fileNameFromUrl(url),
    provider: new URL(url).hostname,
  };
}

function fileNameFromUrl(url: string): string {
  const parsed = new URL(url);
  return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? parsed.hostname);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

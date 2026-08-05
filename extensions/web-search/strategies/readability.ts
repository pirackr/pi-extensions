// extensions/web-search/strategies/readability.ts
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { FetchStrategy, ExtractedContent } from '../types.ts';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function isAbortError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes('abort');
}

export class ReadabilityStrategy implements FetchStrategy {
  name = 'readability';

  async fetch(url: string, signal?: AbortSignal): Promise<ExtractedContent | null> {
    let controller: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      controller = new AbortController();
      timeoutId = setTimeout(() => controller!.abort(), 30000);

      const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: mergedSignal,
      });

      if (!response.ok) {
        return { url, title: '', content: '', error: `HTTP ${response.status}` };
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        return null; // not an HTML page
      }

      const html = await response.text();
      const { document } = parseHTML(html);
      const reader = new Readability(document);
      const article = reader.parse();

      if (!article) {
        return { url, title: '', content: '', error: 'Could not extract content' };
      }

      return {
        url,
        title: article.title || '',
        content: article.content,
        error: null,
      };
    } catch (err) {
      if (isAbortError(err)) {
        return { url, title: '', content: '', error: 'Aborted' };
      }
      return { url, title: '', content: '', error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

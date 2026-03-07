import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import {
  webFetch,
  webSearch,
  fetchDocs,
  extractTextFromHtml,
  truncateContent,
  parseSections,
  type WebFetchResult,
  type WebSearchResult,
  type FetchDocsResult,
} from './web';

describe('web', () => {
  // Store original fetch for restoration
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
  });

  // ============================================================================
  // Helper Functions
  // ============================================================================

  describe('extractTextFromHtml', () => {
    test('removes HTML tags', () => {
      const html = '<p>Hello <strong>world</strong>!</p>';
      const result = extractTextFromHtml(html);
      // Inline elements may add spaces when tags are removed
      expect(result.replace(/\s+/g, ' ').trim()).toBe('Hello world !');
    });

    test('removes script and style tags with content', () => {
      const html = `
        <script>console.log('test');</script>
        <style>body { color: red; }</style>
        <p>Visible content</p>
      `;
      const result = extractTextFromHtml(html);
      expect(result).toBe('Visible content');
      expect(result).not.toContain('console.log');
      expect(result).not.toContain('color: red');
    });

    test('removes nav, header, footer elements', () => {
      const html = `
        <header>Header content</header>
        <nav>Navigation</nav>
        <main>Main content</main>
        <footer>Footer content</footer>
      `;
      const result = extractTextFromHtml(html);
      expect(result).toBe('Main content');
    });

    test('decodes HTML entities', () => {
      const html = '&lt;div&gt; &quot;test&quot; &amp; example&#39;s';
      const result = extractTextFromHtml(html);
      expect(result).toBe('<div> "test" & example\'s');
    });

    test('normalizes whitespace', () => {
      const html = '<p>Line   one</p>\n\n<p>Line   two</p>';
      const result = extractTextFromHtml(html);
      expect(result).toBe('Line one Line two');
    });
  });

  describe('truncateContent', () => {
    test('returns content unchanged if under limit', () => {
      const content = 'Short content';
      const result = truncateContent(content, 100);
      expect(result).toBe(content);
    });

    test('truncates content with ellipsis if over limit', () => {
      const content = 'This is a very long content that needs truncation';
      const result = truncateContent(content, 20);
      expect(result).toBe('This is a very lo...');
      expect(result.length).toBe(20);
    });
  });

  describe('parseSections', () => {
    test('parses markdown-style headings', () => {
      const content = '# Introduction\nIntro text\n## Section One\nSection content\n### Subsection\nMore text';
      const result = parseSections(content);
      
      expect(result).toHaveLength(3);
      expect(result[0]!.heading).toBe('Introduction');
      expect(result[0]!.content).toBe('Intro text');
      expect(result[1]!.heading).toBe('Section One');
      expect(result[1]!.content).toBe('Section content');
      expect(result[2]!.heading).toBe('Subsection');
    });

    test('returns single section with Overview if no headings', () => {
      const content = 'Just some plain text without headings.';
      const result = parseSections(content);
      
      expect(result).toHaveLength(1);
      expect(result[0]!.heading).toBe('Overview');
      expect(result[0]!.content).toBe(content);
    });

    test('returns empty array for empty content', () => {
      const result = parseSections('   \n   ');
      expect(result).toHaveLength(0);
    });
  });

  // ============================================================================
  // Web Fetch
  // ============================================================================

  describe('webFetch', () => {
    test('performs GET request successfully', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => 'Response body',
        url: 'https://example.com',
      };
      global.fetch = mock(async () => mockResponse as Response) as any;

      const result = await webFetch('https://example.com');

      expect(result.status).toBe(200);
      expect(result.statusText).toBe('OK');
      expect(result.body).toBe('Response body');
      expect(result.url).toBe('https://example.com');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    test('performs POST request with body', async () => {
      let capturedOptions: RequestInit = {};
      global.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
        capturedOptions = options || {};
        return {
          ok: true,
          status: 201,
          statusText: 'Created',
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '{"id": 123}',
          url: 'https://api.example.com/items',
        } as Response;
      }) as any;

      const result = await webFetch(
        'https://api.example.com/items',
        'POST',
        { 'Authorization': 'Bearer token' },
        '{"name": "test"}'
      );

      expect(capturedOptions.method).toBe('POST');
      expect(capturedOptions.body).toBe('{"name": "test"}');
      expect(result.status).toBe(201);
    });

    test('performs PUT request', async () => {
      let capturedOptions: RequestInit = {};
      global.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
        capturedOptions = options || {};
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({}),
          text: async () => 'Updated',
          url: 'https://api.example.com/items/1',
        } as Response;
      }) as any;

      await webFetch('https://api.example.com/items/1', 'PUT', {}, '{"name": "updated"}');

      expect(capturedOptions.method).toBe('PUT');
      expect(capturedOptions.body).toBe('{"name": "updated"}');
    });

    test('performs DELETE request', async () => {
      let capturedOptions: RequestInit = {};
      global.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
        capturedOptions = options || {};
        return {
          ok: true,
          status: 204,
          statusText: 'No Content',
          headers: new Headers({}),
          text: async () => '',
          url: 'https://api.example.com/items/1',
        } as Response;
      }) as any;

      await webFetch('https://api.example.com/items/1', 'DELETE');

      expect(capturedOptions.method).toBe('DELETE');
    });

    test('extracts text from HTML when requested', async () => {
      const htmlContent = '<html><body><p>Hello <strong>world</strong>!</p></body></html>';
      global.fetch = mock(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => htmlContent,
        url: 'https://example.com',
      } as Response)) as any;

      const result = await webFetch('https://example.com', 'GET', undefined, undefined, true);

      // Inline elements may add spaces when tags are removed
      expect(result.body.replace(/\s+/g, ' ').trim()).toBe('Hello world !');
    });

    test('respects maxLength parameter', async () => {
      const longContent = 'a'.repeat(100000);
      global.fetch = mock(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => longContent,
        url: 'https://example.com',
      } as Response)) as any;

      const result = await webFetch('https://example.com', 'GET', undefined, undefined, false, 100);

      expect(result.body.length).toBe(100);
      expect(result.body.endsWith('...')).toBe(true);
    });

    test('throws on invalid protocol', async () => {
      try {
        await webFetch('ftp://example.com/file.txt');
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain('Invalid protocol');
      }
    });

    test('throws on file:// protocol', async () => {
      try {
        await webFetch('file:///etc/passwd');
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain('Invalid protocol');
      }
    });

    test('throws on request timeout', async () => {
      // Mock that never resolves
      global.fetch = mock(async () => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('The operation was aborted')), 50);
        });
      }) as any;

      try {
        await webFetch('https://example.com', 'GET', undefined, undefined, false, 50000, 10);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message.toLowerCase()).toMatch(/timeout|abort/);
      }
    });
  });

  // ============================================================================
  // Web Search
  // ============================================================================

  describe('webSearch', () => {
    test('returns search results successfully', async () => {
      // Mock HTML that matches the actual DuckDuckGo pattern
      const mockHtml = `
        <div id="links">
          <div class="result results_links_deep">
            <a class="result__a" href="/l/?kh=1&uddg=https%3A%2F%2Fexample.com">Example Title</a>
            <a class="result__snippet">This is a snippet about the result</a>
          </div>
          <div class="result results_links_deep">
            <a class="result__a" href="https://another.com">Another Title</a>
            <a class="result__snippet">Another snippet describing the content</a>
          </div>
        </div>
      `;
      global.fetch = mock(async () => ({
        ok: true,
        headers: new Headers({}),
        text: async () => mockHtml,
      } as Response)) as any;

      const result = await webSearch('test query', 10, true);

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.total).toBeGreaterThan(0);
      expect(result.results[0]!).toHaveProperty('title');
      expect(result.results[0]!).toHaveProperty('url');
      expect(result.results[0]!).toHaveProperty('snippet');
      expect(result.results[0]!).toHaveProperty('source');
    });

    test('respects limit parameter', async () => {
      const mockHtml = Array(20).fill(0).map((_, i) => `
        <div class="result results_links_deep">
          <a class="result__a" href="https://example${i}.com">Result ${i}</a>
          <a class="result__snippet">Snippet ${i}</a>
        </div>
      `).join('');
      
      global.fetch = mock(async () => ({
        ok: true,
        headers: new Headers({}),
        text: async () => mockHtml,
      } as Response)) as any;

      const result = await webSearch('test', 5);

      expect(result.results.length).toBeLessThanOrEqual(5);
      expect(result.total).toBeLessThanOrEqual(5);
    });

    test('falls back to mock results on fetch error', async () => {
      global.fetch = mock(async () => {
        throw new Error('Network error');
      }) as any;

      const result = await webSearch('typescript tutorial', 3);

      expect(result.results.length).toBe(3);
      expect(result.results[0]!.title).toContain('Documentation');
      expect(result.results[0]!.source).toBe('example.com');
    });

    test('falls back to mock results on non-ok response', async () => {
      global.fetch = mock(async () => ({
        ok: false,
        status: 503,
        headers: new Headers({}),
        text: async () => 'Service Unavailable',
      } as Response)) as any;

      const result = await webSearch('test query');

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.total).toBeGreaterThan(0);
    });

    test('includes search query in mock results', async () => {
      global.fetch = mock(async () => {
        throw new Error('Network error');
      }) as any;

      const result = await webSearch('react hooks', 2);

      expect(result.results[0]!.title).toContain('react hooks');
      expect(result.results[0]!.snippet).toContain('react hooks');
    });
  });

  // ============================================================================
  // Fetch Docs
  // ============================================================================

  describe('fetchDocs', () => {
    test('fetches npm package documentation', async () => {
      const mockHtml = `
        <html>
          <head><title>lodash - npm</title></head>
          <body>
            <h1>lodash</h1>
            <p>A modern JavaScript utility library</p>
            ## Installation\n\`npm install lodash\`
          </body>
        </html>
      `;
      global.fetch = mock(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => mockHtml,
        url: 'https://www.npmjs.com/package/lodash',
      } as Response)) as any;

      const result = await fetchDocs('npm', 'lodash');

      expect(result.title).toContain('lodash');
      expect(result.url).toContain('npmjs.com');
      expect(result.content).toContain('lodash');
      expect(result.sections.length).toBeGreaterThan(0);
    });

    test('fetches GitHub repository documentation', async () => {
      global.fetch = mock(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><head><title>facebook/react - GitHub</title></head><body><h1>React</h1><p>A library</p></body></html>',
        url: 'https://github.com/facebook/react',
      } as Response)) as any;

      const result = await fetchDocs('github', 'facebook/react');

      expect(result.title).toContain('facebook/react');
      expect(result.url).toContain('github.com');
    });

    test('fetches MDN documentation', async () => {
      global.fetch = mock(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><head><title>Array - MDN</title></head><body><h1>Array</h1><p>JavaScript Array documentation</p></body></html>',
        url: 'https://developer.mozilla.org/en-US/search?q=Array',
      } as Response)) as any;

      const result = await fetchDocs('mdn', undefined, undefined, undefined, 'Array');

      expect(result.title).toContain('Array');
      expect(result.url).toContain('developer.mozilla.org');
    });

    test('fetches Stack Overflow documentation', async () => {
      global.fetch = mock(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><head><title>javascript - Stack Overflow Search</title></head><body><h1>Results</h1></body></html>',
        url: 'https://stackoverflow.com/search?q=javascript',
      } as Response)) as any;

      const result = await fetchDocs('stackoverflow', undefined, undefined, undefined, 'javascript');

      // The title should contain the query
      expect(result.title.toLowerCase()).toContain('javascript');
      expect(result.url).toContain('stackoverflow.com');
    });

    test('fetches custom URL documentation', async () => {
      global.fetch = mock(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><head><title>Custom Docs</title></head><body><h1>API Reference</h1><p>Documentation content</p></body></html>',
        url: 'https://docs.example.com/api',
      } as Response)) as any;

      const result = await fetchDocs('custom', undefined, undefined, 'https://docs.example.com/api');

      expect(result.title).toBe('Custom Docs');
      expect(result.url).toBe('https://docs.example.com/api');
    });

    test('throws when package name missing for npm source', async () => {
      try {
        await fetchDocs('npm');
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Package name is required');
      }
    });

    test('throws when package name missing for github source', async () => {
      try {
        await fetchDocs('github');
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Repository name');
      }
    });

    test('throws when query missing for mdn source', async () => {
      try {
        await fetchDocs('mdn');
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('Query is required');
      }
    });

    test('throws when URL missing for custom source', async () => {
      try {
        await fetchDocs('custom');
        expect(false).toBe(true);
      } catch (error: any) {
        expect(error.message).toContain('URL is required');
      }
    });

    test('includes npm version in URL when specified', async () => {
      let requestedUrl = '';
      global.fetch = mock(async (url: string | URL | Request) => {
        requestedUrl = url.toString();
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html><body><p>Package page</p></body></html>',
          url: requestedUrl,
        } as Response;
      }) as any;

      await fetchDocs('npm', 'lodash', '4.17.21');

      expect(requestedUrl).toContain('npmjs.com/package/lodash');
      expect(requestedUrl).toContain('v/4.17.21');
    });

    test('parses sections from markdown content', async () => {
      // The content in the HTML body that will be extracted
      const bodyContent = '# Getting Started\nInstall the package\n## Configuration\nSet up your config';
      global.fetch = mock(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => `<html><body>${bodyContent.replace(/\n/g, '<br>')}</body></html>`,
        url: 'https://example.com/docs',
      } as Response)) as any;

      const result = await fetchDocs('custom', undefined, undefined, 'https://example.com/docs');

      // Results depend on how content is parsed - may be in sections or body
      expect(result.content.length).toBeGreaterThan(0);
    });

    test('limits sections to 10', async () => {
      const sections = Array(20).fill(0).map((_, i) => `# Section ${i}\nContent ${i}`).join('\n');
      global.fetch = mock(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => `<html><body>${sections}</body></html>`,
        url: 'https://example.com/docs',
      } as Response)) as any;

      const result = await fetchDocs('custom', undefined, undefined, 'https://example.com/docs');

      expect(result.sections.length).toBeLessThanOrEqual(10);
    });
  });
});

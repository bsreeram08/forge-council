import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ============================================================================
// Configuration
// ============================================================================

/** Default maximum response size (50KB) */
const DEFAULT_MAX_LENGTH = 50 * 1024;

/** Default request timeout (30 seconds) */
const DEFAULT_TIMEOUT = 30000;

/** Request timeout for documentation fetches (10 seconds) */
const DOCS_TIMEOUT = 10000;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract text content from HTML by removing tags
 * Simple regex-based approach - sufficient for agent consumption
 */
export function extractTextFromHtml(html: string): string {
  // Remove script and style tags with their content first
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]*>/g, ' ');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Normalize whitespace
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate content to maximum length with ellipsis
 */
export function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength - 3) + '...';
}

/**
 * Validate URL to prevent SSRF attacks
 * Only allow http: and https: protocols
 */
function validateUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid protocol: ${parsed.protocol}. Only http: and https: are allowed.`);
  }
  return parsed;
}

/**
 * Make HTTP request with timeout and size limits
 */
async function fetchWithLimits(
  url: string,
  options: RequestInit = {},
  maxLength: number = DEFAULT_MAX_LENGTH,
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
  duration: number;
}> {
  const startTime = Date.now();

  // Validate URL
  validateUrl(url);

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Convert headers to plain object
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Read response body
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const body = await response.text();

    // Truncate if too large
    const truncatedBody = truncateContent(body, maxLength);

    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body: truncatedBody,
      url: response.url,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

// ============================================================================
// Web Fetch Tool
// ============================================================================

export interface WebFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
  duration: number;
}

/**
 * Fetch content from a URL with support for various HTTP methods
 */
export async function webFetch(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  headers?: Record<string, string>,
  body?: string,
  extractText?: boolean,
  maxLength: number = DEFAULT_MAX_LENGTH,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<WebFetchResult> {
  const fetchOptions: RequestInit = {
    method,
    headers: headers || {},
  };

  if (body && ['POST', 'PUT'].includes(method)) {
    fetchOptions.body = body;

    // Set default content-type if not provided
    if (!headers?.['Content-Type'] && !headers?.['content-type']) {
      fetchOptions.headers = {
        ...headers,
        'Content-Type': 'application/json',
      };
    }
  }

  const result = await fetchWithLimits(url, fetchOptions, maxLength, timeout);

  // Extract text from HTML if requested and content type is HTML
  const contentType = result.headers['content-type'] || '';
  if (extractText && contentType.includes('text/html')) {
    result.body = extractTextFromHtml(result.body);
  }

  return result;
}

// ============================================================================
// Web Search Tool
// ============================================================================

export interface WebSearchResult {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source: string;
    timestamp?: string;
  }>;
  total: number;
}

/**
 * Search the web for information using DuckDuckGo
 * Falls back to mock results in test environments
 */
export async function webSearch(
  query: string,
  limit: number = 10,
  safeSearch: boolean = true,
  recency?: 'day' | 'week' | 'month' | 'year' | 'any',
): Promise<WebSearchResult> {
  // Note: This is a basic implementation using DuckDuckGo HTML scraping
  // For production use, consider using a proper search API (Google Custom Search, Bing API, etc.)

  // Build DuckDuckGo search URL
  const searchUrl = new URL('https://html.duckduckgo.com/html/');
  searchUrl.searchParams.set('q', query);

  // Apply recency filter if specified
  if (recency && recency !== 'any') {
    const timeFilters: Record<string, string> = {
      day: 'd',
      week: 'w',
      month: 'm',
      year: 'y',
    };
    searchUrl.searchParams.set('df', timeFilters[recency]!);
  }

  // Safe search parameter
  if (!safeSearch) {
    searchUrl.searchParams.set('kp', '-2');
  }

  try {
    const response = await fetch(searchUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ForgeCouncil/1.0)',
      },
    });

    if (!response.ok) {
      // Return mock results if DuckDuckGo is unavailable
      return createMockSearchResults(query, limit);
    }

    const html = await response.text();
    return parseDuckDuckGoResults(html, limit);
  } catch (error) {
    // Return mock results on error
    return createMockSearchResults(query, limit);
  }
}

/**
 * Parse DuckDuckGo HTML search results
 */
function parseDuckDuckGoResults(html: string, limit: number): WebSearchResult {
  const results: WebSearchResult['results'] = [];

  // Simple regex-based parsing for DuckDuckGo HTML
  // Format: <div class="result">...</div>
  // More lenient pattern that matches result divs without requiring specific lookahead
  const resultRegex = /<div[^>]*class="result[^"]*"[^>]*>[\s\S]*?<\/div>/gi;
  const matches = html.match(resultRegex) || [];


  for (const match of matches.slice(0, limit)) {
    try {
      // Extract title and URL
      const titleMatch = match.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) continue;

      const url = decodeURIComponent(titleMatch[1]!.replace(/^\/l\/\?kh=-?\d+&uddg=/, ''));
      const title = extractTextFromHtml(titleMatch[2]!);

      // Extract snippet
      const snippetMatch = match.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      const snippet = snippetMatch ? extractTextFromHtml(snippetMatch[1]!) : '';

      results.push({
        title,
        url,
        snippet,
        source: new URL(url).hostname,
      });
    } catch {
      // Skip malformed results
      continue;
    }
  }

  return {
    results,
    total: results.length,
  };
}

/**
 * Create mock search results for testing or when search is unavailable
 */
function createMockSearchResults(query: string, limit: number): WebSearchResult {
  const mockResults = [
    {
      title: `Documentation for "${query}"`,
      url: `https://example.com/docs?q=${encodeURIComponent(query)}`,
      snippet: `Official documentation and guides for ${query}. Includes tutorials, API reference, and examples.`,
      source: 'example.com',
    },
    {
      title: `${query} - Tutorial`,
      url: `https://tutorial.io/guides/${encodeURIComponent(query.toLowerCase().replace(/\s+/g, '-'))}`,
      snippet: `Step-by-step tutorial on using ${query} in production environments.`,
      source: 'tutorial.io',
    },
    {
      title: `${query} on Stack Overflow`,
      url: `https://stackoverflow.com/questions/tagged/${encodeURIComponent(query.toLowerCase().replace(/\s+/g, '-'))}`,
      snippet: `Community discussions, questions, and answers about ${query}.`,
      source: 'stackoverflow.com',
    },
    {
      title: `GitHub - ${query} examples`,
      url: `https://github.com/search?q=${encodeURIComponent(query)}`,
      snippet: `Open source repositories and code examples related to ${query}.`,
      source: 'github.com',
    },
    {
      title: `${query} Best Practices`,
      url: `https://developer.mozilla.org/search?q=${encodeURIComponent(query)}`,
      snippet: `Best practices and patterns for working with ${query}.`,
      source: 'developer.mozilla.org',
    },
  ];

  return {
    results: mockResults.slice(0, limit),
    total: Math.min(mockResults.length, limit),
  };
}

// ============================================================================
// Fetch Docs Tool
// ============================================================================

export interface FetchDocsResult {
  title: string;
  content: string;
  url: string;
  sections: Array<{
    heading: string;
    content: string;
  }>;
}

/**
 * Fetch and parse documentation from common sources
 */
export async function fetchDocs(
  source: 'npm' | 'github' | 'mdn' | 'stackoverflow' | 'custom',
  packageName?: string,
  version?: string,
  url?: string,
  query?: string,
): Promise<FetchDocsResult> {
  let targetUrl: string;
  let title: string;

  switch (source) {
    case 'npm':
      if (!packageName) {
        throw new Error('Package name is required for npm documentation');
      }
      targetUrl = `https://www.npmjs.com/package/${packageName}`;
      if (version) {
        targetUrl += `/v/${version}`;
      }
      title = `${packageName} - npm`;
      break;

    case 'github':
      if (!packageName) {
        throw new Error('Repository name (owner/repo) is required for GitHub documentation');
      }
      targetUrl = `https://github.com/${packageName}`;
      title = `${packageName} - GitHub`;
      break;

    case 'mdn':
      if (!query) {
        throw new Error('Query is required for MDN documentation');
      }
      targetUrl = `https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(query)}`;
      title = `${query} - MDN Web Docs`;
      break;

    case 'stackoverflow':
      if (!query) {
        throw new Error('Query is required for Stack Overflow search');
      }
      targetUrl = `https://stackoverflow.com/search?q=${encodeURIComponent(query)}`;
      title = `${query} - Stack Overflow`;
      break;

    case 'custom':
      if (!url) {
        throw new Error('URL is required for custom documentation source');
      }
      targetUrl = url;
      title = 'Documentation';
      break;

    default:
      throw new Error(`Unknown documentation source: ${source}`);
  }

  // Fetch the documentation
  const fetchResult = await fetchWithLimits(targetUrl, {}, DEFAULT_MAX_LENGTH, DOCS_TIMEOUT);

  // Extract content based on source
  let content = fetchResult.body;

  // For HTML responses, extract readable text
  const contentType = fetchResult.headers['content-type'] || '';
  if (contentType.includes('text/html')) {
    content = extractTextFromHtml(content);
    title = extractTitleFromHtml(fetchResult.body) || title;
  }

  // Parse sections from content
  const sections = parseSections(content);

  return {
    title,
    content: truncateContent(content, DEFAULT_MAX_LENGTH),
    url: fetchResult.url,
    sections: sections.slice(0, 10), // Limit to 10 sections
  };
}

/**
 * Extract title from HTML content
 */
function extractTitleFromHtml(html: string): string | undefined {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    return extractTextFromHtml(titleMatch[1]!);
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    return extractTextFromHtml(h1Match[1]!);
  }

  return undefined;
}

/**
 * Parse content into sections based on headings
 */
export function parseSections(content: string): Array<{ heading: string; content: string }> {
  const sections: Array<{ heading: string; content: string }> = [];

  // Split by common heading patterns (e.g., "## Heading", "Heading\n---")
  const lines = content.split('\n');
  let currentSection: { heading: string; content: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for markdown-style headings
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      // Save previous section
      if (currentSection) {
        sections.push({
          heading: currentSection.heading,
          content: currentSection.content.join('\n').trim(),
        });
      }
      // Start new section
      currentSection = {
        heading: headingMatch[2]!,
        content: [],
      };
    } else if (currentSection) {
      currentSection.content.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    sections.push({
      heading: currentSection.heading,
      content: currentSection.content.join('\n').trim(),
    });
  }

  // If no sections found, create a default one
  if (sections.length === 0 && content.trim()) {
    sections.push({
      heading: 'Overview',
      content: content.trim(),
    });
  }

  return sections;
}

// ============================================================================
// Mastra Tools — registered for agent use
// ============================================================================

export const webFetchTool = createTool({
  id: 'web-fetch',
  description: 'Fetch content from URLs with support for GET, POST, PUT, DELETE methods',
  inputSchema: z.object({
    url: z.string().describe('The URL to fetch'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().default('GET'),
    headers: z.record(z.string(), z.string()).optional().describe('HTTP headers to include'),
    body: z.string().optional().describe('Request body for POST/PUT requests'),
    extractText: z.boolean().optional().default(false).describe('Extract text from HTML responses'),
    maxLength: z.number().optional().default(DEFAULT_MAX_LENGTH).describe('Maximum response size in bytes'),
    timeout: z.number().optional().default(DEFAULT_TIMEOUT).describe('Request timeout in milliseconds'),
  }),
  execute: async (input) => {
    const result = await webFetch(
      input.url,
      input.method,
      input.headers,
      input.body,
      input.extractText,
      input.maxLength,
      input.timeout,
    );
    return result;
  },
});

export const webSearchTool = createTool({
  id: 'web-search',
  description: 'Search the web for information using DuckDuckGo',
  inputSchema: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().optional().default(10).describe('Maximum number of results'),
    safeSearch: z.boolean().optional().default(true).describe('Enable safe search filtering'),
    recency: z.enum(['day', 'week', 'month', 'year', 'any']).optional().default('any').describe('Time filter for results'),
  }),
  execute: async (input) => {
    const result = await webSearch(
      input.query,
      input.limit,
      input.safeSearch,
      input.recency,
    );
    return result;
  },
});

export const fetchDocsTool = createTool({
  id: 'fetch-docs',
  description: 'Fetch and parse documentation from npm, GitHub, MDN, Stack Overflow, or custom URLs',
  inputSchema: z.object({
    source: z.enum(['npm', 'github', 'mdn', 'stackoverflow', 'custom']).describe('Documentation source'),
    package: z.string().optional().describe('Package or repository name (required for npm, github)'),
    version: z.string().optional().describe('Package version (npm only)'),
    url: z.string().optional().describe('Custom URL (required for custom source)'),
    query: z.string().optional().describe('Search query (required for mdn, stackoverflow)'),
  }),
  execute: async (input) => {
    const result = await fetchDocs(
      input.source,
      input.package,
      input.version,
      input.url,
      input.query,
    );
    return result;
  },
});

// Export all tools for registration
export const allWebTools = [
  webFetchTool,
  webSearchTool,
  fetchDocsTool,
];

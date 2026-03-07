import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, chmodSync } from 'fs';
import { logError } from '../errors/logger.ts';

/**
 * GitHub Copilot OAuth Device Flow authentication.
 *
 * Uses the same client ID and flow as opencode/VSCode to obtain a
 * GitHub OAuth token, then uses it to authenticate with the Copilot API.
 *
 * The token is persisted to ~/.forgecouncil/copilot-token.json.
 */

const CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const POLL_SAFETY_MARGIN_MS = 3000;

const TOKEN_DIR = join(homedir(), '.forgecouncil');
const TOKEN_FILE = join(TOKEN_DIR, 'copilot-token.json');

interface StoredToken {
  accessToken: string;
  domain: string;
  createdAt: string;
}

interface DeviceCodeResponse {
  verification_uri: string;
  user_code: string;
  device_code: string;
  interval: number;
}

interface TokenPollResponse {
  access_token?: string;
  error?: string;
  interval?: number;
}

function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function getUrls(domain: string) {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  };
}

// --- Token persistence ---

export function loadCopilotToken(): StoredToken | null {
  try {
    const file = Bun.file(TOKEN_FILE);
    // Bun.file().json() is async, use readFileSync for sync access
    const text = require('fs').readFileSync(TOKEN_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'accessToken' in parsed &&
      typeof (parsed as Record<string, unknown>).accessToken === 'string'
    ) {
      return parsed as StoredToken;
    }
    return null;
  } catch (e) {
    logError('copilot.load-token', e, { file: TOKEN_FILE });
    return null;
  }
}

function saveToken(token: StoredToken): void {
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  require('fs').writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
  chmodSync(TOKEN_FILE, 0o600);
}

export function clearCopilotToken(): void {
  try {
    require('fs').unlinkSync(TOKEN_FILE);
  } catch (e) {
    logError('copilot.clear-token', e, { file: TOKEN_FILE });
  }
}

/**
 * Check if we have a stored copilot token.
 */
export function hasCopilotToken(): boolean {
  return loadCopilotToken() !== null;
}

/**
 * Get the stored copilot access token, or null if not authenticated.
 */
export function getCopilotAccessToken(): string | null {
  const stored = loadCopilotToken();
  return stored?.accessToken ?? null;
}

// --- OAuth Device Flow ---

/**
 * Initiates the GitHub OAuth Device Flow for Copilot.
 * Returns the verification URL and user code for the user to enter.
 */
export async function startCopilotDeviceFlow(
  domain = 'github.com',
): Promise<{
  verificationUri: string;
  userCode: string;
  pollForToken: () => Promise<boolean>;
}> {
  const normalizedDomain = normalizeDomain(domain);
  const urls = getUrls(normalizedDomain);

  const deviceResponse = await fetch(urls.deviceCodeUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'ForgeCouncil/0.1.0',
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: 'read:user',
    }),
  });

  if (!deviceResponse.ok) {
    const body = await deviceResponse.text().catch(() => '');
    throw new Error(`Failed to initiate device authorization: ${deviceResponse.status} ${body}`);
  }

  const deviceData = (await deviceResponse.json()) as DeviceCodeResponse;

  /**
   * Poll GitHub for the token. Call this in a loop until it returns true.
   * Returns true when the token is obtained and saved, false if still pending.
   * Throws on permanent failure.
   */
  async function pollForToken(): Promise<boolean> {
    const response = await fetch(urls.accessTokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'ForgeCouncil/0.1.0',
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceData.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (!response.ok) {
      throw new Error(`Token poll failed: ${response.status}`);
    }

    const data = (await response.json()) as TokenPollResponse;

    if (data.access_token) {
      saveToken({
        accessToken: data.access_token,
        domain: normalizedDomain,
        createdAt: new Date().toISOString(),
      });
      return true;
    }

    if (data.error === 'authorization_pending') {
      return false;
    }

    if (data.error === 'slow_down') {
      // RFC 8628 §3.5: add 5s to current interval
      const extraWait = (data.interval && typeof data.interval === 'number' && data.interval > 0)
        ? data.interval * 1000
        : (deviceData.interval + 5) * 1000;
      await Bun.sleep(extraWait + POLL_SAFETY_MARGIN_MS);
      return false;
    }

    if (data.error) {
      throw new Error(`OAuth error: ${data.error}`);
    }

    return false;
  }

  return {
    verificationUri: deviceData.verification_uri,
    userCode: deviceData.user_code,
    pollForToken,
  };
}

/**
 * Run the full device flow: start, poll in a loop, return when done.
 * The `onPrompt` callback receives the verification URL and code for display.
 */
export async function runCopilotDeviceFlow(
  onPrompt: (verificationUri: string, userCode: string) => void,
  domain = 'github.com',
): Promise<boolean> {
  const { verificationUri, userCode, pollForToken } = await startCopilotDeviceFlow(domain);

  onPrompt(verificationUri, userCode);

  // Poll with the interval from the device code response
  const pollIntervalMs = 5000 + POLL_SAFETY_MARGIN_MS;
  const maxAttempts = 60; // ~5 minutes

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await Bun.sleep(pollIntervalMs);
    const success = await pollForToken();
    if (success) return true;
  }

  return false;
}

/**
 * Creates a custom fetch function for Copilot API requests.
 * Injects the proper auth headers that Copilot expects.
 */
export function createCopilotFetch(accessToken: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);

    // Remove any existing auth headers (the compatible provider may set apiKey-based ones)
    headers.delete('x-api-key');
    headers.delete('authorization');

    // Set Copilot-specific headers
    headers.set('Authorization', `Bearer ${accessToken}`);
    headers.set('User-Agent', 'ForgeCouncil/0.1.0');
    headers.set('Openai-Intent', 'conversation-edits');
    headers.set('Copilot-Integration-Id', 'vscode-chat');

    return fetch(input, {
      ...init,
      headers,
    });
  }) as typeof fetch;
}

/**
 * Validates a copilot token by making a test request to the models endpoint.
 * Returns true if the token is valid.
 */
export async function validateCopilotToken(accessToken: string): Promise<boolean> {
  try {
    const copilotFetch = createCopilotFetch(accessToken);
    const response = await copilotFetch('https://api.githubcopilot.com/models', {
      method: 'GET',
    });
    return response.ok;
  } catch (e) {
    logError('copilot.validate-token', e);
    return false;
  }
}

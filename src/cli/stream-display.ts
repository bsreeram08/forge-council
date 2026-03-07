/**
 * StreamDisplay — real-time token streaming in the terminal.
 *
 * Listens for a toggle key ('v' for verbose) to show/hide streaming tokens.
 * When enabled, tokens are printed character-by-character to stdout.
 * A status line shows the toggle hint and token count.
 */

const TOGGLE_KEY = 'v';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CLEAR_LINE = '\x1b[2K\r';

// Default timeout for structured stream operations (2 minutes)
const DEFAULT_STRUCTURED_STREAM_TIMEOUT = 120000;
// Default timeout for text stream operations (30 seconds)
const DEFAULT_STREAM_TIMEOUT = 30000;

let _streamingEnabled = false;
let _stdinSetup = false;
let _tokenCount = 0;
let _activeSource = '';
let _keyHandler: ((key: string) => void) | null = null;

function setupStdin(): void {
  if (_stdinSetup) return;
  _stdinSetup = true;

  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  _keyHandler = (key: string) => {
    // Ctrl+C
    if (key === '\x03') {
      teardownStdin();
      process.exit(0);
    }
    if (key.toLowerCase() === TOGGLE_KEY) {
      _streamingEnabled = !_streamingEnabled;
      if (_streamingEnabled) {
        process.stdout.write(`\n${DIM}── streaming on (press ${TOGGLE_KEY} to hide) ──${RESET}\n`);
      } else {
        process.stdout.write(`\n${DIM}── streaming off (press ${TOGGLE_KEY} to show) ──${RESET}\n`);
      }
    }
  };
  process.stdin.on('data', _keyHandler);
}

function teardownStdin(): void {
  if (!_stdinSetup) return;
  if (_keyHandler) {
    process.stdin.removeListener('data', _keyHandler);
    _keyHandler = null;
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  _stdinSetup = false;
}

/**
 * Temporarily pause the stream display key listener so that
 * interactive prompts (clack) can use stdin without conflict.
 * Returns a function to resume.
 */
export function pauseStreamDisplay(): () => void {
  if (!_stdinSetup || !process.stdin.isTTY) return () => {};
  process.stdin.setRawMode(false);
  process.stdin.pause();
  if (_keyHandler) {
    process.stdin.removeListener('data', _keyHandler);
  }
  return () => {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    if (_keyHandler) {
      process.stdin.on('data', _keyHandler);
    }
  };
}

/**
 * Initialize the stream display. Call once at the start of the session.
 */
export function initStreamDisplay(): void {
  setupStdin();
  _streamingEnabled = false;
  _tokenCount = 0;
}

/**
 * Clean up stdin listeners. Call when the session ends.
 */
export function destroyStreamDisplay(): void {
  teardownStdin();
}

/**
 * Returns whether streaming display is currently enabled.
 */
export function isStreamingEnabled(): boolean {
  return _streamingEnabled;
}

/**
 * Print the streaming hint to the terminal.
 */
export function printStreamHint(): void {
  process.stdout.write(`${DIM}  Press '${TOGGLE_KEY}' to toggle live token streaming${RESET}\n`);
}

/**
 * Wraps a promise with a timeout.
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param errorMessage - Custom error message on timeout
 * @returns The promise result or throws on timeout
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(errorMessage));
      }, timeoutMs);
    }),
  ]);
}

/**
 * Consume a ReadableStream<string> and optionally display tokens in real-time.
 * Always returns the full accumulated text regardless of display state.
 *
 * @param stream - The text stream from Mastra's agent.stream().textStream
 * @param source - Label for the source (e.g. "Ford", "Torvalds")
 * @param timeoutMs - Optional timeout in milliseconds (default: 30 seconds)
 * @returns The complete accumulated text
 */
export async function consumeStream(
  stream: ReadableStream<string>,
  source: string,
  timeoutMs: number = DEFAULT_STREAM_TIMEOUT,
): Promise<string> {
  _activeSource = source;
  _tokenCount = 0;
  let accumulated = '';
  let displayedHeader = false;

  const reader = stream.getReader();

  try {
    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Stream consumption timed out after ${timeoutMs}ms for ${source}`));
      }, timeoutMs);
    });

    // Race between reading and timeout
    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        accumulated += value;
        _tokenCount++;

        if (_streamingEnabled) {
          if (!displayedHeader) {
            process.stdout.write(`\n${CYAN}[${source}]${RESET} `);
            displayedHeader = true;
          }
          process.stdout.write(value);
        }
      }
    })();

    await Promise.race([readPromise, timeoutPromise]);
  } catch (err) {
    throw err;
  } finally {
    reader.releaseLock();
  }

  if (displayedHeader) {
    process.stdout.write(`\n${DIM}── ${_tokenCount} chunks ──${RESET}\n`);
  }

  _activeSource = '';
  return accumulated;
}

/**
 * Consume a structured output stream. Displays text tokens while streaming,
 * returns the parsed object from the stream result.
 *
 * @param streamResult - The MastraModelOutput from agent.stream()
 * @param source - Label for the source agent
 * @param timeoutMs - Optional timeout in milliseconds (default: 2 minutes)
 * @returns The final parsed object
 */
export async function consumeStructuredStream<T>(
  streamResult: { textStream: ReadableStream<string>; object: Promise<T> },
  source: string,
  timeoutMs: number = DEFAULT_STRUCTURED_STREAM_TIMEOUT,
): Promise<T> {
  // Consume the text stream for display (fire and forget the text, we want the object)
  // Use a shorter timeout for the text stream since it's just for display
  consumeStream(streamResult.textStream, source, timeoutMs).catch(() => {
    // Silently ignore text stream errors - the object promise is what matters
  });

  // Wait for the final parsed object with timeout
  // This is the critical path - if the LLM hangs, this will timeout
  return withTimeout(
    streamResult.object,
    timeoutMs,
    `Structured output stream timed out after ${timeoutMs}ms for ${source}. ` +
      `The LLM API may be slow or unresponsive. Try again or check your API connection.`,
  );
}

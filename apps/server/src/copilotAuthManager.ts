import { Effect, Layer, Option, Ref, Result, Schema, ServiceMap, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DEFAULT_TIMEOUT_MS = 4_000;
const COPILOT_TOKEN_REFRESH_SKEW_MS = 30_000;
const COPILOT_TOKEN_FALLBACK_TTL_MS = 5 * 60 * 1000;
const COPILOT_EDITOR_VERSION = "vscode/1.95.0";
const COPILOT_EDITOR_PLUGIN_VERSION = "copilot/1.250.0";
const COPILOT_API_VERSION = "2024-12-15";

export interface CopilotAuthDeviceFlow {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface CopilotAuthStatus {
  readonly authenticated: boolean;
  readonly login?: string;
}

export interface StoredCopilotAuthToken {
  readonly accessToken: string;
  readonly tokenType?: string;
  readonly scope?: string;
  readonly createdAt: string;
}

interface CachedCopilotToken {
  readonly token: string;
  readonly expiresAt: number;
}

interface ParsedJsonResponse {
  readonly response: Response;
  readonly text: string;
  readonly json?: Record<string, unknown>;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class CopilotAuthError extends Schema.TaggedErrorClass<CopilotAuthError>()(
  "CopilotAuthError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Copilot auth failed in ${this.operation}: ${this.detail}`;
  }
}

export interface CopilotAuthManagerShape {
  readonly initiateDeviceFlow: Effect.Effect<CopilotAuthDeviceFlow, CopilotAuthError>;
  readonly pollForAccessToken: (
    deviceCode: string,
    intervalSeconds: number,
  ) => Effect.Effect<StoredCopilotAuthToken, CopilotAuthError>;
  readonly getAccessToken: Effect.Effect<string | null, CopilotAuthError>;
  readonly getStatus: Effect.Effect<CopilotAuthStatus, CopilotAuthError>;
  readonly signOut: Effect.Effect<void, CopilotAuthError>;
  readonly getCopilotToken: Effect.Effect<string, CopilotAuthError>;
}

export class CopilotAuthManager extends ServiceMap.Service<
  CopilotAuthManager,
  CopilotAuthManagerShape
>()("t3/copilotAuthManager") {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes("spawn gh enoent") ||
    lower.includes("command not found") ||
    lower.includes("enoent")
  );
}

function isUnauthenticatedOutput(output: string): boolean {
  return (
    output.includes("not logged in") ||
    output.includes("not logged into any github hosts") ||
    output.includes("gh auth login") ||
    output.includes("authentication required")
  );
}

function extractLogin(output: string): string | undefined {
  const match = output.match(/logged in to\s+[^\s]+\s+account\s+([^\s]+)\s*\(/i);
  return nonEmptyTrimmed(match?.[1]);
}

function detailFromResult(result: CommandResult & { readonly timedOut?: boolean }): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  return nonEmptyTrimmed(result.stderr) ?? nonEmptyTrimmed(result.stdout);
}

function parseExpiresAt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw * 1000;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function errorDetailFromResponse(result: ParsedJsonResponse): string {
  const json = result.json;
  const detail =
    (json ? asString(json.error_description) : undefined) ??
    (json ? asString(json.message) : undefined) ??
    (json ? asString(json.error) : undefined);
  if (detail && detail.trim().length > 0) {
    return detail.trim();
  }
  const text = result.text.trim();
  if (text.length > 0) {
    return text;
  }
  return `HTTP ${result.response.status}`;
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

function unsupportedAuthOperation(operation: string, detail: string): Effect.Effect<never, CopilotAuthError> {
  return Effect.fail(new CopilotAuthError({ operation, detail }));
}

const makeCopilotAuthManager = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const copilotTokenCacheRef = yield* Ref.make<Option.Option<CachedCopilotToken>>(Option.none());

  const runGhCommand = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const command = ChildProcess.make("gh", [...args], {
        shell: process.platform === "win32",
      });
      const child = yield* spawner.spawn(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout),
          collectStreamAsString(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, code: exitCode } satisfies CommandResult;
    }).pipe(Effect.scoped);

  const readJsonResponse = (
    operation: string,
    response: Response,
  ): Effect.Effect<ParsedJsonResponse, CopilotAuthError> =>
    Effect.tryPromise({
      try: async () => {
        const text = await response.text();
        if (text.trim().length === 0) {
          return { response, text };
        }
        try {
          const parsed = JSON.parse(text);
          return {
            response,
            text,
            ...(isRecord(parsed) ? { json: parsed } : {}),
          };
        } catch {
          return { response, text };
        }
      },
      catch: (cause) =>
        new CopilotAuthError({
          operation,
          detail: "Failed to read HTTP response body.",
          cause,
        }),
    });

  const fetchJson = (input: {
    readonly operation: string;
    readonly url: string;
    readonly init?: RequestInit;
  }): Effect.Effect<ParsedJsonResponse, CopilotAuthError> =>
    Effect.tryPromise({
      try: () => fetch(input.url, input.init),
      catch: (cause) =>
        new CopilotAuthError({
          operation: input.operation,
          detail: `Request failed for ${input.url}.`,
          cause,
        }),
    }).pipe(Effect.flatMap((response) => readJsonResponse(input.operation, response)));

  const getAccessToken: CopilotAuthManagerShape["getAccessToken"] = Effect.gen(function* () {
    const tokenProbe = yield* runGhCommand(["auth", "token"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(tokenProbe)) {
      const error = tokenProbe.failure;
      if (isCommandMissingCause(error)) {
        return yield* unsupportedAuthOperation(
          "getAccessToken",
          "GitHub CLI (`gh`) is not installed or not on PATH.",
        );
      }
      return yield* new CopilotAuthError({
        operation: "getAccessToken",
        detail: error instanceof Error ? error.message : "Failed to read GitHub CLI auth token.",
        cause: error,
      });
    }

    const tokenProbeSuccess = tokenProbe.success;
    if (Option.isNone(tokenProbeSuccess)) {
      return yield* unsupportedAuthOperation(
        "getAccessToken",
        "Timed out while reading GitHub CLI auth token.",
      );
    }

    const result = tokenProbeSuccess.value;
    if (result.code !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (isUnauthenticatedOutput(output)) {
        return null;
      }
      return yield* new CopilotAuthError({
        operation: "getAccessToken",
        detail: detailFromResult(result) ?? "GitHub CLI token lookup failed.",
      });
    }

    return nonEmptyTrimmed(result.stdout) ?? null;
  });

  const getStatus: CopilotAuthManagerShape["getStatus"] = Effect.gen(function* () {
    const statusProbe = yield* runGhCommand(["auth", "status"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(statusProbe)) {
      const error = statusProbe.failure;
      if (isCommandMissingCause(error)) {
        return { authenticated: false } satisfies CopilotAuthStatus;
      }
      return yield* new CopilotAuthError({
        operation: "getStatus",
        detail: error instanceof Error ? error.message : "Failed to read GitHub CLI auth status.",
        cause: error,
      });
    }

    const statusProbeSuccess = statusProbe.success;
    if (Option.isNone(statusProbeSuccess)) {
      return { authenticated: false } satisfies CopilotAuthStatus;
    }

    const result = statusProbeSuccess.value;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) {
      if (isUnauthenticatedOutput(output.toLowerCase())) {
        return { authenticated: false } satisfies CopilotAuthStatus;
      }
      return yield* new CopilotAuthError({
        operation: "getStatus",
        detail: detailFromResult(result) ?? "GitHub CLI auth status lookup failed.",
      });
    }

    const login = extractLogin(output);
    return {
      authenticated: true,
      ...(login ? { login } : {}),
    } satisfies CopilotAuthStatus;
  });

  const initiateDeviceFlow: CopilotAuthManagerShape["initiateDeviceFlow"] =
    unsupportedAuthOperation(
      "initiateDeviceFlow",
      "T3 Code does not initiate GitHub OAuth for Copilot. Authenticate the CLI first with `gh auth login` or the Copilot CLI itself.",
    );

  const pollForAccessToken: CopilotAuthManagerShape["pollForAccessToken"] = () =>
    unsupportedAuthOperation(
      "pollForAccessToken",
      "T3 Code does not poll GitHub OAuth device flow for Copilot. Authenticate the CLI before starting a session.",
    );

  const signOut: CopilotAuthManagerShape["signOut"] = unsupportedAuthOperation(
    "signOut",
    "T3 Code does not sign out GitHub Copilot. Manage authentication through `gh auth logout` or the Copilot CLI.",
  );

  const getCopilotToken: CopilotAuthManagerShape["getCopilotToken"] = Effect.gen(function* () {
    const cached = yield* Ref.get(copilotTokenCacheRef);
    if (Option.isSome(cached) && Date.now() < cached.value.expiresAt - COPILOT_TOKEN_REFRESH_SKEW_MS) {
      return cached.value.token;
    }

    const accessToken = yield* getAccessToken;
    if (!accessToken) {
      return yield* unsupportedAuthOperation(
        "getCopilotToken",
        "GitHub CLI is not authenticated. Authenticate the CLI before using the Copilot provider.",
      );
    }

    const result = yield* fetchJson({
      operation: "getCopilotToken",
      url: "https://api.github.com/copilot_internal/v2/token",
      init: {
        headers: {
          Accept: "application/json",
          Authorization: `token ${accessToken}`,
          "Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN_VERSION,
          "Editor-Version": COPILOT_EDITOR_VERSION,
          "Openai-Organization": "github-copilot",
          "User-Agent": "t3code",
          "X-GitHub-Api-Version": COPILOT_API_VERSION,
        },
      },
    });

    if (!result.response.ok || !result.json) {
      return yield* new CopilotAuthError({
        operation: "getCopilotToken",
        detail: `Failed to exchange a Copilot API token: ${errorDetailFromResponse(result)}`,
      });
    }

    const payload = result.json;
    const token = asString(payload.token)?.trim();
    if (!token) {
      return yield* new CopilotAuthError({
        operation: "getCopilotToken",
        detail: "Copilot token response did not include a token.",
      });
    }

    const expiresAt =
      parseExpiresAt(payload.expires_at) ?? Date.now() + COPILOT_TOKEN_FALLBACK_TTL_MS;
    yield* Ref.set(copilotTokenCacheRef, Option.some({ token, expiresAt }));
    return token;
  });

  return {
    initiateDeviceFlow,
    pollForAccessToken,
    getAccessToken,
    getStatus,
    signOut,
    getCopilotToken,
  } satisfies CopilotAuthManagerShape;
});

export const CopilotAuthManagerLive = Layer.effect(CopilotAuthManager, makeCopilotAuthManager);

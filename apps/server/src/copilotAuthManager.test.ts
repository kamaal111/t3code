import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, expect, vi } from "vitest";

import { CopilotAuthManager, CopilotAuthManagerLive } from "./copilotAuthManager.ts";

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

const managerLayer = (spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  CopilotAuthManagerLive.pipe(Layer.provideMerge(spawner));

describe("CopilotAuthManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.effect("getStatus returns unauthenticated when gh auth status reports no login", () =>
    Effect.gen(function* () {
      const manager = yield* CopilotAuthManager;
      const status = yield* manager.getStatus;
      assert.deepEqual(status, { authenticated: false });
    }).pipe(
      Effect.provide(
        managerLayer(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "auth status") {
              return {
                stdout: "",
                stderr: "You are not logged into any GitHub hosts. Run gh auth login.\n",
                code: 1,
              };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    ),
  );

  it.effect("getStatus returns the active GitHub login from gh auth status", () =>
    Effect.gen(function* () {
      const manager = yield* CopilotAuthManager;
      const status = yield* manager.getStatus;
      assert.deepEqual(status, { authenticated: true, login: "octocat" });
    }).pipe(
      Effect.provide(
        managerLayer(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "auth status") {
              return {
                stdout:
                  "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n",
                stderr: "",
                code: 0,
              };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    ),
  );

  it.effect("getAccessToken returns the existing gh auth token", () =>
    Effect.gen(function* () {
      const manager = yield* CopilotAuthManager;
      const token = yield* manager.getAccessToken;
      assert.equal(token, "gho_existing");
    }).pipe(
      Effect.provide(
        managerLayer(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "auth token") {
              return { stdout: "gho_existing\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    ),
  );

  it.effect("initiateDeviceFlow fails because auth is owned by the external CLI", () =>
    Effect.gen(function* () {
      const manager = yield* CopilotAuthManager;
      const result = yield* manager.initiateDeviceFlow.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const error = result.failure;
      assert.equal(error._tag, "CopilotAuthError");
      assert.match(error.message, /does not initiate GitHub OAuth/i);
    }).pipe(Effect.provide(managerLayer(mockSpawnerLayer(() => ({ stdout: "", stderr: "", code: 0 }))))),
  );

  it.effect("pollForAccessToken fails because device flow is unsupported", () =>
    Effect.gen(function* () {
      const manager = yield* CopilotAuthManager;
      const result = yield* manager.pollForAccessToken("device-code", 0).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const error = result.failure;
      assert.equal(error._tag, "CopilotAuthError");
      assert.match(error.message, /does not poll GitHub OAuth device flow/i);
    }).pipe(Effect.provide(managerLayer(mockSpawnerLayer(() => ({ stdout: "", stderr: "", code: 0 }))))),
  );

  it.effect("signOut fails because auth is managed outside T3 Code", () =>
    Effect.gen(function* () {
      const manager = yield* CopilotAuthManager;
      const result = yield* manager.signOut.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const error = result.failure;
      assert.equal(error._tag, "CopilotAuthError");
      assert.match(error.message, /does not sign out GitHub Copilot/i);
    }).pipe(Effect.provide(managerLayer(mockSpawnerLayer(() => ({ stdout: "", stderr: "", code: 0 }))))),
  );

  it.effect("getCopilotToken exchanges the existing gh auth token and caches it", () =>
    Effect.gen(function* () {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            token: "copilot-token",
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      const manager = yield* CopilotAuthManager;
      const first = yield* manager.getCopilotToken;
      const second = yield* manager.getCopilotToken;

      assert.equal(first, "copilot-token");
      assert.equal(second, "copilot-token");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }).pipe(
      Effect.provide(
        managerLayer(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "auth token") {
              return { stdout: "gho_existing\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    ),
  );

  it.effect("getAccessToken errors when gh is missing from PATH", () =>
    Effect.gen(function* () {
      const manager = yield* CopilotAuthManager;
      const result = yield* manager.getAccessToken.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const error = result.failure;
      assert.equal(error._tag, "CopilotAuthError");
      assert.match(error.message, /GitHub CLI.*not installed/i);
    }).pipe(Effect.provide(managerLayer(failingSpawnerLayer("spawn gh ENOENT")))),
  );
});

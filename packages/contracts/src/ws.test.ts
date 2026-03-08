import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WebSocketRequest, WS_METHODS } from "./ws";

const decodeWebSocketRequest = Schema.decodeUnknownEffect(WebSocketRequest);

it.effect("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 1,
        toTurnCount: 2,
      },
    });
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
  }),
);

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeWebSocketRequest({
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts copilot auth websocket requests", () =>
  Effect.gen(function* () {
    const initiateDeviceFlow = yield* decodeWebSocketRequest({
      id: "req-copilot-initiate",
      body: {
        _tag: WS_METHODS.copilotAuthInitiateDeviceFlow,
      },
    });
    const getStatus = yield* decodeWebSocketRequest({
      id: "req-copilot-status",
      body: {
        _tag: WS_METHODS.copilotAuthGetStatus,
      },
    });
    const signOut = yield* decodeWebSocketRequest({
      id: "req-copilot-signout",
      body: {
        _tag: WS_METHODS.copilotAuthSignOut,
      },
    });

    assert.strictEqual(initiateDeviceFlow.body._tag, WS_METHODS.copilotAuthInitiateDeviceFlow);
    assert.strictEqual(getStatus.body._tag, WS_METHODS.copilotAuthGetStatus);
    assert.strictEqual(signOut.body._tag, WS_METHODS.copilotAuthSignOut);
  }),
);

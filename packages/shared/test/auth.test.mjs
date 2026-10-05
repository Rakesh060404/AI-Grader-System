import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authMiddleware,
  createAccessToken,
  createRefreshToken
} from "../dist/index.js";

function createReply() {
  return {
    statusCode: undefined,
    payload: undefined,
    code(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return payload;
    }
  };
}

test("JWT middleware rejects missing tokens and attaches the signed user", async () => {
  const missingRequest = { headers: {} };
  const missingReply = createReply();
  await authMiddleware(missingRequest, missingReply);
  assert.equal(missingReply.statusCode, 401);
  assert.deepEqual(missingReply.payload, { error: "Unauthorized" });

  const user = {
    userId: "123e4567-e89b-12d3-a456-426614174000",
    email: "auth-test@example.com"
  };
  const accessToken = await createAccessToken(user);
  const validRequest = { headers: { authorization: `Bearer ${accessToken}` } };
  const validReply = createReply();
  await authMiddleware(validRequest, validReply);
  assert.deepEqual(validRequest.user, user);
  assert.equal(validReply.statusCode, undefined);
});

test("JWT middleware rejects refresh tokens as access tokens", async () => {
  const user = {
    userId: "123e4567-e89b-12d3-a456-426614174000",
    email: "auth-test@example.com"
  };
  const refreshToken = await createRefreshToken(user);
  const request = { headers: { authorization: `Bearer ${refreshToken}` } };
  const reply = createReply();
  await authMiddleware(request, reply);
  assert.equal(reply.statusCode, 401);
  assert.equal(request.user, undefined);
});

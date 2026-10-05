import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export interface AuthenticatedUser {
  userId: string;
  email: string | undefined;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("Invalid JWT_SECRET: expected at least 32 characters");
}
const secret = new TextEncoder().encode(JWT_SECRET);

async function signToken(
  user: AuthenticatedUser,
  tokenUse: "access" | "refresh",
  expiresIn: `${number}${"s" | "m" | "h" | "d"}`
): Promise<string> {
  const payload: JWTPayload = {
    sub: user.userId,
    email: user.email,
    tokenUse
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

export async function createAccessToken(user: AuthenticatedUser): Promise<string> {
  return signToken(user, "access", "15m");
}

export async function createRefreshToken(user: AuthenticatedUser): Promise<string> {
  return signToken(user, "refresh", "7d");
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
  if (payload.tokenUse !== "access") {
    throw new Error("Invalid token use");
  }
  return payload;
}

export async function verifyRefreshToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
  if (payload.tokenUse !== "refresh") {
    throw new Error("Invalid token use");
  }
  return payload;
}

export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const header = request.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }

  const token = header.slice("Bearer ".length);

  try {
    const payload = await verifyAccessToken(token);
    const userId = typeof payload.sub === "string" ? payload.sub : null;

    if (!userId) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    request.user = {
      userId,
      email: typeof payload.email === "string" ? payload.email : undefined
    };
  } catch {
    reply.code(401).send({ error: "Unauthorized" });
  }
};

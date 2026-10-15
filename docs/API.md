# API

The gateway exposes authentication and proxies upload and results routes on
port `3000`. The upload and results services also listen directly on ports
`3001` and `3003` for local service-level testing. All protected routes require
`Authorization: Bearer <access-token>`; downstream services independently
verify the same token.

## Authentication

### `POST /auth/register`

Request:

```json
{
  "email": "student@example.com",
  "password": "at-least-eight-characters"
}
```

Returns the new user and access and refresh tokens. Duplicate email addresses
return `409`.

### `POST /auth/login`

Accepts the same body as registration. Invalid credentials return `401`.

### `POST /auth/refresh`

Request:

```json
{
  "refreshToken": "<refresh-token>"
}
```

Returns a new access and refresh token pair. Invalid or expired refresh tokens
return `401`.

### `GET /auth/me`

Requires an access token. Returns the authenticated user.

## Uploads

### `POST /uploads/presign`

Requires an access token.

Request:

```json
{
  "contentType": "application/pdf"
}
```

Returns an opaque object key, upload-intent ID, a presigned MinIO PUT URL that
expires after 15 minutes, the required `Content-Type` header, and the 10 MiB
maximum accepted file size. Upload the PDF bytes directly to the returned URL
using `PUT` and the returned headers; do not send the bearer token to MinIO.
The URL's host must be reachable by the client. When running services in
Docker, configure `S3_ENDPOINT` for service-to-service access and
`S3_PRESIGN_ENDPOINT` for the client-facing MinIO address.

The service checks actual object size during completion. A presigned S3 PUT
does not impose a content-length range, so an oversized object may be transferred
before completion rejects it.

### `POST /uploads/{uploadIntentId}/complete`

Requires an access token. The intent must belong to the caller, be unexpired,
and not have been completed already. The service verifies that the object exists,
is non-empty and no larger than the intent's maximum, has the
`application/pdf` content type, and starts with the `%PDF-` signature.
It then creates the submission and its `submission.completed` outbox event in
one PostgreSQL transaction and marks the intent complete.

Success:

```json
{
  "uploadIntentId": "uuid",
  "submissionId": "uuid",
  "status": "pending"
}
```

Responses include `400` for missing or invalid PDF objects, `404` for an
unknown or another user's intent, `409` for an already completed intent, and
`410` for an expired intent.

## Results

### `GET /results`

Requires an access token. Returns the authenticated user's submissions, newest
first, with status, optional score and feedback, and failure reason when grading
has failed.

### `GET /results/{submissionId}`

Requires an access token. Returns the requested result only if the submission
belongs to the caller. Missing and other-user submissions both return `404`.

## Gateway routing

The gateway proxies `/uploads/*` and `/results` (including result detail paths)
to the configured internal service URLs. It authenticates the incoming request,
forwards the bearer token, and the downstream service verifies it again.

## Health

`GET /health` is available on both the gateway and upload service and returns
`{"status":"ok"}`.

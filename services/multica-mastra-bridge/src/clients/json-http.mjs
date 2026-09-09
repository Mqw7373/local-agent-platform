export class HttpError extends Error {
  constructor(message, { status, method, url, body }) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.method = method;
    this.url = url;
    this.body = body;
  }
}

export async function requestJson(baseUrl, requestPath, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15_000,
} = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${requestPath}`;
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new HttpError(`${method} ${url} returned ${response.status}`, {
      status: response.status,
      method,
      url,
      body: payload,
    });
  }
  return payload;
}

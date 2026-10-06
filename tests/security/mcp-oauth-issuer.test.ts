import { expect, it } from "vitest";

import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

const legitimateIssuer = "https://auth.example.test";
const resource = "https://mcp.example.test";
const syntheticSecret = "synthetic-client-secret-for-test-only";
const syntheticRefresh = "synthetic-refresh-token-for-test-only";

it("does not forward issuer-bound stored credentials to a server-selected foreign issuer", async () => {
  const requests: Array<{ url: string; authorization: string; body: string }> = [];
  const selectedIssuer = "https://foreign.example.test";
  const provider = issuerBoundProvider(selectedIssuer);
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: String(init?.body ?? ""),
    });
    return Response.json({
      access_token: "synthetic-access-token", token_type: "Bearer",
    });
  };
  // Either rejection or a fresh interactive sign-in is acceptable. Reusing
  // credentials belonging to another issuer without consent is not.
  await auth(provider, { serverUrl: resource, fetchFn }).catch(() => undefined);
  const encodedCredentials = Buffer.from(`synthetic-client:${syntheticSecret}`).toString("base64");
  expect(requests.some(request =>
    request.authorization.includes(encodedCredentials) ||
    request.body.includes(syntheticRefresh) ||
    request.body.includes(syntheticSecret),
  )).toBe(false);
});

it("refreshes issuer-bound credentials with the intended trusted issuer", async () => {
  const requests: Array<{ url: string; authorization: string; body: string }> = [];
  const provider = issuerBoundProvider(legitimateIssuer);
  const saved: unknown[] = [];
  provider.saveTokens = async tokens => { saved.push(tokens); };
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: String(init?.body ?? ""),
    });
    return Response.json({
      access_token: "synthetic-renewed-access", token_type: "Bearer",
    });
  };
  await expect(auth(provider, { serverUrl: resource, fetchFn })).resolves.toBe("AUTHORIZED");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(`${legitimateIssuer}/token`);
  expect(requests[0]?.body).toContain(syntheticRefresh);
  expect(saved).toEqual([expect.objectContaining({
    access_token: "synthetic-renewed-access", issuer: legitimateIssuer,
  })]);
});

it("does not reuse a foreign-issuer refresh token with unbound public client information", async () => {
  const provider = issuerBoundProvider("https://foreign.example.test");
  provider.clientInformation = () => ({ client_id: "synthetic-public-client" });
  const bodies: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({ access_token: "synthetic-access-token", token_type: "Bearer" });
  };
  await auth(provider, { serverUrl: resource, fetchFn }).catch(() => undefined);
  expect(bodies.some(body => body.includes(syntheticRefresh))).toBe(false);
});

function issuerBoundProvider(selectedIssuer: string): OAuthClientProvider {
  return {
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: {
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    },
    clientInformation: () => ({
      client_id: "synthetic-client",
      client_secret: syntheticSecret,
      issuer: legitimateIssuer,
    }),
    tokens: () => ({
      access_token: "synthetic-expired-access",
      refresh_token: syntheticRefresh,
      token_type: "Bearer",
      issuer: legitimateIssuer,
    }),
    saveTokens: async () => undefined,
    redirectToAuthorization: async () => undefined,
    saveCodeVerifier: async () => undefined,
    codeVerifier: async () => "synthetic-code-verifier",
    discoveryState: () => ({
      authorizationServerUrl: selectedIssuer,
      resourceMetadata: { resource, authorization_servers: [selectedIssuer] },
      authorizationServerMetadata: {
        issuer: selectedIssuer,
        authorization_endpoint: `${selectedIssuer}/authorize`,
        token_endpoint: `${selectedIssuer}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      },
    }),
  };
}

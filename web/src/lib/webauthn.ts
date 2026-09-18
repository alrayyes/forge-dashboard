// Browser-side WebAuthn plumbing: base64url <-> ArrayBuffer conversions
// between the server's JSON and the browser's binary
// PublicKeyCredential/AuthenticatorResponse types. Ported from
// login.js — the only page that needs it once login.html migrates,
// since Settings' own passkey management (#355) hasn't landed on this
// branch yet.

function base64urlToBuffer(base64url: string): ArrayBuffer {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padding =
    padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + padding);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---- server JSON -> browser-ready options ----

export function prepareCreationOptions(options: {
  publicKey: PublicKeyCredentialCreationOptionsJSON;
}): PublicKeyCredentialCreationOptions {
  const publicKey =
    options.publicKey as unknown as PublicKeyCredentialCreationOptions;
  publicKey.challenge = base64urlToBuffer(
    options.publicKey.challenge as unknown as string,
  );
  (publicKey.user as PublicKeyCredentialUserEntity).id = base64urlToBuffer(
    options.publicKey.user.id as unknown as string,
  );
  if (options.publicKey.excludeCredentials) {
    publicKey.excludeCredentials = options.publicKey.excludeCredentials.map(
      (c) => ({
        ...c,
        id: base64urlToBuffer(c.id as unknown as string),
      }),
    );
  }
  return publicKey;
}

export function prepareRequestOptions(options: {
  publicKey: PublicKeyCredentialRequestOptionsJSON;
}): PublicKeyCredentialRequestOptions {
  const publicKey =
    options.publicKey as unknown as PublicKeyCredentialRequestOptions;
  publicKey.challenge = base64urlToBuffer(
    options.publicKey.challenge as unknown as string,
  );
  if (options.publicKey.allowCredentials) {
    publicKey.allowCredentials = options.publicKey.allowCredentials.map(
      (c) => ({
        ...c,
        id: base64urlToBuffer(c.id as unknown as string),
      }),
    );
  }
  return publicKey;
}

// ---- browser credential -> server JSON ----

export function creationCredentialToJSON(cred: PublicKeyCredential) {
  const response = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
    },
    clientExtensionResults: cred.getClientExtensionResults
      ? cred.getClientExtensionResults()
      : {},
  };
}

export function assertionCredentialToJSON(cred: PublicKeyCredential) {
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      authenticatorData: bufferToBase64url(response.authenticatorData),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle
        ? bufferToBase64url(response.userHandle)
        : null,
    },
    clientExtensionResults: cred.getClientExtensionResults
      ? cred.getClientExtensionResults()
      : {},
  };
}

// Loose shapes for what the server actually sends — not the DOM lib's own
// *Options types, whose challenge/id fields are ArrayBuffers we haven't
// decoded yet at this point.
type PublicKeyCredentialCreationOptionsJSON = Omit<
  PublicKeyCredentialCreationOptions,
  'challenge' | 'user' | 'excludeCredentials'
> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string };
  excludeCredentials?: (Omit<PublicKeyCredentialDescriptor, 'id'> & {
    id: string;
  })[];
};

type PublicKeyCredentialRequestOptionsJSON = Omit<
  PublicKeyCredentialRequestOptions,
  'challenge' | 'allowCredentials'
> & {
  challenge: string;
  allowCredentials?: (Omit<PublicKeyCredentialDescriptor, 'id'> & {
    id: string;
  })[];
};

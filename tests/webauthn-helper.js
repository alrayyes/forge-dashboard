// A virtual authenticator over the Chrome DevTools Protocol's WebAuthn
// domain — a real WebAuthn/CTAP2 implementation Chrome itself provides
// standing in for physical hardware, not a stub of forge-dashboard's own
// code. navigator.credentials.create()/get() in the page under test run
// completely unmodified; Chrome intercepts the platform authenticator
// prompt and answers it through the virtual device instead.
async function addVirtualAuthenticator(page) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { client, authenticatorId };
}

module.exports = { addVirtualAuthenticator };

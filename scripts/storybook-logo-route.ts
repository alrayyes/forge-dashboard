// RepoLogo only loads https URLs, so its stories point at a host that does not
// exist. The browser is handed one mark for the one path "With a logo" asks
// for. Any other path on the host (the "Logo fails to load" story) is aborted,
// so that story really fails and RepoLogo drops the image.
export const LOGO_HOST = 'logos.example.test';
export const LOGO_PATH = '/forge-dashboard.svg';

export function logoAnswer(proxyRequest: string): 'logo' | 'abort' {
  const url = new URL(proxyRequest, 'http://localhost');
  let asked: URL;
  try {
    asked = new URL(url.searchParams.get('url') ?? '');
  } catch {
    return 'abort';
  }
  return asked.protocol === 'https:' &&
    asked.hostname === LOGO_HOST &&
    asked.pathname === LOGO_PATH
    ? 'logo'
    : 'abort';
}

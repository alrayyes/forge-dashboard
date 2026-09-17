// adapter-static needs every page prerendered ahead of time — there's no
// server to render one on request — so this is opt-in-by-default for every
// route under here rather than repeated per +page.ts as pages migrate.
export const prerender = true;

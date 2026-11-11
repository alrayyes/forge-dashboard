// Package imageproxy fetches an image on behalf of the browser, from the forge
// the image belongs to and from nowhere else (#3405).
//
// A pull request or issue can embed `![alt](url)`. The browser never loads
// that URL itself: it asks this server, which refuses any host outside the
// configured set, follows a redirect only inside that set, sends the forge
// token only to the host it belongs to, and returns bytes only when they are a
// raster image under a size cap. A private repository's attachment therefore
// works without the token ever reaching the browser, and a stranger's URL never
// sees the viewer's address.
package imageproxy

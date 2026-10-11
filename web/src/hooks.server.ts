// Only the build's prerender runs this (the Go binary serves the output), but
// the same rule holds: log the error, show a generic message (#1175).
export function handleError({ error }: { error: unknown }) {
  console.error(error);
  return { message: 'Something went wrong on our side' };
}

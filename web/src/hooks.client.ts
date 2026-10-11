// An unexpected error shows the visitor a generic message, never the thrown
// error's own text (#1175, rules/error-pages.md): that can carry a path, a
// query or a stack. The detail goes to the console for whoever has it open.
export function handleError({ error }: { error: unknown }) {
  console.error(error);
  return { message: 'Something went wrong on our side' };
}

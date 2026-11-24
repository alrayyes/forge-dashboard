// The result bar's count line (#4288): "42 pull requests" with no filter on,
// "12 of 42 pull requests" with one on. The number is set apart so CSS can
// weigh it as the result total (#3867), and the parts join into the sentence
// the polite live region says.
export type ResultBarParts = { lead: string; number: string; rest: string };

// "pull requests" -> "pull request": every noun a list page passes ends in s.
function singular(noun: string): string {
  return noun.endsWith('s') ? noun.slice(0, -1) : noun;
}

export function resultBarText(
  shown: number,
  total: number,
  noun: string,
  filtered: boolean,
): ResultBarParts {
  const name = total === 1 ? singular(noun) : noun;
  return filtered
    ? { lead: '', number: String(shown), rest: ` of ${total} ${name}` }
    : { lead: '', number: String(total), rest: ` ${name}` };
}

export function resultBarSentence(
  shown: number,
  total: number,
  noun: string,
  filtered: boolean,
): string {
  const { lead, number, rest } = resultBarText(shown, total, noun, filtered);
  return `${lead}${number}${rest}`;
}

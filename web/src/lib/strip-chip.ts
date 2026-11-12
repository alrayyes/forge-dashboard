// One count chip on a Rebase all strip (#3276): the count
// with its words, and a tint above zero. A zero count has no tone, so it draws
// neutral.
export type StripChip = { text: string; tone?: 'warn' | 'good' | 'bad' };

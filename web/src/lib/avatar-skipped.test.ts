import { describe, expect, it } from 'bun:test';
import { skippedAvatarHosts, skippedAvatarLead } from './avatar-skipped';

describe('skippedAvatarHosts', () => {
  it('reads the list the server sends', () => {
    expect(
      skippedAvatarHosts({ forgejoSkippedAvatarHosts: ['a.example'] }),
    ).toEqual(['a.example']);
  });

  it('means nothing is skipped when the server does not send it', () => {
    expect(skippedAvatarHosts({})).toEqual([]);
    expect(skippedAvatarHosts(null)).toEqual([]);
    expect(skippedAvatarHosts({ forgejoSkippedAvatarHosts: 'a' })).toEqual([]);
  });

  it('drops blanks, non-strings and repeats', () => {
    expect(
      skippedAvatarHosts({
        forgejoSkippedAvatarHosts: [' a.example ', '', 3, 'a.example', null],
      }),
    ).toEqual(['a.example']);
  });
});

describe('skippedAvatarLead', () => {
  it('says another host for one', () => {
    expect(skippedAvatarLead(['a.example'])).toBe(
      'Avatars from another host were skipped:',
    );
  });

  it('says other hosts for several', () => {
    expect(skippedAvatarLead(['a.example', 'b.example'])).toBe(
      'Avatars from other hosts were skipped:',
    );
  });
});

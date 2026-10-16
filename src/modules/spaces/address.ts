const MAX_LENGTH = 64;
const FALLBACK = 'space';
const CANDIDATES = 20;

const trimDashes = (value: string): string => value.replace(/^-+|-+$/g, '');

// A prefix keeps team mailboxes out of the names people, lists and role addresses use.
export const mailboxName = (spaceName: string, prefix: string): string => {
  const name = trimDashes(
    spaceName
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-'),
  );
  return prefix + (trimDashes(name.slice(0, MAX_LENGTH - prefix.length)) || FALLBACK);
};

export const candidateNames = (name: string): string[] =>
  Array.from({ length: CANDIDATES }, (_, i) => {
    if (i === 0) return name;
    const suffix = `-${i + 1}`;
    return trimDashes(name.slice(0, MAX_LENGTH - suffix.length)) + suffix;
  });

const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity']);
const ADULT_TEXT = [
  /(?:^|\W)nsfw(?:\W|$)/iu,
  /🔞/u,
  /(?:^|\W)18\+(?:\W|$)/u,
  /(?:^|\W)(?:adult\s+content|conte[uú]do\s+adulto)(?:\W|$)/iu,
  /(?:^|\W)(?:nudes?|nudez)(?:\W|$)/iu,
  /(?:^|\W)porn(?:o|ô|ografia|ographic)?(?:\W|$)/iu,
  /(?:onlyfans\.com|fansly\.com|privacy\.com\.br)/iu,
];

const BRAZIL_TEXT = [
  /🇧🇷/u,
  /(?:^|\W)(?:brasil|brazil|brasileir[ao]s?|brazilian)(?:\W|$)/iu,
  /(?:https?:\/\/)?(?:www\.)?[^\s/]+\.br(?:[\s/]|$)/iu,
];

const NON_BRAZIL_TEXT = [
  /(?:🇵🇹|🇦🇴|🇲🇿|🇨🇻|🇬🇼|🇸🇹|🇹🇱)/u,
  /(?:^|\W)(?:portugal|portugu[eê]s(?:a|es|as)?\s+de\s+portugal|lisboa|lisbon)(?:\W|$)/iu,
  /(?:^|\W)(?:angola|angolan[ao]s?|mo[çc]ambique|mo[çc]ambican[ao]s?|cabo\s+verde|cabo-verdian[ao]s?)(?:\W|$)/iu,
  /(?:^|\W)(?:guin[eé]-?bissau|s[aã]o\s+tom[eé](?:\s+e\s+pr[ií]ncipe)?|timor-?leste)(?:\W|$)/iu,
];

const activeAdultLabels = value => (value?.labels ?? [])
  .filter(label => !label.neg && ADULT_LABELS.has(label.val))
  .map(label => label.val);

const contains = (patterns, values) => values
  .filter(value => typeof value === 'string')
  .some(value => patterns.some(pattern => pattern.test(value)));

const postTextValues = post => [
  post?.record?.text,
  post?.record?.embed?.external?.uri,
  post?.record?.embed?.external?.title,
  post?.record?.embed?.external?.description,
  post?.embed?.external?.uri,
  post?.embed?.external?.title,
  post?.embed?.external?.description,
];

export const detectAdultContent = (profile, feed = []) => {
  const labels = new Set(activeAdultLabels(profile));
  let explicitText = contains(ADULT_TEXT, [
    profile?.handle,
    profile?.displayName,
    profile?.description,
  ]);
  for (const item of feed) {
    const post = item?.post;
    activeAdultLabels(post).forEach(label => labels.add(label));
    activeAdultLabels(post?.author).forEach(label => labels.add(label));
    if (contains(ADULT_TEXT, postTextValues(post))) explicitText = true;
  }
  return { adult: labels.size > 0 || explicitText, labels: [...labels], explicitText };
};

export const detectBrazilianProfile = (profile, feed = []) => {
  const profileValues = [profile?.handle, profile?.displayName, profile?.description];
  const languages = new Set(feed.flatMap(item => item?.post?.record?.langs ?? [])
    .filter(language => typeof language === 'string')
    .map(language => language.toLowerCase()));
  const brazilSignals = [];
  const nonBrazilSignals = [];

  if (contains(BRAZIL_TEXT, profileValues)) brazilSignals.push('profile_brazil');
  if (languages.has('pt-br')) brazilSignals.push('language_pt_br');
  if (contains(NON_BRAZIL_TEXT, profileValues)) nonBrazilSignals.push('profile_other_country');
  if (languages.has('pt-pt')) nonBrazilSignals.push('language_pt_pt');
  if (/\.pt$/iu.test(profile?.handle ?? '')) nonBrazilSignals.push('handle_pt');

  if (brazilSignals.length) return { status: 'brazilian', reasons: brazilSignals };
  if (nonBrazilSignals.length) return { status: 'non_brazilian', reasons: nonBrazilSignals };
  return { status: 'unknown', reasons: [] };
};

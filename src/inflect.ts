/// Port of ActiveSupport's default English inflections (activesupport/lib/active_support/inflections.rb, MIT) as data.
/// Rules are listed in Rails' definition order; later rules win, as in Rails.

type Rule = [RegExp, string];

const PLURALS: Rule[] = [
  [/$/, "s"],
  [/s$/i, "s"],
  [/^(ax|test)is$/i, "$1es"],
  [/(octop|vir)us$/i, "$1i"],
  [/(octop|vir)i$/i, "$1i"],
  [/(alias|status)$/i, "$1es"],
  [/(bu)s$/i, "$1ses"],
  [/(buffal|tomat)o$/i, "$1oes"],
  [/([ti])um$/i, "$1a"],
  [/([ti])a$/i, "$1a"],
  [/sis$/i, "ses"],
  [/(?:([^f])fe|([lr])f)$/i, "$1$2ves"],
  [/(hive)$/i, "$1s"],
  [/([^aeiouy]|qu)y$/i, "$1ies"],
  [/(x|ch|ss|sh)$/i, "$1es"],
  [/(matr|vert|ind)(?:ix|ex)$/i, "$1ices"],
  [/^(m|l)ouse$/i, "$1ice"],
  [/^(m|l)ice$/i, "$1ice"],
  [/^(ox)$/i, "$1en"],
  [/^(oxen)$/i, "$1"],
  [/(quiz)$/i, "$1zes"],
];

const SINGULARS: Rule[] = [
  [/s$/i, ""],
  [/(ss)$/i, "$1"],
  [/(n)ews$/i, "$1ews"],
  [/([ti])a$/i, "$1um"],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i, "$1sis"],
  [/(^analy)(sis|ses)$/i, "$1sis"],
  [/([^f])ves$/i, "$1fe"],
  [/(hive)s$/i, "$1"],
  [/(tive)s$/i, "$1"],
  [/([lr])ves$/i, "$1f"],
  [/([^aeiouy]|qu)ies$/i, "$1y"],
  [/(s)eries$/i, "$1eries"],
  [/(m)ovies$/i, "$1ovie"],
  [/(x|ch|ss|sh)es$/i, "$1"],
  [/^(m|l)ice$/i, "$1ouse"],
  [/(bus)(es)?$/i, "$1"],
  [/(o)es$/i, "$1"],
  [/(shoe)s$/i, "$1"],
  [/(cris|test)(is|es)$/i, "$1is"],
  [/^(a)x[ie]s$/i, "$1xis"],
  [/(octop|vir)(us|i)$/i, "$1us"],
  [/(alias|status)(es)?$/i, "$1"],
  [/^(ox)en/i, "$1"],
  [/(vert|ind)ices$/i, "$1ex"],
  [/(matr)ices$/i, "$1ix"],
  [/(quiz)zes$/i, "$1"],
  [/(database)s$/i, "$1"],
];

const IRREGULARS: [string, string][] = [
  ["person", "people"],
  ["man", "men"],
  ["child", "children"],
  ["sex", "sexes"],
  ["move", "moves"],
  ["zombie", "zombies"],
];

const UNCOUNTABLES = ["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "jeans", "police"];

/// Rails' `irregular`: rules that keep the first letter's case and also match the word as a suffix.
function irregularRules(): { plural: Rule[]; singular: Rule[] } {
  const plural: Rule[] = [];
  const singular: Rule[] = [];
  for (const [s, p] of IRREGULARS) {
    const [s0, srest, p0, prest] = [s[0], s.slice(1), p[0], p.slice(1)];
    plural.push([new RegExp(`(${s0})${srest}$`, "i"), `$1${prest}`], [new RegExp(`(${p0})${prest}$`, "i"), `$1${prest}`]);
    singular.push([new RegExp(`(${s0})${srest}$`, "i"), `$1${srest}`], [new RegExp(`(${p0})${prest}$`, "i"), `$1${srest}`]);
  }
  return { plural, singular };
}

const irregular = irregularRules();
const pluralRules = [...PLURALS, ...irregular.plural].reverse();
const singularRules = [...SINGULARS, ...irregular.singular].reverse();

const UNCOUNTABLE_RE = UNCOUNTABLES.map((w) => new RegExp(`\\b${w}$`, "i"));
const uncountable = (word: string) => UNCOUNTABLE_RE.some((re) => re.test(word));

function apply(word: string, rules: Rule[]): string {
  if (!word || uncountable(word)) return word;
  for (const [re, rep] of rules) if (re.test(word)) return word.replace(re, (...m) => rep.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? ""));
  return word;
}

export const pluralize = (word: string) => apply(word, pluralRules);
export const singularize = (word: string) => apply(word, singularRules);

/// "Admin::BlogPost" → "admin/blog_post", like ActiveSupport's `underscore`.
export function underscore(name: string): string {
  return name
    .replace(/::/g, "/")
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

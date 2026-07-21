export interface NightscoutLanguageDescriptor {
  code: string;
  file: string;
  language: string;
  speechCode: string;
}

export type NightscoutLocalization = Readonly<Record<string, string>>;

export interface NightscoutLanguage {
  [key: string]: unknown;
  (): NightscoutLanguage;
  speechCode: string;
  lang: string;
  languages: readonly NightscoutLanguageDescriptor[];
  translations: NightscoutLocalization;
  offerTranslations: (localization: NightscoutLocalization) => void;
  translateCS: (text: string) => string;
  translateCI: (text: string) => string;
  translate: (text: string, ...options: unknown[]) => string;
  getFilename: (code: string) => string;
  loadLocalization: (assets: Fetcher, origin?: string) => Promise<NightscoutLanguage>;
  set: (language: string | null | undefined) => NightscoutLanguage | undefined;
  get: (language: string) => NightscoutLanguageDescriptor | undefined;
}

export const NIGHTSCOUT_LANGUAGES: readonly NightscoutLanguageDescriptor[] = [
  { code: "ar", file: "ar_SA", language: "اللغة العربية", speechCode: "ar-SA" },
  { code: "bg", file: "bg_BG", language: "Български", speechCode: "bg-BG" },
  { code: "cs", file: "cs_CZ", language: "Čeština", speechCode: "cs-CZ" },
  { code: "de", file: "de_DE", language: "Deutsch", speechCode: "de-DE" },
  { code: "dk", file: "da_DK", language: "Dansk", speechCode: "dk-DK" },
  { code: "el", file: "el_GR", language: "Ελληνικά", speechCode: "el-GR" },
  { code: "en", file: "en_US", language: "English", speechCode: "en-US" },
  { code: "es", file: "es_ES", language: "Español", speechCode: "es-ES" },
  { code: "fi", file: "fi_FI", language: "Suomi", speechCode: "fi-FI" },
  { code: "fr", file: "fr_FR", language: "Français", speechCode: "fr-FR" },
  { code: "he", file: "he_IL", language: "עברית", speechCode: "he-IL" },
  { code: "hr", file: "hr_HR", language: "Hrvatski", speechCode: "hr-HR" },
  { code: "hu", file: "hu_HU", language: "Magyar", speechCode: "hu-HU" },
  { code: "it", file: "it_IT", language: "Italiano", speechCode: "it-IT" },
  { code: "ja", file: "ja_JP", language: "日本語", speechCode: "ja-JP" },
  { code: "ko", file: "ko_KR", language: "한국어", speechCode: "ko-KR" },
  { code: "nb", file: "nb_NO", language: "Norsk (Bokmål)", speechCode: "no-NO" },
  { code: "nl", file: "nl_NL", language: "Nederlands", speechCode: "nl-NL" },
  { code: "pl", file: "pl_PL", language: "Polski", speechCode: "pl-PL" },
  { code: "pt", file: "pt_PT", language: "Português", speechCode: "pt-PT" },
  { code: "br", file: "pt_BR", language: "Português (Brasil)", speechCode: "pt-BR" },
  { code: "ro", file: "ro_RO", language: "Română", speechCode: "ro-RO" },
  { code: "ru", file: "ru_RU", language: "Русский", speechCode: "ru-RU" },
  { code: "sk", file: "sk_SK", language: "Slovenčina", speechCode: "sk-SK" },
  { code: "sl", file: "sl_SL", language: "Slovenščina", speechCode: "sl-SL" },
  { code: "sv", file: "sv_SE", language: "Svenska", speechCode: "sv-SE" },
  { code: "tr", file: "tr_TR", language: "Türkçe", speechCode: "tr-TR" },
  { code: "uk", file: "uk_UA", language: "українська", speechCode: "uk-UA" },
  { code: "zh_cn", file: "zh_CN", language: "中文（简体）", speechCode: "cmn-Hans-CN" },
  { code: "zh_tw", file: "zh_TW", language: "中文（繁體）", speechCode: "cmn-Hant-TW" },
];

function isLocalization(value: unknown): value is NightscoutLocalization {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((translation) => typeof translation === "string");
}

function optionRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Request-local Workers port of locked v15.0.7 lib/language.js. */
export function createNightscoutLanguage(): NightscoutLanguage {
  const language = (() => language) as NightscoutLanguage;
  let translations: NightscoutLocalization = {};

  language.speechCode = "en-US";
  language.lang = "en";
  language.languages = NIGHTSCOUT_LANGUAGES;
  language.translations = translations;

  language.offerTranslations = (localization): void => {
    translations = localization;
    language.translations = translations;
  };
  language.translateCS = (text): string => translations[text] || text;
  language.translateCI = (text): string => {
    const upper = text.toUpperCase();
    let translated = text;
    for (const [key, value] of Object.entries(translations)) {
      if (key.toUpperCase() === upper) translated = value;
    }
    return translated;
  };
  language.translate = (text, ...options): string => {
    const first = options[0];
    const record = optionRecord(first);
    const hasCI = record !== null && Object.prototype.hasOwnProperty.call(record, "ci");
    const hasParams = record !== null && Object.prototype.hasOwnProperty.call(record, "params");
    let translated = record?.ci
      ? language.translateCI(text)
      : language.translateCS(text);
    let parameters: unknown[] | null = hasParams && Array.isArray(record?.params)
      ? [...record.params]
      : null;

    if (first && !hasCI && !hasParams) parameters = [...options];
    if (first && (hasCI || hasParams) && options.length > 1) {
      parameters ??= [];
      parameters.push(...options.slice(1));
    }
    if (parameters !== null) {
      for (let index = 0; index < parameters.length; index += 1) {
        translated = translated.replaceAll(`%${index + 1}`, String(parameters[index]));
      }
    }
    return translated;
  };
  language.getFilename = (code): string => {
    if (code === "en") return "en/en.json";
    return language.languages.find((candidate) => candidate.code === code)?.file.concat(".json")
      ?? "en/en.json";
  };
  language.loadLocalization = async (
    assets,
    origin = "https://nscf.invalid",
  ): Promise<NightscoutLanguage> => {
    const url = new URL(`/translations/${language.getFilename(language.lang)}`, origin);
    const response = await assets.fetch(new Request(url));
    if (!response.ok) throw new Error(`Unable to load Nightscout localization ${response.status}`);
    const localization: unknown = await response.json();
    if (!isLocalization(localization)) throw new Error("Nightscout localization is not a string map");
    language.offerTranslations(localization);
    return language;
  };
  language.set = (next): NightscoutLanguage | undefined => {
    if (!next) return undefined;
    language.lang = next;
    const selected = language.languages.find((candidate) => candidate.code === next);
    if (selected !== undefined) language.speechCode = selected.speechCode;
    return language();
  };
  language.get = (code): NightscoutLanguageDescriptor | undefined =>
    language.languages.find((candidate) => candidate.code === code);
  return language();
}

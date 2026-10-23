import en from './i18n/en.json';
import de from './i18n/de.json';

// prefix: true -> VIS-2 prefixes every key with "<adapter name>_" (liebherr-home_), see getI18nPrefix()
const translations = {
    en,
    de,
    prefix: true,
};

export default translations;

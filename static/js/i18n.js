
/*
 * The i18n ENGINE. The strings live in static/js/i18n/<lang>.js, one file per
 * language, and a page loads English (the fallback every key falls back to)
 * plus the reader's own language -- not all six.
 *
 * WHY: the single
 * table was 206 KB that every visitor downloaded and parsed to use one locale.
 * Measured on the live page, the whole app was 2.564 KB of script and style;
 * this is the largest piece that was pure waste.
 *
 * WHICH FILE THE PAGE LOADS is decided server-side from the `lang` cookie
 * (set by setLanguage below), so a Vietnamese reader never sees an English
 * flash. A language chosen later is fetched on demand, and the page re-renders
 * when it lands.
 */
const translations = window.__i18n = window.__i18n || {};

// Where a language file lives. The pin rides along so a language fetched at
// runtime obeys the same cache contract as the tags in the template.
const I18N_VERSION = (document.querySelector('script[data-i18n-version]')
    || {}).dataset?.i18nVersion || '1';
const LANG_URL = (lang) => {
    const base = (document.querySelector('meta[name="app-root"]')?.content || '')
        .replace(/\/$/, '');
    return `${base}/static/js/i18n/${lang}.js?v=${I18N_VERSION}`;
};

const loadLanguage = (lang) => new Promise((resolve, reject) => {
    if (translations[lang]) { resolve(true); return; }
    const script = document.createElement('script');
    script.src = LANG_URL(lang);
    script.onload = () => resolve(!!translations[lang]);
    script.onerror = () => reject(new Error(`cannot load the ${lang} strings`));
    document.head.appendChild(script);
});


const i18n = {
    // The cookie is what the SERVER read when it chose the <script> tags, so it
    // is the authority here; localStorage is the older per-browser copy and is
    // kept in step by setLanguage.
    currentLang: (document.cookie.match(/(?:^|;\s*)lang=([a-z]{2})/) || [])[1]
        || localStorage.getItem('language') || 'en',

    t(key) {
        // A language still loading falls through to English rather than
        // painting raw keys at the reader.
        const own = translations[this.currentLang];
        return (own && own[key]) || (translations.en && translations.en[key]) || key;
    },

    /*
     * Switch language. The strings are fetched when this is the first time the
     * reader picks it; the cookie is what lets the NEXT page load emit the
     * right <script> tag and skip both the fetch and a flash of English.
     */
    setLanguage(lang) {
        if (!this.getLanguages().some(entry => entry.code === lang)) {
            return false;
        }
        this.currentLang = lang;
        try { localStorage.setItem('language', lang); } catch (e) { /* private mode */ }
        document.cookie = `lang=${lang}; path=/; max-age=31536000; SameSite=Lax`;
        const apply = () => {
            this.updatePageText();
            window.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang } }));
        };
        if (translations[lang]) {
            apply();
        } else {
            // A language the page did not carry: fetch it, then repaint. The
            // English fallback keeps the UI readable while it is in flight.
            loadLanguage(lang).then(apply).catch(() => apply());
        }
        return true;
    },

    getLanguage() {
        return this.currentLang;
    },

    getLanguages() {
        return [
            { code: 'en', name: 'English', flag: '🇬🇧' },
            { code: 'vi', name: 'Tiếng Việt', flag: '🇻🇳' },
            { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
            { code: 'fr', name: 'Français', flag: '🇫🇷' },
            { code: 'es', name: 'Español', flag: '🇪🇸' },
            { code: 'zh', name: '中文', flag: '🇨🇳' }
        ];
    },

    updatePageText() {
        document.documentElement.lang = this.currentLang;

        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const translation = this.t(key);

            if (element.tagName === 'INPUT' && element.type !== 'submit') {
                element.placeholder = translation;
            } else {
                element.textContent = translation;
            }
        });

        document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
            const key = element.getAttribute('data-i18n-placeholder');
            element.placeholder = this.t(key);
        });

        document.querySelectorAll('[data-i18n-title]').forEach(element => {
            const key = element.getAttribute('data-i18n-title');
            element.title = this.t(key);
        });

        document.querySelectorAll('[data-i18n-label]').forEach(element => {
            const key = element.getAttribute('data-i18n-label');
            element.label = this.t(key);
        });

        document.querySelectorAll('[data-i18n-aria-label]').forEach(element => {
            const key = element.getAttribute('data-i18n-aria-label');
            element.setAttribute('aria-label', this.t(key));
        });

        // Every shipped page already carries the SSHDeck title key; update it
        // unconditionally so locale changes cannot leave a stale title behind.
        document.title = this.t('app.title');
    }
};

window.i18n = i18n;

document.addEventListener('DOMContentLoaded', () => {
    i18n.updatePageText();
});

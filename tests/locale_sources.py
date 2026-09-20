"""One reader for the six locale files.

The strings lived in a single `static/js/i18n.js` until. Every page
loaded all six languages -- 206 KB to show one -- so they were split into
`static/js/i18n/<lang>.js` and the page now carries English plus the reader's
own language. Several contract tests used to slice that one file by locale
block; they read through here instead, so the next move costs one edit.
"""
from pathlib import Path

LOCALES = ('en', 'vi', 'de', 'fr', 'es', 'zh')
LOCALE_DIR = Path('static/js/i18n')


def locale_source(locale):
    """One language's file, verbatim."""
    return (LOCALE_DIR / f'{locale}.js').read_text(encoding='utf-8')


def locale_sources():
    """Every language's file, keyed by language, in display order."""
    return {locale: locale_source(locale) for locale in LOCALES}


def all_locale_text():
    """The six files joined, for counting an occurrence across all locales."""
    return '\n'.join(locale_source(locale) for locale in LOCALES)

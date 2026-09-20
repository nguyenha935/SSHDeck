/*
 * Language selector for the auth pages (login, register, change_password).
 *
 * This is the SAME behaviour the four auth templates each carried inline
 * before the v5 conversion, extracted once instead of duplicated per page.
 * No behaviour change: it reads i18n.getLanguages / getLanguage, calls
 * i18n.setLanguage(code) on pick, and closes on outside click.
 *
 * Why it moved out of the template: promotes the language control to a
 * real 44px menu button with aria-expanded and role=menu, and keeping four
 * copies of that in sync across four templates is how the pre-v5 pages drifted
 * (login and register had subtly different copies).
 *
 * Every option is a real <button> so it is keyboard reachable and satisfies the
 * 44px floor (amendment line 30) rather than being a <div> with a click handler.
 */
(function () {
    'use strict';

    function init() {
        const btn = document.getElementById('langBtn');
        const menu = document.getElementById('langDropdown');
        const nameEl = document.getElementById('currentLangName');
        if (!btn || !menu || !window.i18n) {
            return;
        }

        const setOpen = (open) => {
            menu.classList.toggle('show', open);
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        };

        const render = () => {
            const languages = i18n.getLanguages();
            const current = i18n.getLanguage();
            menu.innerHTML = '';

            languages.forEach(lang => {
                const option = document.createElement('button');
                option.type = 'button';
                option.className = 'a5-lang-option'
                    + (lang.code === current ? ' active' : '');
                option.setAttribute('role', 'menuitem');
                // Flags are text content, not markup: the language list is data,
                // and building it with innerHTML would make it an injection path.
                option.textContent = `${lang.flag} ${lang.name}`;
                option.addEventListener('click', () => {
                    i18n.setLanguage(lang.code);
                    if (nameEl) {
                        nameEl.textContent = lang.name;
                    }
                    setOpen(false);
                    btn.focus();
                });
                menu.appendChild(option);
            });

            const active = languages.find(l => l.code === current);
            if (active && nameEl) {
                nameEl.textContent = active.name;
            }
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(!menu.classList.contains('show'));
        });

        // Escape closes and returns focus, so the menu is not a keyboard trap.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && menu.classList.contains('show')) {
                setOpen(false);
                btn.focus();
            }
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.a5-lang-wrap')) {
                setOpen(false);
            }
        });

        render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

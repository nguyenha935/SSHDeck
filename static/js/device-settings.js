/*
 * SETTINGS THAT BELONG TO THIS DEVICE (owner, 2026-10-05).
 *
 * The terminal renderer and the diagnostics used to be switched on by a query
 * in the address (?renderer=webgl, ?perf=1, ?kbdebug=1): nothing on screen
 * said they existed or whether they were on, and two of them were silently
 * remembered. They are chosen in Settings now (settings-view.js), and this is
 * where every part of the page reads them.
 *
 * Per device, in localStorage: the renderer suits one machine's GPU, and a
 * diagnostic is for the device being diagnosed. The renderer is anyone's
 * choice; the diagnostics are an administrator's (the template emits
 * <meta name="sshdeck-admin"> for one, and the server refuses their reports
 * from anyone else). The keyboard log records what is typed, so it turns
 * itself off an hour after it is switched on.
 *
 * A change is announced as `sshdeck:device-setting` with the setting's name,
 * so whatever depends on it applies it at once, without a reload. Another tab
 * of this device changing it arrives the same way, through `storage`.
 */
(() => {
    const KEYS = {
        renderer: 'sshdeck.renderer',
        perf: 'sshdeck.perf',
        attachReport: 'sshdeck.attachReport',
        keyboardLog: 'sshdeck.keyboardLogUntil',
    };
    const KEYBOARD_LOG_MS = 60 * 60 * 1000;
    const admin = !!document.querySelector('meta[name="sshdeck-admin"]');

    function read(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function write(key, value) {
        try {
            if (value === null) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, value);
            }
        } catch (e) {
            // Storage blocked: the choice holds for this page only.
        }
    }

    const values = {};
    function load() {
        values.renderer = read(KEYS.renderer) === 'webgl' ? 'webgl' : 'dom';
        values.perf = read(KEYS.perf) === '1';
        values.attachReport = read(KEYS.attachReport) === '1';
        values.keyboardLog = Number(read(KEYS.keyboardLog)) || 0;
    }
    load();

    function announce(name) {
        document.dispatchEvent(new CustomEvent('sshdeck:device-setting', { detail: { name } }));
    }

    // The keyboard log switches itself off at its deadline, here and in the
    // UI, whether or not anything is typed.
    let keyboardLogTimer = null;
    function armKeyboardLog() {
        clearTimeout(keyboardLogTimer);
        const left = values.keyboardLog - Date.now();
        if (values.keyboardLog && left > 0) {
            keyboardLogTimer = setTimeout(() => {
                values.keyboardLog = 0;
                write(KEYS.keyboardLog, null);
                announce('keyboardLog');
            }, left);
        }
    }
    armKeyboardLog();

    window.addEventListener('storage', (event) => {
        const name = Object.keys(KEYS).find(k => KEYS[k] === event.key);
        if (name) {
            load();
            armKeyboardLog();
            announce(name);
        }
    });

    window.DeviceSettings = {
        KEYBOARD_LOG_MS,
        isAdmin: () => admin,
        renderer: () => values.renderer,
        setRenderer(value) {
            values.renderer = value === 'webgl' ? 'webgl' : 'dom';
            write(KEYS.renderer, values.renderer === 'webgl' ? 'webgl' : null);
            announce('renderer');
        },
        perf: () => admin && values.perf,
        setPerf(on) {
            values.perf = !!on;
            write(KEYS.perf, on ? '1' : null);
            announce('perf');
        },
        attachReport: () => admin && values.attachReport,
        setAttachReport(on) {
            values.attachReport = !!on;
            write(KEYS.attachReport, on ? '1' : null);
            announce('attachReport');
        },
        // When the keyboard log turns itself off (ms), or 0 when it is off.
        keyboardLogUntil: () => (admin && values.keyboardLog > Date.now() ? values.keyboardLog : 0),
        keyboardLog() {
            return this.keyboardLogUntil() > 0;
        },
        setKeyboardLog(on) {
            values.keyboardLog = on ? Date.now() + KEYBOARD_LOG_MS : 0;
            write(KEYS.keyboardLog, on ? String(values.keyboardLog) : null);
            armKeyboardLog();
            announce('keyboardLog');
        },
    };
})();

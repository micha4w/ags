import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Service from './service.js';
import Variable from './variable.js';
import Widget from './widget.js';
import Utils from './utils.js';
import { timeout, readFileAsync } from './utils.js';
import { loadInterfaceXML } from './utils.js';

function deprecated(config: Config) {
    const warning = (from: string, to: string) => console.warn(
        `${from} config option has been removed: use ${to} instead`);

    if (config.notificationPopupTimeout !== undefined)
        warning('notificationPopupTimeout', 'Notifications.popupTimeout');

    if (config.notificationForceTimeout !== undefined)
        warning('notificationForceTimeout', 'Notifications.forceTimeout');

    if (config.cacheNotificationActions !== undefined)
        warning('cacheNotificationActions', 'Notifications.cacheActions');

    if (config.cacheCoverArt !== undefined)
        warning('cacheCoverArt', 'Mpris.cacheCoverArt');

    if (config.maxStreamVolume !== undefined)
        warning('cacheCoverArt', 'Audio.maxStreamVolume');
}

const AgsIFace = (bus: string) =>
    loadInterfaceXML('com.github.Aylur.ags')?.replace('@BUS@', bus);

export interface Config<W extends Gtk.Window = Gtk.Window> {
    windows?: W[]
    style?: string
    icons?: string
    onWindowToggled?: (windowName: string, visible: boolean) => void
    onConfigParsed?: (app: App) => void
    closeWindowDelay: { [key: string]: number }

    // FIXME: deprecated
    notificationPopupTimeout: number
    notificationForceTimeout: boolean
    cacheNotificationActions: boolean
    cacheCoverArt: boolean
    maxStreamVolume: number
}

export class App extends Gtk.Application {
    static {
        Service.register(this, {
            'window-toggled': ['string', 'boolean'],
            'config-parsed': [],
        });
    }

    private _dbus!: Gio.DBusExportedObject;
    private _closeDelay!: Config['closeWindowDelay'];
    private _cssProviders: Gtk.CssProvider[] = [];
    private _objectPath!: string;
    private _windows: Map<string, Gtk.Window> = new Map();
    private _configPath!: string;
    private _configDir!: string;

    get windows() { return [...this._windows.values()]; }
    get configPath() { return this._configPath; }
    get configDir() { return this._configDir; }

    resetCss() {
        const screen = Gdk.Screen.get_default();
        if (!screen) {
            console.error("couldn't get screen");
            return;
        }

        this._cssProviders.forEach(provider => {
            Gtk.StyleContext.remove_provider_for_screen(screen, provider);
        });

        this._cssProviders = [];
    }

    applyCss(path: string) {
        const screen = Gdk.Screen.get_default();
        if (!screen) {
            console.error("couldn't get screen");
            return;
        }

        const cssProvider = new Gtk.CssProvider();
        cssProvider.connect('parsing-error', (_, section, err) => {
            const file = section.get_file().get_path();
            const location = section.get_start_line();
            console.error(`CSS ERROR: ${err.message} at line ${location} in ${file}`);
        });

        try {
            cssProvider.load_from_path(path);
        } finally {
            // log on parsing-error
        }

        Gtk.StyleContext.add_provider_for_screen(
            screen,
            cssProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_USER,
        );

        this._cssProviders.push(cssProvider);
    }

    setup(bus: string, path: string, configDir: string, entry: string) {
        this.application_id = bus;
        this.flags = Gio.ApplicationFlags.DEFAULT_FLAGS;
        this._objectPath = path;

        this._configDir = configDir;
        this._configPath = entry;
    }

    vfunc_activate() {
        this.hold();

        Object.assign(globalThis, {
            Widget,
            Service,
            Variable,
            Utils,
            App: this,
        });

        this._register();
        this._load();
    }

    connect(signal = 'window-toggled', callback: (_: this, ...args: any[]) => void): number {
        return super.connect(signal, callback);
    }

    toggleWindow(name: string) {
        const w = this.getWindow(name);
        if (w)
            w.visible ? this.closeWindow(name) : this.openWindow(name);
        else
            return 'There is no window named ' + name;
    }

    openWindow(name: string) {
        this.getWindow(name)?.show();
    }

    closeWindow(name: string) {
        const w = this.getWindow(name);
        if (!w || !w.visible)
            return;

        const delay = this._closeDelay[name];
        if (delay && w.visible) {
            timeout(delay, () => w.hide());
            this.emit('window-toggled', name, false);
        }
        else {
            w.hide();
        }
    }

    getWindow(name: string) {
        const w = this._windows.get(name);
        if (!w)
            console.error(Error(`There is no window named ${name}`));

        return w;
    }

    removeWindow(w: Gtk.Window | string) {
        const name = typeof w === 'string' ? w : w.name || 'gtk-layer-shell';

        const win = this._windows.get(name);
        if (!win) {
            console.error(Error('There is no window named ' + name));
            return;
        }

        win.destroy();
        this._windows.delete(name);
    }

    addWindow(w: Gtk.Window) {
        if (!(w instanceof Gtk.Window)) {
            return console.error(Error(`${w} is not an instanceof Gtk.Window, ` +
                ` but it is of type ${typeof w}`));
        }

        if (!w.name)
            return console.error(Error(`${w} has no name`));

        w.connect('notify::visible',
            () => this.emit('window-toggled', w.name, w.visible));

        if (this._windows.has(w.name)) {
            console.error(Error('There is already a window named' + w.name));
            this.quit();
            return;
        }

        this._windows.set(w.name, w);
    }

    private async _load() {
        try {
            const entry = await import(`file://${this.configPath}`);
            const config = entry.default as Config;
            if (!config) {
                console.error('Missing default export');
                return this.emit('config-parsed');
            }

            // FIXME:
            deprecated(config);

            this._closeDelay = config?.closeWindowDelay || {};

            if (config.style) {
                this.applyCss(config.style.startsWith('.')
                    ? `${this.configDir}${config.style.slice(1)}`
                    : config.style);
            }

            if (config.icons) {
                Gtk.IconTheme.get_default().append_search_path(
                    config.icons.startsWith('.')
                        ? `${this.configDir}${config.icons.slice(1)}`
                        : config.icons);
            }
            if (typeof config.onWindowToggled === 'function')
                this.connect('window-toggled', (_, n, v) => config.onWindowToggled!(n, v));

            config.windows?.forEach(this.addWindow.bind(this));
            config.onConfigParsed?.(this);

            this.emit('config-parsed');
        } catch (err) {
            logError(err);

            const error = err as { name?: string, message: string };
            const msg = `Unable to load file from: file://${this._configPath}`;
            if (error?.name === 'ImportError' && error.message.includes(msg)) {
                print(`config file not found: "${this._configPath}"`);
                this.quit();
            }
        }
    }

    private _register() {
        Gio.bus_own_name(
            Gio.BusType.SESSION,
            this.application_id!,
            Gio.BusNameOwnerFlags.NONE,
            (connection: Gio.DBusConnection) => {
                this._dbus = Gio.DBusExportedObject
                    .wrapJSObject(AgsIFace(this.application_id!) as string, this);

                this._dbus.export(connection, this._objectPath);
            },
            null,
            null,
        );
    }

    toJSON() {
        return {
            bus: this.application_id,
            configDir: this.configDir,
            windows: Object.fromEntries(this.windows.entries()),
        };
    }

    RunJs(js: string, clientBusName?: string, clientObjPath?: string) {
        let fn;

        const dbus = (method: 'Return' | 'Print') => (out: unknown) => Gio.DBus.session.call(
            clientBusName!, clientObjPath!, clientBusName!, method,
            new GLib.Variant('(s)', [`${out}`]),
            null, Gio.DBusCallFlags.NONE, -1, null, null,
        );

        const response = dbus('Return');
        const print = dbus('Print');
        const client = clientBusName && clientObjPath;

        try {
            fn = Function(`return (async function(print) {
                ${js.includes(';') ? js : `return ${js}`}
            })`);
        } catch (error) {
            client ? response(error) : logError(error);
            return;
        }

        fn()(print)
            .then((out: unknown) => {
                client ? response(`${out}`) : print(`${out}`);
            })
            .catch((err: Error) => {
                client ? response(`${err}`) : logError(err);
            });
    }

    RunFile(file: string, bus?: string, path?: string) {
        readFileAsync(file)
            .then(content => {
                if (content.startsWith('#!'))
                    content = content.split('\n').slice(1).join('\n');

                this.RunJs(content, bus, path);
            })
            .catch(logError);
    }

    // FIXME: deprecated
    RunPromise(js: string, busName?: string, objPath?: string) {
        console.warn('--run-promise is DEPRECATED, ' +
            ' use --run-js instead, which now supports await syntax');

        const client = busName && objPath;
        const response = (out: unknown) => Gio.DBus.session.call(
            busName!, objPath!, busName!, 'Return',
            new GLib.Variant('(s)', [`${out}`]),
            null, Gio.DBusCallFlags.NONE, -1, null, null,
        );

        new Promise((res, rej) => Function('resolve', 'reject', js)(res, rej))
            .then(out => {
                client ? response(`${out}`) : print(`${out}`);
            })
            .catch(err => {
                client ? response(`${err}`) : console.error(`${err}`);
            });
    }

    ToggleWindow(name: string) {
        this.toggleWindow(name);
        return `${this.getWindow(name)?.visible}`;
    }

    Inspector() { Gtk.Window.set_interactive_debugging(true); }

    Quit() { this.quit(); }
}

export const app = new App;
export default app;

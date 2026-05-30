/**
 * idbScope.js — Per-app namespacing for matrix-js-sdk's IndexedDB.
 *
 * matrix-js-sdk hardcodes its crypto store name to
 * `matrix-js-sdk::matrix-sdk-crypto`. Any other matrix-js-sdk app at
 * the same origin (Element Web, Hydrogen, another deployment of this
 * app, etc.) collides with us on that single store. The collision
 * surfaces as "account in the store doesn't match" errors and forces
 * users to wipe one app's data to use another.
 *
 * This module intercepts indexedDB.open / deleteDatabase at import
 * time and rewrites any name starting with `matrix-js-sdk` to live
 * under our app's private prefix. Our own databases (outbox etc.)
 * are unaffected — different name prefix.
 *
 * Must be imported BEFORE matrix-js-sdk so the patch is in place
 * when the SDK opens its store. client.js does that.
 */

const PREFIX = 'eomx::';

function shouldScope(name) {
  return typeof name === 'string' && name.startsWith('matrix-js-sdk');
}

if (typeof IDBFactory !== 'undefined' && !IDBFactory.prototype.__eomxScoped) {
  const proto = IDBFactory.prototype;
  const origOpen = proto.open;
  const origDelete = proto.deleteDatabase;

  proto.open = function (name, ...args) {
    return origOpen.call(this, shouldScope(name) ? PREFIX + name : name, ...args);
  };
  proto.deleteDatabase = function (name, ...args) {
    return origDelete.call(this, shouldScope(name) ? PREFIX + name : name, ...args);
  };

  Object.defineProperty(proto, '__eomxScoped', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export const SCOPED_DB_PREFIX = PREFIX;

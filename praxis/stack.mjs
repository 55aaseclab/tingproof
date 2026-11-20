import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const isWithin = (parent, child) => { const path = relative(resolve(parent), resolve(child)); return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)); };
const bind = (source, target, read_only) => ({ type: 'bind', source, target, read_only, bind: { create_host_path: false } });
export function createStackIntegration() { return {
services: [{ name: 'tingproof', port: 5173 }, { name: 'tingproof-public', port: 15173 }],
resolveSources(ctx) { const path = ctx.registeredMode ? ctx.registered('tingproof', 'tingproof.db', 'sqlite') : join(ctx.appsRoot, 'tingproof/tingproof.db'); if (ctx.sourceMode === 'registered' && !path.endsWith('/tingproof.db')) throw new Error('The TingProof server requires its registered tingproof.db filename.'); return { sources: [{ key: 'tingproof', path, order: 2 }], data: [{ path: dirname(path), kind: 'directory', writable: true }, { path, kind: 'file', writable: true, nonempty: true }] }; },
environment: ({ settings }) => ({ PRAXIS_TINGPROOF_DATA_DIR: dirname(settings.sourceMap.tingproof) })
}; }

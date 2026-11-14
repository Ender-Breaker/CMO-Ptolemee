/* Firestore en mémoire pour les tests : seulement ce qu'utilise store.js.
   Les transactions sont exécutées l'une après l'autre (comme les verrous de Firestore
   côté serveur) et refusent une lecture après une écriture, comme la vraie base. */

'use strict';

function clone(v) {
    if (Buffer.isBuffer(v)) return Buffer.from(v);
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') {
        const o = {};
        Object.keys(v).forEach((k) => { if (v[k] !== undefined) o[k] = clone(v[k]); });
        return o;
    }
    return v;
}

class Snap {
    constructor(ref, data) {
        this.ref = ref;
        this.id = ref.id;
        this.exists = data !== undefined;
        this._data = data;
    }
    get(field) { return this._data ? this._data[field] : undefined; }
    data() { return this._data; }
}

class Ref {
    constructor(fs, path) {
        this.fs = fs;
        this.path = path;
        this.id = path.split('/').pop();
    }
    async get() { return new Snap(this, clone(this.fs.docs.get(this.path))); }
    async set(data) { this.fs.docs.set(this.path, clone(data)); }
    async create(data) {
        if (this.fs.docs.has(this.path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
        this.fs.docs.set(this.path, clone(data));
    }
}

class Query {
    constructor(fs, name, filters, max) {
        this.fs = fs;
        this.name = name;
        this.filters = filters || [];
        this.max = max || Infinity;
    }
    doc(id) { return new Ref(this.fs, this.name + '/' + id); }
    where(field, op, value) {
        if (op !== '<') throw new Error('Opérateur non simulé : ' + op);
        return new Query(this.fs, this.name, this.filters.concat([(d) => d[field] < value]), this.max);
    }
    limit(n) { return new Query(this.fs, this.name, this.filters, n); }
    async get() {
        const prefix = this.name + '/';
        const docs = [];
        for (const [path, data] of this.fs.docs) {
            if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
            if (this.filters.every((f) => f(data))) docs.push(new Snap(new Ref(this.fs, path), clone(data)));
            if (docs.length >= this.max) break;
        }
        return { docs, empty: !docs.length, size: docs.length };
    }
}

class FakeFirestore {
    constructor() {
        this.docs = new Map();
        this.queue = Promise.resolve();
        this.transactions = 0;
    }
    settings() {}
    doc(path) { return new Ref(this, path); }
    collection(name) { return new Query(this, name); }
    batch() {
        const ops = [];
        return {
            delete: (ref) => ops.push(() => this.docs.delete(ref.path)),
            commit: async () => ops.forEach((f) => f())
        };
    }
    async runTransaction(fn) {
        const prev = this.queue;
        let release;
        this.queue = new Promise((r) => { release = r; });
        await prev;
        this.transactions++;
        try {
            const writes = [];
            const t = {
                get: async (ref) => {
                    if (writes.length) throw new Error('Lecture après écriture dans une transaction.');
                    return ref.get();
                },
                set: (ref, data) => { writes.push(() => this.docs.set(ref.path, clone(data))); },
                delete: (ref) => { writes.push(() => this.docs.delete(ref.path)); }
            };
            const out = await fn(t);
            writes.forEach((w) => w());
            return out;
        } finally {
            release();
        }
    }
}

module.exports = FakeFirestore;

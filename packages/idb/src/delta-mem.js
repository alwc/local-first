// @flow
import { openDB } from 'idb';
import * as hlc from '../../hybrid-logical-clock/src';
import type { HLC } from '../../hybrid-logical-clock/src';
import type { Delta, CRDT as Data } from '../../nested-object-crdt/src';
import { type CursorType } from '../../core/src/types';
import deepEqual from 'fast-deep-equal';
import type {
    Persistence,
    FullPersistence,
    DeltaPersistence,
} from '../../core/src/types';

export const applyDeltas = function<Delta, Data>(
    db: FakeDb,
    collection: string,
    deltas: Array<{ node: string, delta: Delta, stamp: string }>,
    serverCursor: ?CursorType,
    apply: (?Data, Delta) => Data,
    storeDeltas: boolean,
) {
    console.log('Apply to collection', collection);
    const stores = storeDeltas
        ? [collection + ':meta', collection + ':nodes', collection + ':deltas']
        : [collection + ':meta', collection + ':nodes'];
    console.log('Opening for stores', stores);
    if (storeDeltas) {
        deltas.forEach(obj => db.put(collection + ':deltas', obj));
    }
    const idMap = {};
    deltas.forEach(d => (idMap[d.node] = true));
    const ids = Object.keys(idMap);
    const gotten = ids.map(id => db.get(collection + ':nodes', id));
    // console.log('loaded up', ids, gotten);
    const map = {};
    gotten.forEach(res => {
        if (res) {
            map[res.id] = res.value;
        }
    });
    deltas.forEach(({ node, delta }) => {
        map[node] = apply(map[node], delta);
    });
    // console.log('idb changeMany processed', ids, map, serverCursor);
    ids.forEach(id =>
        map[id] ? db.put(collection + ':nodes', { id, value: map[id] }) : null,
    );
    if (serverCursor) {
        db.put(collection + ':meta', serverCursor, 'cursor');
    }
    return map;
};

class FakeDb {
    collections: { [colid: string]: { [key: string]: any } };
    keyPaths: { [colid: string]: string };
    constructor() {
        this.collections = {};
        this.keyPaths = {};
        // colids.forEach(id => (this.collections[id] = {}));
    }
    createObjectStore(name: string, options?) {
        this.collections[name] = {};
        if (options && options.keyPath) {
            this.keyPaths[name] = options.keyPath;
        }
    }
    getAll<T>(colid: string): Array<T> {
        return Object.keys(this.collections[colid]).map(
            key => this.collections[colid][key],
        );
    }
    put<T>(colid: string, object: T, key?: string) {
        if (!key) {
            key = object[this.keyPaths[colid]];
        }
        this.collections[colid][key] = object;
    }
    get<T>(colid: string, key: string): ?T {
        return this.collections[colid][key];
    }
    deleteUpTo(colid: string, upTo: string) {
        const keys = Object.keys(this.collections[colid]).sort();
        for (let key of keys) {
            delete this.collections[colid][key];
            if (key === upTo) {
                break;
            }
        }
    }
}

const makePersistence = (
    name: string,
    collections: Array<string>,
): DeltaPersistence => {
    const db = new FakeDb();
    collections.forEach(name => {
        db.createObjectStore(name + ':deltas', {
            keyPath: 'stamp',
        });
        db.createObjectStore(name + ':nodes', { keyPath: 'id' });
        // stores "cursor", and that's it for the moment
        // In a multi-delta-persistence world, it would
        // store a cursor for each server.
        db.createObjectStore(name + ':meta');
    });

    return {
        collections,
        async deltas<Delta>(
            collection: string,
        ): Promise<Array<{ node: string, delta: Delta, stamp: string }>> {
            return db.getAll(collection + ':deltas');
        },
        async getServerCursor(collection: string): Promise<?number> {
            return db.get(collection + ':meta', 'cursor');
        },
        async deleteDeltas(collection: string, upTo: string) {
            // console.log('delete up to', upTo);
            db.deleteUpTo(collection, upTo);
        },
        async applyDelta<Delta, Data>(
            colid: string,
            id: string,
            delta: Delta,
            stamp: string,
            apply: (?Data, Delta) => Data,
        ): Promise<Data> {
            // console.log('Applying a single delta, local mutation');
            // console.log(new Error().stack);
            if (!collections.includes(colid)) {
                throw new Error('Unknown collection ' + colid);
            }
            const map = applyDeltas(
                db,
                colid,
                [{ node: id, delta, stamp }],
                null,
                apply,
                true,
            );
            return map[id];
        },

        async load<T>(collection: string, id: string): Promise<?T> {
            const data = db.get(collection + ':nodes', id);
            return data ? data.value : null;
        },
        async loadAll<T>(collection: string): Promise<{ [key: string]: T }> {
            const items = db.getAll(collection + ':nodes');
            const res = {};
            items.forEach(item => (res[item.id] = item.value));
            return res;
        },
        async applyDeltas<Delta, Data>(
            collection: string,
            deltas: Array<{ node: string, delta: Delta, stamp: string }>,
            serverCursor: ?CursorType,
            apply: (?Data, Delta) => Data,
        ) {
            // console.log('got deltas from the server I guess');
            if (!collections.includes(collection)) {
                throw new Error('Unknown collection ' + collection);
            }
            return applyDeltas(
                db,
                collection,
                deltas,
                serverCursor,
                apply,
                false,
            );
        },
    };
};

export default makePersistence;
